// Shared grounded price-lookup path. ONE implementation used by both the AI-828 cron
// job (api/price-refresh.js) and the Campaign Agent's get_event_price tool (api/chat.js),
// so there is never a second, drifting price source.
//
// Gemini flash-lite + google_search grounding. Ungrounded models hallucinate prices;
// grounding is mandatory (price is the one field the master table can't guarantee).

// flash, not flash-lite (2026-08-03). The prompt below now carries conditional logic — prefer a
// two-seat listing, fall back to a single, divide a pair total by two — and lite is the tier
// most likely to fumble that and silently report a pair total as a per-seat price.
//
// The upgrade is close to free HERE, which is not true in general: grounding is billed per
// REQUEST at $0.035, and a full refresh is ~22 batched requests = ~$0.77, against a measured
// average run cost of $0.71. Grounding is therefore essentially the entire bill and tokens are
// noise, so a higher per-token rate moves the run cost by cents.
export const PRICE_MODEL = 'gemini-2.5-flash';

// ---------------------------------------------------------------------------------------
// OPENROUTER ROUTE (2026-08-26). Direct Google access is being withdrawn, so the price path
// has to run through OpenRouter like everything else.
//
// It cannot use Gemini there. OpenRouter normalises every provider to the OpenAI schema and
// has no field for Google's tools:[{google_search:{}}], so the flag is silently dropped —
// measured: the grounded request and an ungrounded control both used exactly 449 prompt
// tokens, and prices came back null for every game. OpenRouter's own web plugin does inject
// results, but found 0/4 prices on gemini-flash, gemini-pro and gpt-4o alike.
//
// perplexity/sonar-pro is search-native and the only route tested that returns prices at all.
// Measured against the grounded path on the same four games (2026-09-04 MLB):
//   Google native grounding  4/4 coverage   $0.037/req   <- what we are giving up
//   perplexity/sonar-pro     3/4 coverage   $0.011/req
//   perplexity/sonar         3/4 coverage   $0.006/req   (2/4 within 40% of truth)
// sonar-pro's misses are not random: it quoted $28 against a true $46 by reading an "all-in"
// resale price from a low-quality reseller. Hence the tightened guards below — this route is
// less trustworthy than the one it replaces, and the code has to compensate for that.
export const PRICE_MODEL_OR = 'perplexity/sonar-pro';

// SECOND-CHANCE MODEL (Vhea, 2026-08-26). A game that comes back without a price used to be
// dropped: api/price-refresh.js only retries a batch when it returns ZERO prices, so a single
// null inside an otherwise-good batch was never looked at again.
//
// Only the games that missed are retried, so a clean batch costs nothing extra. Measured on
// the same four games the grounded path priced:
//   perplexity/sonar-pro          4/4 coverage, 1/4 within 25% of truth, $0.010/req,  9s
//   perplexity/sonar-pro-search   4/4 coverage, 3/4 within 25% of truth, $0.022/req, 13s
//   perplexity/sonar-reasoning-pro 4/4 coverage, 2/4 within 25%, $0.008/req, but 95s — far
//     too slow for the 200s run budget once batches are queued behind each other.
// So the retry uses the accurate-but-pricier tier, on the theory that a price worth retrying
// is worth paying twice for. Set PRICE_FALLBACK_MODEL=off to disable, or to another id.
//
// NOT an option: any OpenAI model. openai/gpt-4o-search-preview does not exist on OpenRouter
// (404), and plain gpt-4o has no live search — measured 0/4. Every search-capable model on
// OpenRouter is a Perplexity sonar variant, so the fallback is a different tier, not a
// different company.
export const PRICE_FALLBACK_MODEL = 'perplexity/sonar-pro-search';

// Sources sonar-pro was seen quoting all-in or otherwise non-get-in prices from. A row whose
// source matches is dropped rather than stored: a wrong price shown to an operator as fact is
// worse than no price, which is the same rule PRICE_SANITY_MAX already encodes.
export const PRICE_SOURCE_DENY = [/king of tickets/i, /all-in/i];

