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
    'Return ONLY JSON of shape {"prices":[{"ref":"<ref>","price_usd":<number|null>,"source":"<site>"}]}.',
    '', 'Games:', ...lines,
  ].join('\n');
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
    if (hit && hit.price_usd != null) priced.push({ external_id: g.external_id, price_usd: hit.price_usd, source: hit.source || 'gemini' });
  }
  return { ok: true, ms, priced, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0 };
}
