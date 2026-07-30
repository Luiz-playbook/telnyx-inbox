// Shared grounded price-lookup path. ONE implementation used by both the AI-828 cron
// job (api/price-refresh.js) and the Campaign Agent's get_event_price tool (api/chat.js),
// so there is never a second, drifting price source.
//
// Gemini flash-lite + google_search grounding. Ungrounded models hallucinate prices;
// grounding is mandatory (price is the one field the master table can't guarantee).

export const PRICE_MODEL = 'gemini-2.5-flash-lite';
export const PRICE_IN_COST = 0.10 / 1e6;   // approx USD/token, verify
export const PRICE_OUT_COST = 0.40 / 1e6;
export const GROUNDING_PER_REQ = 0.035;    // per grounded request

// A get-in price is the cheapest seat in the building. Anything above this is the model having
// reported a premium/club seat instead — seen for real: $1,189 on a regular-season Twins game
// while every comparable game came back $8-$89. Storing it would quote a nonsense number in a
// blast, so it is dropped and counted as a miss, which the next run retries.
export const PRICE_SANITY_MAX = 250;

export function buildPricePrompt(games) {
  const lines = games.map(g =>
    `- ref=${g.external_id}: on ${g.event_date}, the ${g.team} host the ${g.opponent} at ${g.venue || 'their venue'}`);
  // PINNED (AI-845). Do not add to this prompt. Asking for a listing URL alongside the price
  // wrecked accuracy: the run average went $28 -> $42 and one regular-season game came back at
  // $1,189 as a "get-in". Anything else the pipeline needs — links, currency — is derived
  // outside the model, not bolted onto these instructions. Prices are the product; everything
  // else is decoration and must not be allowed to compete with them.
  return [
    'You look up CURRENT resale ticket prices for specific games. For each game below,',
    'find the lowest available "get-in" price on the secondary market (StubHub / SeatGeek /',
    'Ticketmaster resale). Use web search.',
    'IMPORTANT price rules:',
    '- Report the price for a SINGLE ticket (per seat), NOT a pair or group total.',
    '- Report the LISTED price shown on the site BEFORE service/booking fees (the number a',
    '  buyer first sees browsing listings), not the final checkout total with fees.',
    '- Do NOT guess: if you cannot find a price, return price_usd = null.',
    'Return ONLY JSON of shape {"prices":[{"ref":"<ref>","price_usd":<number|null>,"source":"<site>"}]}.',
    '', 'Games:', ...lines,
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
export async function callGeminiPrices(gkey, games) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPricePrompt(games) }] }],
    generationConfig: { temperature: 0 },
    tools: [{ google_search: {} }],
  };
  const t0 = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${PRICE_MODEL}:generateContent?key=${gkey}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ms = Date.now() - t0;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, ms, priced: [], inTok: 0, outTok: 0 };

  const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const u = json.usageMetadata || {};
  let parsed = null;
  try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim()); } catch { /* null */ }
  const rows = parsed?.prices || [];
  const priced = [];
  for (const g of games) {
    const hit = rows.find(x => String(x.ref) === String(g.external_id));
    // Implausible numbers are treated as a miss, not as data.
    if (hit && hit.price_usd != null && Number(hit.price_usd) > PRICE_SANITY_MAX) continue;
    if (hit && hit.price_usd != null && Number(hit.price_usd) <= 0) continue;
    if (hit && hit.price_usd != null) priced.push({
      external_id: g.external_id,
      price_usd: hit.price_usd,
      currency: 'USD',
      source: hit.source || 'gemini',
      // Built here, never asked of the model — that request is what damaged the prices. The
      // team page always resolves, unlike a listing id the model would have to invent.
      url: buildSearchUrl(g, hit.source),
    });
  }
  return { ok: true, ms, priced, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0 };
}