// Canonical marketplace names. The grounded Gemini route returned a bare vendor ("SeatGeek"),
// but sonar-pro returns a whole sentence — measured verbatim:
//   "StubHub listing for Milwaukee Brewers at Cincinnati Reds at Great American Ball Park,
//    showing 2 tickets together in Section 402 Row Q at $15 each."
// That string is stored and rendered as the price provenance on Campaigns, and it is also what
// buildSearchUrl() matches a domain against — so left as prose it both wrecks the provenance
// column and pushes every ticket link to the Google fallback.
const SOURCE_NAMES = [
  [/stub\s*hub/i, 'StubHub'], [/seat\s*geek/i, 'SeatGeek'], [/vivid\s*seats/i, 'Vivid Seats'],
  [/ticketmaster/i, 'Ticketmaster'], [/gametime/i, 'Gametime'], [/tickpick/i, 'TickPick'],
  [/mlb\.com/i, 'MLB.com'],
];

// Pull a known marketplace out of whatever the model said. Unrecognised text is clipped rather
// than discarded: a short odd source still tells an operator where to go looking, while a
// paragraph in a table cell is not provenance at all.
export function normalizeSource(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const [re, name] of SOURCE_NAMES) if (re.test(t)) return name;
  return t.length > 40 ? t.slice(0, 37).trimEnd() + '...' : t;
}

// Which way a price lookup goes. OPENROUTER_GEMINI set => OpenRouter + sonar-pro; otherwise
// the original Google-native grounded path, which stays the reference implementation for as
// long as a GEMINI_API_KEY exists.
export function priceRoute() {
  const orKey = (process.env.OPENROUTER_GEMINI || '').trim();
  const gKey = (process.env.GEMINI_API_KEY || '').trim();
  if (orKey) {
    // PRICE_MODEL_OR overrides the primary search model, the same way OPENAI_MODEL/DRAFT_MODEL
    // work elsewhere. Needed to pilot a tier against the run average without a deploy.
    const model = (process.env.PRICE_MODEL_OR || PRICE_MODEL_OR).trim();
    return { ok: true, via: 'openrouter', key: orKey, model, label: 'OpenRouter/' + model.split('/').pop(), grounded: false };
  }
  if (gKey) return { ok: true, via: 'google', key: gKey, model: PRICE_MODEL, label: 'Google/grounded', grounded: true };
  return { ok: false, via: 'none', key: '', model: PRICE_MODEL, label: 'none', grounded: false };
}
// ---------------------------------------------------------------------------------------
export const PRICE_IN_COST = 0.30 / 1e6;   // approx USD/token, verify
export const PRICE_OUT_COST = 2.50 / 1e6;
export const GROUNDING_PER_REQ = 0.035;    // per grounded request

// A get-in price is the cheapest seat in the building. Anything above this is the model having
// reported a premium/club seat instead — seen for real: $1,189 on a regular-season Twins game
// while every comparable game came back $8-$89. Storing it would quote a nonsense number in a
// blast, so it is dropped and counted as a miss, which the next run retries.
export const PRICE_SANITY_MAX = 250;

// Should the model be asked for a listing URL as well as a price?
//
// AI-845: it used to be, and that wrecked the prices. The run average went $28 -> $42 and one
// regular-season game came back at $1,189 as a "get-in". The request was removed and the URL has
// been built in code ever since (buildSearchUrl). The finding was that a second output field
// competes with the price for the model's attention — prices are the product, links are not.
//
// Vhea asked for it back on 2026-08-03, alongside the two-seat rule. It is OFF by default so the
// two changes do not ship together: if both land at once and the average moves, there is no way
// to tell which one did it, which is how AI-845 took as long as it did to pin down. The seat rule
// is the valuable half and is safe; this is the half with a known failure behind it.
//
// Nothing in the app needs it — the Queue's ticket link and the price info panel are both fed by
// buildSearchUrl and by fields we already store. Flip to true only to run the experiment, and
// watch the average in events_master_price_runs. A jump toward $40 is AI-845 repeating, not a
// hot ticket market.
export const ASK_FOR_LISTING_URL = false;

