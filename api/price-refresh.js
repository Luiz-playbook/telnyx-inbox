// AI-828: price refresh job. ~72h cadence (Vercel Cron), tunable.
//
// Fills events_master.best_price for games worth pricing, then logs cost + duration so
// the cadence can be tuned. Eligibility is DELEGATED to rpc_event_recommendations(),
// which already encodes market suppression / cooldown / forward-window / fill rules —
// we simply price the games it says to 'send', narrowed to the price window + skip rule.
//
// Pricing = Gemini flash-lite, grounded (google_search), batch 6, one retry pass over
// whole failed batches (the POC showed failures are call-level, not per-game).
//
// Runs two ways (same auth as decide.js):
//   • Vercel Cron    — Authorization: Bearer CRON_SECRET
//   • On-demand UI   — x-inbox-secret: REPLY_SECRET
// Flags: ?dry=1 (price but don't write), ?limit=N (cap games this run).
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, optional CRON_SECRET/REPLY_SECRET.

export const config = { maxDuration: 300 };

const MODEL = 'gemini-2.5-flash-lite';
const IN_COST = 0.10 / 1e6, OUT_COST = 0.40 / 1e6, GROUNDING_PER_REQ = 0.035; // approx, verify
const BATCH = 6;

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function buildPrompt(batch) {
  const lines = batch.map(g =>
    `- ref=${g.external_id}: on ${g.event_date}, the ${g.team} host the ${g.opponent} at ${g.venue || 'their venue'}`);
  return [
    'You look up CURRENT resale ticket prices for specific MLB games. For each game below,',
    'find the lowest available "get-in" price per ticket in USD on the secondary market',
    '(StubHub / SeatGeek / Ticketmaster resale). Use web search. Do NOT guess: if you cannot',
    'find a price, return price_usd = null. Return ONLY JSON of shape',
    '{"prices":[{"ref":"<ref>","price_usd":<number|null>,"source":"<site>"}]}.',
    '', 'Games:', ...lines,
  ].join('\n');
}

async function callGemini(gkey, prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 },
    tools: [{ google_search: {} }],
  };
  const t0 = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${gkey}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ms = Date.now() - t0;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, ms };
  const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const u = json.usageMetadata || {};
  let parsed = null;
  try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim()); } catch { /* null */ }
  return { ok: true, ms, parsed, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0 };
}

