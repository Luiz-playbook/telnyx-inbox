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

export function buildPricePrompt(games) {
  const lines = games.map(g =>
    `- ref=${g.external_id}: on ${g.event_date}, the ${g.team} host the ${g.opponent} at ${g.venue || 'their venue'}`);
  return [
    'You look up CURRENT resale ticket prices for specific games. For each game below,',
    'find the lowest available "get-in" price on the secondary market (StubHub / SeatGeek /',
    'Ticketmaster resale). Use web search.',
    'IMPORTANT price rules:',
    '- Report the price for a SINGLE ticket (per seat), NOT a pair or group total.',
    '- Report the LISTED price shown on the site BEFORE service/booking fees (the number a',
    '  buyer first sees browsing listings), not the final checkout total with fees.',
    '- Do NOT guess: if you cannot find a price, return price_usd = null.',
    // The UI links the price straight to the listing it came from, so an operator can check
    // it before a blast goes out. Without a url the number is unverifiable.
    '- Also return "url": the direct link to the listing page the price was read from.',
    '  It must be a full https:// address for that specific game, not a site home page.',
    '  If you have no such link, return url = null rather than inventing one.',
    'Return ONLY JSON of shape {"prices":[{"ref":"<ref>","price_usd":<number|null>,"source":"<site>","url":"<https url|null>"}]}.',
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

// Where an operator can actually check this price.
//
// The model was asked for the listing URL and answered with well-formed deep links whose event
// ids were fabricated — right site, right game slug, 404 on click. It cannot know an internal
// id it did not read, so asking harder does not fix it. Grounding metadata is no help either:
// calls are batched six games at a time and the returned chunks carry only a domain, so a
// source page cannot be attributed to a particular game.
//
// This builds the link instead, from the teams and date already in events_master, pointing at
// the marketplace the price came from. It is a search rather than the exact listing — one click
// further away, but it opens.
export function buildSearchUrl(game, source) {
  const q = encodeURIComponent(
    [game.team, 'vs', game.opponent, game.event_date].filter(Boolean).join(' '));
  // The model names the site freely — "SeatGeek", "Vivid Seats", "www.stubhub.com" — so both
  // sides are reduced to letters only before matching, or "Vivid Seats" misses "vividseats".
  const host = String(source || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const domain of Object.keys(SEARCH_URL)) {
    if (host.includes(domain.replace(/[^a-z]/g, '').replace(/com$/, ''))) return SEARCH_URL[domain](q);
  }
  return `https://www.google.com/search?q=${q}%20tickets`;
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
    if (hit && hit.price_usd != null) priced.push({
      external_id: g.external_id,
      price_usd: hit.price_usd,
      source: hit.source || 'gemini',
      // Built, not quoted: see buildSearchUrl. The model's own link is kept only as a record of
      // what it claimed, never as the thing an operator clicks.
      url: buildSearchUrl(g, hit.source),
      model_url: cleanPriceUrl(hit.url) || undefined,
    });
  }
  return { ok: true, ms, priced, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0 };
}