export function buildPricePrompt(games) {
  const lines = games.map(g =>
    `- ref=${g.external_id}: ${g.event_date}, ${g.team} vs. ${g.opponent} at ${g.venue || 'their venue'}`);

  // TWO SEATS TOGETHER (Vhea, 2026-08-03). A one-seat get-in is often a lone restricted-view
  // single nobody buying for two people can use, so the headline number in a blast was answering
  // a question no customer asks. The REPORTED figure is still per ticket either way — only which
  // listing it is read off changes.
  const urlField = ASK_FOR_LISTING_URL ? ',\n      "listing_url": "string" | null' : '';
  const nullRule = ASK_FOR_LISTING_URL
    ? '   - Do NOT guess or estimate. If no active, verified listing is found via web search, return `null` for `price_usd`, `source`, and `listing_url`.'
    : '   - Do NOT guess or estimate. If no active, verified listing is found via web search, return `null` for `price_usd` and `source`.';

  return [
    'You are a real-time ticket price extraction tool. Your job is to search the web for CURRENT live ticket listings for the specified games and extract the lowest "get-in" price on the secondary/primary market (e.g., StubHub, SeatGeek, Vivid Seats, Ticketmaster).',
    '',
    'PRICE & EXTRACTION RULES:',
    '1. QUANTITY PRIORITY:',
    '   - Primary: Look for listings for TWO (2) SEATS TOGETHER. Report the price for 1 ticket (the total price for 2 seats divided by 2, or the per-ticket price shown for a 2-ticket listing).',
    '   - Fallback: ONLY if there are no 2-seat listings available, report the price for a SINGLE (1-seat) listing.',
    '2. PRICE TYPE:',
    '   - Report the LISTED price per ticket BEFORE taxes and service fees (the face price displayed on the initial ticket grid/listing).',
    '3. NO HALLUCINATIONS:',
    nullRule,
    '4. OUTPUT FORMAT:',
    '   - Return ONLY a valid JSON object matching the exact schema below. Do not output conversational preamble, explanation, or text outside the JSON code block.',
    '',
    'JSON SCHEMA:',
    '{',
    '  "prices": [',
    '    {',
    '      "ref": "string",',
    '      "price_usd": number | null,',
    '      "seat_quantity_used": 2 | 1 | null,',
    '      "source": "string" | null' + urlField,
    '    }',
    '  ]',
    '}',
    '',
    'GAMES TO LOOK UP:',
    ...lines,
  ].join('\n');
}

// Marketplace search endpoints. A search URL is built from data we hold (teams + date), so it
// always resolves — unlike a deep link, whose event id the model has to know and instead
// invents. Google is the fallback for an unrecognised source.
const SEARCH_URL = {
  'seatgeek.com':    q => `https://seatgeek.com/search?q=${q}`,
  'stubhub.com':     q => `https://www.stubhub.com/find/s/?q=${q}`,
  'vividseats.com':  q => `https://www.vividseats.com/search?searchTerm=${q}`,
  'ticketmaster.com':q => `https://www.ticketmaster.com/search?q=${q}`,
};

// FALLBACK ONLY — used when the model returns no usable link. Do not promote this over the
// model's own URL again: its deep links mostly resolve to the real ticket page, whereas these
// search URLs were observed landing on the site's home page, which is useless for checking a
// price. One bad link (a slug garbled into Tamil script) and one reported 404 are not grounds
// for discarding links that work; the marketplaces 403 every scripted request, so reachability
// cannot be tested from the server and the operator's observation is the only evidence there is.
// "Cleveland Guardians" -> "cleveland-guardians", matching the slug ticket sites use in paths.
const teamSlug = name => String(name || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '-');

export function buildSearchUrl(game, source) {
  // SeatGeek's /<team>-tickets page is the ONE link shape confirmed to work, so every game
  // gets it regardless of which site the price came from. The per-marketplace search URLs
  // tried before — vividseats, stubhub, ticketmaster, google — were all reported broken, and
  // a link that does not open is worse than a slightly different marketplace: the operator is
  // checking that a get-in price is real, and SeatGeek lists the same game.
  const slug = teamSlug(game.team_full);
  if (slug.includes('-')) return `https://seatgeek.com/${slug}-tickets`;

  // No usable full team name (28 of 2,407 games) — fall back to a search on the named source.
  const q = encodeURIComponent(
    [game.team, 'vs', game.opponent, game.event_date].filter(Boolean).join(' '));
  const host = String(source || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const domain of Object.keys(SEARCH_URL)) {
    if (host.includes(domain.replace(/[^a-z]/g, '').replace(/com$/, ''))) return SEARCH_URL[domain](q);
  }
  return `https://www.google.com/search?q=${q}%20tickets`;
}