// one grounded pass over the batches; returns priced rows + which batches came back empty
async function pricePass(gkey, batches, acc) {
  const priced = [];
  const failedBatches = [];
  for (const b of batches) {
    const r = await callGemini(gkey, buildPrompt(b));
    if (!r.ok) { failedBatches.push(b); continue; }
    acc.inTok += r.inTok; acc.outTok += r.outTok; acc.groundedCalls++;
    const rows = r.parsed?.prices || [];
    let hitInBatch = 0;
    for (const g of b) {
      const hit = rows.find(x => String(x.ref) === String(g.external_id));
      if (hit && hit.price_usd != null) {
        priced.push({ external_id: g.external_id, price_usd: hit.price_usd, source: hit.source || 'gemini' });
        hitInBatch++;
      }
    }
    if (hitInBatch === 0) failedBatches.push(b); // whole-batch miss -> retry candidate
  }
  return { priced, failedBatches };
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET, replySecret = process.env.REPLY_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const inboxOk = replySecret && req.headers['x-inbox-secret'] === replySecret;
  if ((cronSecret || replySecret) && !bearerOk && !inboxOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const gkey = (process.env.GEMINI_API_KEY || '').trim();
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!gkey || !supaUrl || !supaKey) { res.status(500).json({ error: 'GEMINI_API_KEY / SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };

  const dry = req.query?.dry === '1' || req.query?.dry === 'true' || (req.body && req.body.dry === true);
  const started = Date.now();

  try {
    // tunable knobs
    const rulesR = await fetch(`${supaUrl}/rest/v1/decider_rules?id=eq.1&select=price_window_days,price_skip_below,price_stale_hours`, { headers: sh });
    const rules = (await rulesR.json())[0] || { price_window_days: 20, price_skip_below: 15, price_stale_hours: 72 };

    // eligibility: games the decider says to 'send' (market/cooldown/window rules applied there)
    const recR = await fetch(`${supaUrl}/rest/v1/rpc/rpc_event_recommendations`, { method: 'POST', headers: sh, body: '{}' });
    const recs = await recR.json();
    if (!recR.ok || !Array.isArray(recs)) { res.status(502).json({ error: 'recommendations fetch failed', detail: recs }); return; }
    const sendIds = recs.filter(r => r.decision === 'send').map(r => r.event_id);
    if (!sendIds.length) { res.status(200).json({ ok: true, eligible: 0, note: 'no send-eligible games' }); return; }

    // pull those events, narrow to the price window + skip rule (cheap games locked in / fresh prices kept)
    const staleCut = new Date(Date.now() - rules.price_stale_hours * 3600e3).toISOString();
    const winCut = new Date(Date.now() + rules.price_window_days * 864e5).toISOString().slice(0, 10);
    const idList = `(${sendIds.map(id => `"${id}"`).join(',')})`;
    const evR = await fetch(
      `${supaUrl}/rest/v1/events_master?id=in.${idList}&event_date=lte.${winCut}` +
      `&select=id,external_id,team,opponent,event_date,venue,best_price,priced_at`, { headers: sh });
    let games = await evR.json();
    if (!Array.isArray(games)) { res.status(502).json({ error: 'events fetch failed', detail: games }); return; }

    const eligibleTotal = games.length;
    games = games.filter(g => {
      if (g.best_price != null && Number(g.best_price) < Number(rules.price_skip_below)) return false; // locked-in cheap
      if (g.best_price != null && g.priced_at && g.priced_at > staleCut) return false;                 // still fresh
      return true;
    });
    const limit = Number(req.query?.limit || 0);
    if (limit > 0) games = games.slice(0, limit);

    const acc = { inTok: 0, outTok: 0, groundedCalls: 0 };
    const batches = chunk(games, BATCH);

    // pass 1, then one retry pass over the batches that came back empty
    const p1 = await pricePass(gkey, batches, acc);
    let retriedBatches = 0;
    let allPriced = p1.priced;
    if (p1.failedBatches.length) {
      retriedBatches = p1.failedBatches.length;
      const p2 = await pricePass(gkey, p1.failedBatches, acc);
      allPriced = allPriced.concat(p2.priced);
    }

    // dedupe (a game could be priced in pass 1 and again in a retry batch)
    const byId = new Map(allPriced.map(r => [r.external_id, r]));
    const priceRows = [...byId.values()];

    let written = 0;
    if (!dry && priceRows.length) {
      const wR = await fetch(`${supaUrl}/rest/v1/rpc/set_event_prices`, {
        method: 'POST', headers: sh, body: JSON.stringify({ p_league: 'mlb', p_rows: priceRows }) });
      written = await wR.json().catch(() => 0);
    }

    const cost = acc.inTok * IN_COST + acc.outTok * OUT_COST + acc.groundedCalls * GROUNDING_PER_REQ;
    const durationMs = Date.now() - started;
    const runLog = {
      model: MODEL, eligible: eligibleTotal, attempted: games.length,
      priced: priceRows.length, missing: games.length - priceRows.length,
      batches: batches.length, retried_batches: retriedBatches,
      in_tokens: acc.inTok, out_tokens: acc.outTok, cost_usd: Number(cost.toFixed(4)),
      duration_ms: durationMs, dry_run: dry,
    };
    if (!dry) await fetch(`${supaUrl}/rest/v1/rpc/record_price_run`, { method: 'POST', headers: sh, body: JSON.stringify({ p: runLog }) }).catch(() => {});

    res.status(200).json({ ok: true, dry, written, ...runLog });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
