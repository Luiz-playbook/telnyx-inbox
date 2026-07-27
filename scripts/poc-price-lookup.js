// AI-827 SPIKE (throwaway POC): batched ticket-price lookup via Gemini.
//
// Feeds SPECIFIC games from events_master to Gemini in small batches and asks ONLY for
// price — the safe prompt Josh described ("on {date} the {team} play {opp} at {venue},
// best price?"). Never asks the model to invent a game list; that comes from the table.
//
// Measures, per model tier and grounded vs not: total cost, wall time, failure rate,
// and cross-run price variance (our proxy for accuracy — we have no ground-truth feed).
// Also runs the bulk test: one call with ~300 games to see if a single request works.
//
//   node --env-file=.env scripts/poc-price-lookup.js --limit 24 --batch 12 --model flash --grounded
//   node --env-file=.env scripts/poc-price-lookup.js --compare            # run all tiers on a sample
//   node --env-file=.env scripts/poc-price-lookup.js --bulk 300           # single-call bulk test
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY.

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
const GKEY = process.env.GEMINI_API_KEY;
if (!SUPA_URL || !SUPA_KEY || !GKEY) { console.error('Need SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY'); process.exit(1); }

const args = process.argv.slice(2);
const flag = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);

// approx Gemini 2.5 pricing, USD per 1M tokens (VERIFY before quoting — moves often).
// google_search grounding is billed per grounded request on top of tokens (~$35/1k).
const MODELS = {
  'flash-lite': { id: 'gemini-2.5-flash-lite', in: 0.10, out: 0.40 },
  'flash':      { id: 'gemini-2.5-flash',      in: 0.30, out: 2.50 },
  'pro':        { id: 'gemini-2.5-pro',        in: 1.25, out: 10.00 },
};
const GROUNDING_PER_REQ = 0.035;

async function games(limit, windowDays) {
  const params = new URLSearchParams({
    select: 'external_id,team,team_full,opponent,event_date,venue',
    league: 'eq.mlb', market_code: 'not.is.null', order: 'event_date.asc',
  });
  if (windowDays) params.set('event_date', `lte.${new Date(Date.now() + windowDays * 864e5).toISOString().slice(0, 10)}`);
  if (limit) params.set('limit', String(limit));
  const res = await fetch(`${SUPA_URL}/rest/v1/events_master?${params}`, {
    headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`events fetch ${res.status}: ${await res.text()}`);
  return res.json();
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function buildPrompt(batch) {
  const lines = batch.map(g =>
    `- ref=${g.external_id}: on ${g.event_date}, the ${g.team_full} host the ${g.opponent} at ${g.venue}`);
  return [
    'You look up CURRENT resale ticket prices for specific MLB games. For each game below,',
    'find the lowest available "get-in" price per ticket in USD on the secondary market',
    '(StubHub / SeatGeek / Ticketmaster resale). Use web search. Do NOT guess: if you cannot',
    'find a price, return price_usd = null with a short note. Return ONLY JSON of shape',
    '{"prices":[{"ref":"<ref>","price_usd":<number|null>,"source":"<site>","note":"<opt>"}]}.',
    '',
    'Games:',
    ...lines,
  ].join('\n');
}

async function callGemini(model, prompt, grounded) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 },
  };
  if (grounded) body.tools = [{ google_search: {} }];
  else body.generationConfig.responseMimeType = 'application/json';

  const t0 = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GKEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ms = Date.now() - t0;
  const json = await res.json();
  if (!res.ok) return { ok: false, ms, err: JSON.stringify(json).slice(0, 300) };

  const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const u = json.usageMetadata || {};
  let parsed = null;
  try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim()); } catch { /* leave null */ }
  return { ok: true, ms, text, parsed, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0 };
}

async function runTier(name, list, batchSize, grounded) {
  const m = MODELS[name];
  const batches = chunk(list, batchSize);
  let inTok = 0, outTok = 0, ms = 0, got = 0, miss = 0, failCalls = 0, groundedCalls = 0;
  const prices = [];
  for (const b of batches) {
    const r = await callGemini(m.id, buildPrompt(b), grounded);
    if (!r.ok) { failCalls++; console.log(`   ! call failed: ${r.err}`); continue; }
    ms += r.ms; inTok += r.inTok; outTok += r.outTok; if (grounded) groundedCalls++;
    const rows = r.parsed?.prices || [];
    for (const g of b) {
      const hit = rows.find(x => String(x.ref) === String(g.external_id));
      if (hit && hit.price_usd != null) { got++; prices.push({ ref: g.external_id, price: hit.price_usd }); }
      else miss++;
    }
  }
  const cost = (inTok / 1e6) * m.in + (outTok / 1e6) * m.out + groundedCalls * GROUNDING_PER_REQ;
  return { name, id: m.id, grounded, games: list.length, batches: batches.length, batchSize,
    priced: got, missing: miss, failCalls, inTok, outTok, ms, cost, prices };
}

function report(runs) {
  console.log('\n=== AI-827 POC RESULTS ===');
  for (const r of runs) {
    const rate = r.games ? ((r.priced / r.games) * 100).toFixed(0) : '0';
    console.log(
      `\n${r.name} (${r.id})  grounded=${r.grounded}\n` +
      `  games ${r.games} in ${r.batches} batches of ${r.batchSize}\n` +
      `  priced ${r.priced}/${r.games} (${rate}%)  missing ${r.missing}  failed-calls ${r.failCalls}\n` +
      `  tokens in/out ${r.inTok}/${r.outTok}  time ${(r.ms / 1000).toFixed(1)}s  cost $${r.cost.toFixed(4)}\n` +
      `  -> full remaining slate (~840): ~$${(r.cost / r.games * 840).toFixed(2)}, ~${(r.ms / r.games * 840 / 1000 / 60).toFixed(1)} min`);
  }
}

(async () => {
  const limit = Number(flag('--limit', 12));
  const batch = Number(flag('--batch', 6));
  const windowDays = flag('--window') ? Number(flag('--window')) : null;
  const grounded = has('--grounded');

  if (has('--bulk')) {
    const n = Number(flag('--bulk', 300));
    const list = await games(n, windowDays);
    console.log(`BULK test: ${list.length} games in ONE call (flash, grounded=${grounded})...`);
    const r = await callGemini(MODELS.flash.id, buildPrompt(list), grounded);
    if (!r.ok) return console.log(`  failed: ${r.err}`);
    const priced = (r.parsed?.prices || []).filter(x => x.price_usd != null).length;
    console.log(`  returned ${r.parsed?.prices?.length ?? 'UNPARSEABLE'} rows, ${priced} priced, ${r.inTok}/${r.outTok} tok, ${(r.ms / 1000).toFixed(1)}s`);
    return;
  }

  const list = await games(limit, windowDays);
  console.log(`Loaded ${list.length} eligible games (limit ${limit}${windowDays ? `, window ${windowDays}d` : ''}).`);
  const tiers = has('--compare') ? ['flash-lite', 'flash', 'pro'] : [flag('--model', 'flash')];
  const runs = [];
  for (const t of tiers) { console.log(`\nRunning ${t}...`); runs.push(await runTier(t, list, batch, grounded)); }
  report(runs);
})().catch(e => { console.error(e); process.exit(1); });
