// AI-969: get-in prices by scraping ticket marketplaces, with no model in the value path.
//
// WHY SCRAPE. The price has come from a search model since AI-827, and a search model reads a
// page and REPORTS a number. lib/price.js documents what that costs: sonar-pro quoting $28 against
// a true $46 by reading an all-in price off a low-quality reseller, and a $1,189 "get-in" on a
// regular-season game. A marketplace page carries the listings themselves, so the number here is
// read, not reported — and when a page changes shape the parser returns nothing rather than
// something plausible and wrong.
//
// Measured on 28 real games (14 MLB, 14 NFL, 2026-09-15): Gametime listings on 28/28 and TickPick
// get-ins on 28/28, every page over plain HTTP, ~2.7s and ~1.2s a page. Nothing needed Crawl4AI
// or Firecrawl on that run — they are here for the days a site starts refusing plain requests.
//
// FETCH LADDER, cheapest first: plain HTTP -> Crawl4AI -> Firecrawl. A step only counts when the
// page yields the data being looked for. A 200 with no listings is a FAILURE, not a result: a
// blocked or half-rendered page very often comes back 200, and treating it as "no tickets" would
// silently hand the game to the model — or leave it unpriced — with no sign anything went wrong.
// Crawl4AI's proxied endpoint is deliberately not a step: it failed every URL tested, example.com
// included (ERR_TUNNEL_CONNECTION_FAILED), so it would only add latency before Firecrawl.
//
// PRICE BASIS. Two numbers per listing, because the marketplaces disagree about what a price is:
//   price   the listed per-ticket price before fees — the definition best_price has carried
//           since AI-845, so a scraped price and a model price mean the same thing on screen
//   all_in  what the buyer actually pays per ticket
// Candidates are RANKED by all_in. TickPick has no fees and Gametime adds roughly 15-20%, so a
// pre-fee comparison picks Gametime almost every time even where TickPick is cheaper to buy —
// measured: Gametime looks cheaper pre-fee, TickPick is cheaper all-in on 23 of 28 games.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// How many Gametime listings to offer an operator per game, cheapest first. One is the price;
// the others exist so a better seat a few dollars up is one click away instead of a site visit.
const GAMETIME_CANDIDATES = 3;

// Firecrawl is the only paid step, so a run is capped. Past the cap a page simply fails the
// ladder and the game falls through to the model like any other miss.
const FIRECRAWL_MAX_PER_RUN = Number(process.env.PRICE_SCRAPE_FIRECRAWL_MAX || 25);

const slug = s => String(s || '').toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const lastWord = s => slug(s).split('-').pop();
// Words that identify an opponent inside a marketplace slug. events_master stores the nickname
// lowercased ("red sox", "d-backs"); sites spell it out ("red-sox", "diamondbacks"), so the last
// word is matched as a substring. "d-backs" -> "backs" is found inside "diamondbacks".
const oppWords = s => [lastWord(s)].filter(w => w && w.length >= 3);
const round2 = n => Math.round(n * 100) / 100;

async function timed(p, ms) {
  let t;
  try { return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms); })]); }
  finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------------------------
// Fetch ladder
// ---------------------------------------------------------------------------------------------

async function viaPlain(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' } });
  // TickPick answers a team it has no page for with a redirect to its search results — a 200, not
  // a 404. Landing on a search page when a specific page was asked for is the same answer.
  const landed = new URL(r.url || url);
  const soft404 = r.redirected && /\/search\b/.test(landed.pathname) && !/\/search\b/.test(new URL(url).pathname);
  return { status: soft404 ? 404 : r.status, html: soft404 ? '' : await r.text() };
}

async function viaCrawl4ai(url) {
  const base = (process.env.CRAWL4AI_URL || '').trim().replace(/\/$/, '');
  const token = (process.env.CRAWL4AI_API_TOKEN || '').trim();
  if (!base) throw new Error('CRAWL4AI_URL not set');
  const r = await fetch(base + '/crawl', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ urls: [url], crawler_config: { type: 'CrawlerRunConfig', params: { cache_mode: 'bypass', page_timeout: 60000 } } }),
  });
  const j = await r.json().catch(() => ({}));
  const res = (j.results || [])[0] || {};
  return { status: res.status_code || r.status, html: res.html || '', note: res.error_message || '' };
}