// Does the URL's event id look invented rather than read off a page?
//
// Ticket sites end a listing path with an internal id. The model does not always know it and
// sometimes emits an obvious placeholder — observed in the wild:
//   .../mlb-game-1-e1234567          <- literal placeholder, 404
//   .../mlb/67000000/1770000000000   <- suspiciously round
// A real id (5770078, 16061716, 5707077) looks nothing like these. Rejecting them here sends
// the link to the team-page fallback, which resolves, instead of a dead listing page.
export function looksFabricatedId(url) {
  const nums = String(url || '').match(/\d{5,}/g) || [];
  return nums.some(n => {
    if (/0{4,}$/.test(n)) return true;                       // 67000000, 45100000
    if (/^(\d)\1+$/.test(n)) return true;                    // 1111111
    if ('01234567890'.includes(n)) return true;              // 1234567, 456789
    if ('98765432109'.includes(n)) return true;              // descending run
    return false;
  });
}

// A url is only worth storing if it is an absolute http(s) address. The model occasionally
// answers with a bare domain or a placeholder, and a broken link on a price is worse than
// no link: it invites the operator to "verify" against nothing.
export function cleanPriceUrl(u) {
  const s = String(u || '').trim();
  if (!s || s.toLowerCase() === 'null') return null;
  let p;
  try { p = new URL(s); } catch { return null; }
  if (p.protocol !== 'https:' && p.protocol !== 'http:') return null;
  // Syntactic validity is not enough. A real run produced
  //   /phillies-at-orioles-tickets/%20%E0%AE%9A...-park-at-camden-yards-...
  // where the model garbled "Oriole Park" into Tamil script: a perfectly well-formed URL
  // that 404s. Ticket-site paths are ASCII slugs, so anything non-ASCII or containing
  // whitespace in the path is a hallucinated slug, not a link worth showing an operator.
  let decoded;
  try { decoded = decodeURIComponent(p.pathname + p.search); } catch { return null; }
  if (/[^\x20-\x7E]/.test(decoded)) return null;   // non-ASCII => garbled slug
  if (/\s/.test(decoded)) return null;             // stray spaces => not a real path
  if (looksFabricatedId(p.pathname)) return null;  // placeholder / round id => dead listing
  return p.href;
}

