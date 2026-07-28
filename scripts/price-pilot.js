// One-off PILOT: real grounded ticket prices for the next N unpriced MLB games, WITH the
// source URL (so the UI can link the price). Fetches games from Supabase (anon read),
// asks Gemini flash-lite (google_search grounded) for the lowest get-in price + listing URL,
// and prints a JSON array of {external_id, price_usd, source, source_url}. Writes are applied
// separately (via MCP) so no anon UPDATE grant on events_master is needed.
//
//   node --env-file=.env scripts/price-pilot.js [N=12]

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
const GKEY = (process.env.GEMINI_API_KEY || '').trim();
if (!SUPA_URL || !SUPA_KEY || !GKEY) { console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / GEMINI_API_KEY'); process.exit(1); }

const N = Number(process.argv[2] || 12);
const MODEL = 'gemini-2.5-flash-lite';
const BATCH = 6;
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function prompt(games) {
  const lines = games.map(g =>
    `- ref=${g.external_id}: on ${g.event_date}, the ${g.team_full || g.team} host the ${g.opponent} at ${g.venue || 'their venue'}`);
  return [
    'You look up CURRENT resale ticket prices for specific MLB games. For each game below,',
    'find the lowest available "get-in" price per ticket in USD on the secondary market',
    '(StubHub / SeatGeek / Ticketmaster resale) using web search. Do NOT guess: if you cannot',
    'find a price, return price_usd = null. Also return the exact listing URL you used as source_url.',
    'Return ONLY JSON: {"prices":[{"ref":"<ref>","price_usd":<number|null>,"source":"<site>","source_url":"<url>"}]}.',
    '', 'Games:', ...lines,
  ].join('\n');
}

async function priceBatch(games) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt(games) }] }],
    generationConfig: { temperature: 0 },
    tools: [{ google_search: {} }],
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GKEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('gemini error', res.status, JSON.stringify(json).slice(0, 300)); return []; }
  const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  let parsed = null;
  try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim()); } catch { /* null */ }
  const rows = parsed?.prices || [];
  const out = [];
  for (const g of games) {
    const hit = rows.find(x => String(x.ref) === String(g.external_id));
    if (hit && hit.price_usd != null) out.push({ external_id: g.external_id, team: g.team_full || g.team, opponent: g.opponent,
      event_date: g.event_date, price_usd: hit.price_usd, source: hit.source || 'gemini', source_url: hit.source_url || null });
  }
  return out;
}

(async () => {
  const url = `${SUPA_URL}/rest/v1/events_master?league=eq.mlb&best_price=is.null&event_date=gte.${new Date().toISOString().slice(0,10)}`
    + `&select=external_id,team,team_full,opponent,event_date,venue&order=event_date.asc&limit=${N}`;
  const res = await fetch(url, { headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } });
  const games = await res.json();
  if (!Array.isArray(games) || !games.length) { console.error('no games fetched', games); process.exit(1); }
  console.error(`Pricing ${games.length} games in ${Math.ceil(games.length / BATCH)} grounded call(s)…`);
  const priced = [];
  for (const b of chunk(games, BATCH)) priced.push(...await priceBatch(b));
  console.error(`Got ${priced.length}/${games.length} prices.`);
  console.log(JSON.stringify(priced, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