async function viaFirecrawl(url) {
  // The key is stored with its scheme ("Bearer fc-…") and the header name alongside it.
  const key = (process.env.FIRECRAWL_AUTHORIZATION_KEY || '').trim();
  const header = (process.env.FIRECRAWL_HEADER_NAME || 'Authorization').trim();
  if (!key) throw new Error('FIRECRAWL_AUTHORIZATION_KEY not set');
  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [header]: key },
    body: JSON.stringify({ url, formats: ['rawHtml'], onlyMainContent: false, waitFor: 5000, timeout: 60000 }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: j?.data?.metadata?.statusCode || r.status, html: j?.data?.rawHtml || '', note: j.error || '' };
}

const LADDER = [
  { name: 'plain', fn: viaPlain, ms: 20000 },
  { name: 'crawl4ai', fn: viaCrawl4ai, ms: 75000 },
  { name: 'firecrawl', fn: viaFirecrawl, ms: 75000, paid: true },
];

// Walk the ladder until `extract(html)` returns something. `ctx` is shared across one run: it
// counts paid calls and remembers, per host, the first step that worked, so a site that refuses
// plain HTTP is not asked again on every game of the run.
export async function fetchLadder(url, extract, ctx) {
  const host = new URL(url).host;
  const start = ctx.startStep.get(host) || 0;
  const attempts = [];
  for (let i = start; i < LADDER.length; i++) {
    const step = LADDER[i];
    if (step.paid && ctx.firecrawlCalls >= FIRECRAWL_MAX_PER_RUN) { attempts.push({ via: step.name, ok: false, note: 'run cap reached' }); continue; }
    const t0 = Date.now();
    try {
      if (step.paid) ctx.firecrawlCalls++;
      const { status, html, note } = await timed(step.fn(url), step.ms);
      if ((status === 404 || status === 410) && !html) {
        attempts.push({ via: step.name, status, ok: false, ms: Date.now() - t0, note: 'not found' });
        return { ok: false, notFound: true, attempts };
      }
      const data = html ? extract(html) : null;
      attempts.push({ via: step.name, status, ok: !!data, ms: Date.now() - t0, note: note ? String(note).slice(0, 120) : undefined });
      if (data) {
        if (i > start) ctx.startStep.set(host, i);
        return { ok: true, via: step.name, data, attempts };
      }
      // A 404/410 is the site answering, not refusing: the page does not exist. Escalating would
      // only pay Firecrawl to be told the same thing — measured, 2 credits on two TickPick team
      // pages for WNBA/CFB teams that simply have none. Blocks come back 403/401/429, not 404.
      if (status === 404 || status === 410) return { ok: false, notFound: true, attempts };
    } catch (e) {
      attempts.push({ via: step.name, ok: false, ms: Date.now() - t0, note: String(e.message || e).slice(0, 120) });
    }
  }
  return { ok: false, attempts };
}

export function newScrapeContext() {
  return { startStep: new Map(), firecrawlCalls: 0, pages: new Map(), stats: { pages: 0, byVia: {} } };
}

// One fetch per page per run. Team pages are shared by every game that team plays, so a 20-game
// window touches each one once, not twenty times. The promise is cached, not the result, so two
// games of the same team resolving at once still produce a single request.
function cachedPage(ctx, key, url, extract) {
  if (!ctx.pages.has(key)) {
    ctx.pages.set(key, fetchLadder(url, extract, ctx).then(r => {
      ctx.stats.pages++;
      if (r.ok) ctx.stats.byVia[r.via] = (ctx.stats.byVia[r.via] || 0) + 1;
      return r;
    }));
  }
  return ctx.pages.get(key);
}

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------
//
// A source that produces no price is still shown to the operator, as an error row in the price
// editor: which site, and why — "403 Forbidden", "Game not listed on TickPick". Without it a list
// holding one price reads as "only one site has this game", when the other site may simply have
// refused us. Two kinds, because they call for different reactions:
//   error        a request failed (blocked, timed out, out of credits) — something to fix
//   not_listed   the site answered and does not have this game — nothing to fix

const STATUS_TEXT = { 400: 'Bad request', 401: 'Unauthorized', 402: 'Payment required', 403: 'Forbidden',
  404: 'Not found', 408: 'Timed out', 429: 'Too many requests', 500: 'Server error', 502: 'Bad gateway',
  503: 'Unavailable', 504: 'Gateway timeout' };

const notListed = error => ({ kind: 'not_listed', error });