// One grounded call over a (small) batch of games. Returns priced rows keyed to the
// games passed in, plus token usage for cost accounting.
// One call over a (small) batch of games. Returns priced rows keyed to the games passed in,
// plus usage for cost accounting. Routes per priceRoute(); the parsing, sanity caps and URL
// building below are shared, so both routes are held to identical standards.
async function fetchPrices(route, games) {
  const t0 = Date.now();
  let res, json;

  if (route.via === 'google') {
    const body = {
      contents: [{ role: 'user', parts: [{ text: buildPricePrompt(games) }] }],
      generationConfig: { temperature: 0 },
      tools: [{ google_search: {} }],
    };
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${route.model}:generateContent?key=${route.key}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ms: Date.now() - t0, text: '', inTok: 0, outTok: 0, costUsd: null };
    const u = json.usageMetadata || {};
    return {
      ok: true, ms: Date.now() - t0,
      text: (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''),
      inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0,
      costUsd: null,   // computed by the caller from the per-request grounding rate
    };
  }

  res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${route.key}`,
      'HTTP-Referer': 'https://telnyx-inbox.vercel.app',
      'X-Title': 'Playbook Marketing Blaster',
    },
    body: JSON.stringify({
      model: route.model, temperature: 0,
      messages: [{ role: 'user', content: buildPricePrompt(games) }],
    }),
  });
  json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, ms: Date.now() - t0, text: '', inTok: 0, outTok: 0, costUsd: null };
  const u = json.usage || {};
  return {
    ok: true, ms: Date.now() - t0,
    text: json.choices?.[0]?.message?.content || '',
    inTok: u.prompt_tokens || 0, outTok: u.completion_tokens || 0,
    // OpenRouter reports the exact charge per request, so the run log stops estimating.
    costUsd: typeof u.cost === 'number' ? u.cost : null,
  };
}

// Turn one model response into priced rows. Shared by both passes so the retry is held to
// exactly the same sanity caps, deny-list and URL rules as the first attempt.
function parsePriced(text, games, route) {
  let parsed = null;
  try { parsed = JSON.parse(String(text || '').replace(/^```json\s*|\s*```$/g, '').trim()); } catch { /* null */ }
  const rows = parsed?.prices || [];
  const priced = [];
  for (const g of games) {
    const hit = rows.find(x => String(x.ref) === String(g.external_id));
    if (!hit || hit.price_usd == null) continue;
    // Implausible numbers are treated as a miss, not as data.
    if (Number(hit.price_usd) > PRICE_SANITY_MAX) continue;
    if (Number(hit.price_usd) <= 0) continue;
    // Ungrounded routes quote all-in resale prices from low-quality sellers; those are a
    // different number from a get-in price, so they are dropped rather than stored.
    // Tested against the RAW text, not the normalised name — "all-in" shows up in the model's
    // sentence, never in a canonical vendor label.
    if (!route.grounded && PRICE_SOURCE_DENY.some(re => re.test(String(hit.source || '')))) continue;
    // Only 2 and 1 mean anything here. Anything else — 4, "two", a stray null — is recorded as
    // unknown rather than guessed at, because this number is shown to an operator as the basis
    // of the price and a wrong one is worse than an absent one.
    const seats = Number(hit.seat_quantity_used);
    // A model-supplied URL is put through the same fabricated-id and garbled-slug checks that
    // exist because of AI-845, and falls back to the derived team page if it fails them. With
    // ASK_FOR_LISTING_URL off there is simply nothing to check.
    const modelUrl = ASK_FOR_LISTING_URL ? cleanPriceUrl(hit.listing_url) : null;
    const source = normalizeSource(hit.source) || route.via;
    priced.push({
      external_id: g.external_id,
      price_usd: hit.price_usd,
      currency: 'USD',
      source,
      seats: (seats === 2 || seats === 1) ? seats : null,
      url: modelUrl || buildSearchUrl(g, source),
    });
  }
  return priced;
}

export async function callPrices(games) {
  const route = priceRoute();
  if (!route.ok) return { ok: false, ms: 0, priced: [], inTok: 0, outTok: 0, costUsd: null, route, retried: 0 };

  const t0 = Date.now();
  const r = await fetchPrices(route, games);
  if (!r.ok) return { ok: false, ms: Date.now() - t0, priced: [], inTok: 0, outTok: 0, costUsd: null, route, retried: 0 };

  let priced = parsePriced(r.text, games, route);
  let inTok = r.inTok, outTok = r.outTok;
  let costUsd = r.costUsd;
  let retried = 0;

  // Second chance for the games that came back without a usable price — including ones the
  // sanity cap or deny-list rejected, which are misses for our purposes even though the model
  // answered. Google's grounded route is the reference implementation and is not retried:
  // it is the thing the fallback is trying to approximate.
  const fallbackModel = (process.env.PRICE_FALLBACK_MODEL || PRICE_FALLBACK_MODEL).trim();
  const missing = games.filter(g => !priced.some(p => String(p.external_id) === String(g.external_id)));
  if (route.via === 'openrouter' && fallbackModel && fallbackModel.toLowerCase() !== 'off'
      && missing.length && fallbackModel !== route.model) {
    retried = missing.length;
    const r2 = await fetchPrices({ ...route, model: fallbackModel }, missing);
    if (r2.ok) {
      priced = priced.concat(parsePriced(r2.text, missing, route));
      inTok += r2.inTok; outTok += r2.outTok;
      if (typeof r2.costUsd === 'number') costUsd = (costUsd || 0) + r2.costUsd;
    }
  }

  return { ok: true, ms: Date.now() - t0, priced, inTok, outTok, costUsd, route, retried };
}

// Back-compat shim: the key argument is ignored, the route now comes from env.
export async function callGeminiPrices(_key, games) { return callPrices(games); }