// Summarise a failed ladder: the headline is the most telling HTTP failure (a 403 on the last step
// says more than the 200-with-no-data before it), the detail lists every step for the tooltip.
function ladderFailure(fallback, r) {
  const attempts = (r && r.attempts) || [];
  const detail = attempts.map(a => `${a.via} ${a.status || 'failed'}${a.note ? ' (' + a.note + ')' : ''}`).join(' · ');
  if (r && r.notFound) return { kind: 'not_listed', error: fallback.replace(/unavailable$/, 'not found'), detail };
  const bad = [...attempts].reverse().find(a => a.status >= 400);
  const timedOut = attempts.find(a => /timeout/i.test(a.note || ''));
  // The provider's own words beat the generic status text when they are short: Firecrawl says
  // "Insufficient credits", Crawl4AI says "Blocked by anti-bot protection: DataDome captcha".
  const said = bad && bad.note ? String(bad.note).split(/(?<=\.)\s/)[0].replace(/\.$/, '') : '';
  const error = bad ? `${bad.status} ${said && said.length <= 60 ? said : (STATUS_TEXT[bad.status] || 'Error')}`
    : timedOut ? 'Timed out' : fallback;
  return { kind: 'error', error, detail };
}

// The shape an error row takes inside price_candidates. No price, so it can never be chosen, and
// set_event_price_candidate refuses it by the same test.
export function errorCandidate(source, fail, extra = {}) {
  return {
    source, price: null, all_in: null, error: fail.error, error_kind: fail.kind || 'error',
    error_detail: fail.detail || undefined, checked_at: new Date().toISOString(), ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Gametime
// ---------------------------------------------------------------------------------------------

// Gametime serves the same listings in two encodings, apparently at random per request:
//   A) a plain JS literal     "prefee":3700,"total":4400 … "row":"16","section":"48","sectionGroup":"Field Box"
//   B) HTML-escaped tuples    &quot;prefee&quot;:[0,3700] … "row":[0,"16"],"section":[0,"48"]
// Handling only A made 9 of 28 games look like 200s with no listings. Both are parsed here.
// Neither is strict JSON (A contains `undefined`), so fields are read by anchored patterns per
// listing rather than JSON.parse.
export function parseGametimeListings(html) {
  const norm = html.includes('&quot;availableLots') ? html.replace(/&quot;/g, '"').replace(/&amp;/g, '&') : html;
  const rows = [];
  for (const chunk of norm.split('"availableLots":').slice(1)) {
    const c = chunk.slice(0, 6000);
    const p = c.match(/"price":\{"faceValue":[^,]*,"prefee":(\d+),"preTaxTotal":\d+,"salesTax":\d+,"total":(\d+)\}/)
           || c.match(/"prefee":\[0,(\d+)\],(?:"[a-zA-Z]+":\[0,\d+\],)*"total":\[0,(\d+)\]/);
    const s = c.match(/"row":"([^"]*)","section":"([^"]*)","sectionGroup":"([^"]*)"/)
           || c.match(/"row":\[0,"([^"]*)"\],"section":\[0,"([^"]*)"\],"sectionGroup":\[0,"([^"]*)"\]/);
    if (!p || !s) continue;
    let lots = [];
    const la = c.match(/^\[([\d,]*)\]/);
    if (la) lots = la[1].split(',').filter(Boolean).map(Number);
    else { const lb = c.match(/^\[1,\[((?:\[0,\d+\],?)*)\]\]/); if (lb) lots = [...lb[1].matchAll(/\[0,(\d+)\]/g)].map(x => +x[1]); }
    const deal = (c.match(/"deal":(?:"([a-z_]+)"|\[0,"([a-z_]+)"\])/) || []).slice(1).find(Boolean) || null;
    // Seat numbers sit in the same listing, just after the price: ["304","305"] in A,
    // [1,[[0,"15"],[0,"16"]]] in B. A seller can hide them until purchase, which Gametime sends as
    // "*" per seat — kept as the count with no numbers, so the editor can say the seats are
    // revealed after purchase rather than print a row of asterisks.
    let seatNums = null, seatsHidden = false;
    const sa = c.match(/"seats":\[((?:"[^"]*",?)*)\]/);
    const sb = c.match(/"seats":\[1,\[((?:\[0,"[^"]*"\],?)*)\]\]/);
    const raw = sa ? [...sa[1].matchAll(/"([^"]*)"/g)].map(x => x[1])
              : sb ? [...sb[1].matchAll(/\[0,"([^"]*)"\]/g)].map(x => x[1]) : null;
    if (raw && raw.length) {
      if (raw.every(x => x === '*')) seatsHidden = true;
      else seatNums = raw.filter(x => x !== '*');
    }
    rows.push({ price: +p[1] / 100, all_in: +p[2] / 100, row: s[1], section: s[2], section_group: s[3], lots, deal,
                seat_numbers: seatNums, seats_hidden: seatsHidden, seat_count: raw ? raw.length : null });
  }
  const uniq = [...new Map(rows.map(r => [`${r.section}|${r.row}|${r.price}|${r.lots}`, r])).values()];
  return uniq.length ? uniq : null;
}

// Team performer links from the Gametime home page, e.g. /baltimore-orioles-tickets/performers/mlbbal.
function parseGametimePerformers(html) {
  const links = [...new Set(html.match(/\/[a-z0-9-]+-tickets\/performers\/[a-z0-9]+/g) || [])];
  return links.length ? links : null;
}

function parseGametimeEventLinks(html) {
  const links = [...new Set(html.match(/\/[a-z0-9-]+\/[a-z0-9-]+-tickets\/\d{1,2}-\d{1,2}-\d{4}-[a-z0-9-]+\/events\/[a-z0-9]+/g) || [])];
  return links.length ? links : null;
}

async function gametimeEventUrl(game, ctx) {
  const home = await cachedPage(ctx, 'gt:home', 'https://gametime.co/', parseGametimePerformers);
  if (!home.ok) return { fail: ladderFailure('Gametime home page unavailable', home) };
  // "San Francisco 49ers" is /san-francisco-49-ers-tickets on Gametime; comparing with hyphens
  // removed makes that match without a per-team alias table.
  const want = slug(game.team_full || game.team);
  const loose = s => s.replace(/-/g, '');
  const perf = home.data.find(p => p.startsWith(`/${want}-tickets/`))
            || home.data.find(p => loose(p).startsWith(`/${loose(want)}tickets/`));
  if (!perf) return { fail: notListed('No Gametime page for this team') };
  const team = await cachedPage(ctx, 'gt:' + perf, 'https://gametime.co' + perf, parseGametimeEventLinks);
  if (!team.ok) return { fail: ladderFailure('Gametime team page unavailable', team) };
  const [y, m, d] = String(game.event_date).split('-');
  const onDate = team.data.filter(l => l.includes(`/${+m}-${+d}-${y}-`));
  // The opponent MUST appear in the slug. Falling back to "the only game that day" priced the
  // wrong fixture in testing (Fever vs Sky resolved to Fever vs Mystics), and a confident price for
  // a different game is the one failure worse than no price. No match -> no candidate -> the model.
  const opp = oppWords(game.opponent), homeWord = lastWord(game.team_full || game.team);
  const hasOpp = l => opp.some(w => l.split('/')[2].includes(w));
  const path = onDate.find(l => hasOpp(l) && l.split('/')[2].includes(homeWord))
            || onDate.find(hasOpp)
            || null;
  return path ? { url: 'https://gametime.co' + path } : { fail: notListed('Game not listed on Gametime') };
}

async function gametimeCandidates(game, ctx) {
  const ev = await gametimeEventUrl(game, ctx);
  if (!ev.url) return { source: 'Gametime', fail: ev.fail, candidates: [] };
  const page = await fetchLadder(ev.url, parseGametimeListings, ctx);
  ctx.stats.pages++;
  if (!page.ok) return { source: 'Gametime', url: ev.url, fail: ladderFailure('No listings found on the game page', page), candidates: [] };
  ctx.stats.byVia[page.via] = (ctx.stats.byVia[page.via] || 0) + 1;

  // Zone deals are left out: Gametime sells a zone and assigns the seat later, so the section a
  // buyer gets is not the one quoted. Gametime's own "cheapest" badge excludes them too — that is
  // how the parser was cross-checked (28/28 agree once zones are excluded).
  const usable = page.data.filter(l => l.deal !== 'zone');
  const pairs = usable.filter(l => l.lots.includes(2));
  // Two seats together first, the rule the model prompt has used since 2026-08-03; a single only
  // when no pair exists at all.
  const pool = (pairs.length ? pairs : usable).sort((a, b) => a.all_in - b.all_in || a.price - b.price);
  const seats = pairs.length ? 2 : 1;
  const checked = new Date().toISOString();
  return {
    source: 'Gametime', url: ev.url, via: page.via, listings: page.data.length,
    candidates: pool.slice(0, GAMETIME_CANDIDATES).map(l => ({
      source: 'Gametime', url: ev.url, price: round2(l.price), all_in: round2(l.all_in), currency: 'USD',
      seats, section: l.section, row: l.row, section_group: l.section_group,
      // quantities: how many tickets the seller will sell together (Gametime "lots"), e.g. [2,4].
      // seat_numbers: the actual seats in the listing; null with seats_hidden when the seller only
      // reveals them after purchase.
      quantities: l.lots, seat_numbers: l.seat_numbers, seats_hidden: l.seats_hidden || undefined,
      seat_count: l.seat_count, via: page.via, checked_at: checked,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// TickPick
// ---------------------------------------------------------------------------------------------
//
// TickPick's per-seat listings sit behind DataDome, which refused plain HTTP, Crawl4AI and
// Firecrawl's stealth proxy alike. Its TEAM page is open and carries a schema.org offer per game
// with lowPrice, which is enough for a get-in. No section, row or quantity comes with it, so the
// candidate says so instead of implying a pair.

function parseTickpickOffers(html) {
  const out = [];
  for (const b of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(b[1]); } catch { continue; }
    for (const e of [].concat(j)) {
      const of = e && e.offers;
      const url = (of && of.url) || (e && e.url) || '';
      const low = of && of.lowPrice != null ? Number(of.lowPrice) : null;
      if (url.includes('/buy-') && low > 0) out.push({ url: url.replace(/&amp;/g, '&'), low, high: of.highPrice != null ? Number(of.highPrice) : null });
    }
  }
  return out.length ? out : null;
}

async function tickpickCandidates(game, ctx) {
  const teamSlug = slug(game.team_full || game.team);
  const page = await cachedPage(ctx, 'tp:' + teamSlug, `https://www.tickpick.com/${teamSlug}-tickets/`, parseTickpickOffers);
  if (!page.ok) return { source: 'TickPick', fail: page.notFound ? notListed('No TickPick page for this team') : ladderFailure('TickPick team page unavailable', page), candidates: [] };
  const [y, m, d] = String(game.event_date).split('-');
  const tag = `-${+m}-${+d}-${y.slice(2)}-`;
  const onDate = page.data.filter(o => o.url.includes(tag) && o.url.includes(`/buy-${teamSlug}-vs-`));
  // Opponent required, for the same reason as on Gametime.
  const opp = oppWords(game.opponent);
  const hit = onDate.find(o => opp.some(w => o.url.split('/buy-')[1].includes(w))) || null;
  if (!hit) return { source: 'TickPick', fail: notListed('Game not listed on TickPick'), candidates: [] };
  return {
    source: 'TickPick', url: hit.url, via: page.via,
    candidates: [{
      source: 'TickPick', url: hit.url, price: round2(hit.low), all_in: round2(hit.low), currency: 'USD',
      seats: null, section: null, row: null, section_group: null, quantities: null,
      note: 'Fees included. TickPick does not publish the seats or quantity behind its get-in.',
      via: page.via, checked_at: new Date().toISOString(),
    }],
  };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

// Price one game from every source. Returns the candidates ranked, the chosen one first and marked,
// or no candidates when nothing could be read — in which case the caller falls back to the model.
export async function scrapeGamePrice(game, ctx) {
  // A source that throws is a failed source, not a failed game.
  const guard = (source, p) => p.catch(e => ({ source, fail: { kind: 'error', error: `Scraper error: ${String(e.message || e).slice(0, 80)}` }, candidates: [] }));
  const results = await Promise.all([
    guard('Gametime', gametimeCandidates(game, ctx)),
    guard('TickPick', tickpickCandidates(game, ctx)),
  ]);
  const priced = results.flatMap(r => r.candidates)
    .sort((a, b) => a.all_in - b.all_in || (b.seats === 2) - (a.seats === 2) || (b.section != null) - (a.section != null));
  if (priced.length) { priced[0].chosen = true; priced[0].chosen_by = 'refresh'; }
  const errors = results.filter(r => !r.candidates.length)
    .map(r => errorCandidate(r.source, r.fail || { kind: 'error', error: 'No price found' }, r.url ? { url: r.url } : {}));
  return {
    external_id: game.external_id,
    // Prices first, ranked; error rows after them. The editor renders the list in this order.
    candidates: priced.concat(errors),
    errors,
    chosen: priced[0] || null,
    sources: results.map(r => ({ source: r.source, ok: r.candidates.length > 0, error: r.fail && r.fail.error, via: r.via, listings: r.listings })),
  };
}

// The row set_event_prices expects, from a scrape result. `price_usd` is the chosen listing's
// pre-fee price — see PRICE BASIS at the top.
export function scrapeToPriceRow(result) {
  const c = result.chosen;
  if (!c) return null;
  return {
    external_id: result.external_id,
    price_usd: c.price,
    currency: c.currency || 'USD',
    source: c.source,
    seats: c.seats === 2 || c.seats === 1 ? c.seats : null,
    url: c.url,
    candidates: result.candidates,
  };
}
