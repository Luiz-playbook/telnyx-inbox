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

import { PRICE_MODEL, PRICE_IN_COST, PRICE_OUT_COST, GROUNDING_PER_REQ, callGeminiPrices } from '../lib/price.js';

export const config = { maxDuration: 300 };

const MODEL = PRICE_MODEL;
const IN_COST = PRICE_IN_COST, OUT_COST = PRICE_OUT_COST;
const BATCH = 6;

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// one grounded pass over the batches; returns priced rows + which batches came back empty
async function pricePass(gkey, batches, acc) {
  const priced = [];
  const failedBatches = [];
  for (const b of batches) {
    const r = await callGeminiPrices(gkey, b);
    if (!r.ok) { failedBatches.push(b); continue; }
    acc.inTok += r.inTok; acc.outTok += r.outTok; acc.groundedCalls++;
    priced.push(...r.priced);
    if (r.priced.length === 0) failedBatches.push(b); // whole-batch miss -> retry candidate
  }
  return { priced, failedBatches };
}

export default async function handler(req, res) {
  // Dedicated secret for the price/schedule crons, isolated from the shared CRON_SECRET so
  // enabling these never wakes the other crons. Accepted via ?token= (Vercel delivers it in
  // the cron path) or Bearer header. Unset => endpoint open; the cooldown below caps cost.
  const priceSecret = process.env.PRICE_CRON_SECRET;
  const tokenOk = priceSecret && (req.query?.token === priceSecret || req.headers.authorization === `Bearer ${priceSecret}`);
  if (priceSecret && !tokenOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const gkey = (process.env.GEMINI_API_KEY || '').trim();
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!gkey || !supaUrl || !supaKey) { res.status(500).json({ error: 'GEMINI_API_KEY / SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };

  const dry = req.query?.dry === '1' || req.query?.dry === 'true' || (req.body && req.body.dry === true);
  const force = req.query?.force === '1' || req.query?.force === 'true';
  const started = Date.now();

  try {
    // open-endpoint safety: skip if a real run happened < 6h ago (unless forced/dry)
    const COOLDOWN_H = 6;
    if (!dry && !force) {
      const lr = await fetch(`${supaUrl}/rest/v1/events_master_price_runs?dry_run=eq.false&order=started_at.desc&limit=1&select=started_at`, { headers: sh }).then(r => r.json()).catch(() => []);
      const last = Array.isArray(lr) && lr[0]?.started_at ? new Date(lr[0].started_at).getTime() : 0;
      if (last && (Date.now() - last) < COOLDOWN_H * 3600e3) {
        res.status(200).json({ ok: true, skipped: 'cooldown', last_run: lr[0].started_at, cooldown_h: COOLDOWN_H }); return;
      }
    }
    // tunable knobs (tiered staleness: near-term games decay fast -> shorter freshness window)
    const rulesR = await fetch(`${supaUrl}/rest/v1/decider_rules?id=eq.1&select=price_window_days,price_skip_below,price_stale_hours,price_stale_hours_near,price_near_days`, { headers: sh });
    const rules = (await rulesR.json())[0] || { price_window_days: 20, price_skip_below: 15, price_stale_hours: 48, price_stale_hours_near: 12, price_near_days: 3 };

    // eligibility: games the decider says to 'send' (market/cooldown/window rules applied there)
    const recR = await fetch(`${supaUrl}/rest/v1/rpc/rpc_event_recommendations`, { method: 'POST', headers: sh, body: '{}' });
    const recs = await recR.json();
    if (!recR.ok || !Array.isArray(recs)) { res.status(502).json({ error: 'recommendations fetch failed', detail: recs }); return; }
    const sendIds = recs.filter(r => r.decision === 'send').map(r => r.event_id);
    if (!sendIds.length) { res.status(200).json({ ok: true, eligible: 0, note: 'no send-eligible games' }); return; }

    // pull those events, narrow to the price window + skip rule (cheap games locked in / fresh prices kept)
    const nearCut = new Date(Date.now() - rules.price_stale_hours_near * 3600e3).toISOString();
    const farCut = new Date(Date.now() - rules.price_stale_hours * 3600e3).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const winCut = new Date(Date.now() + rules.price_window_days * 864e5).toISOString().slice(0, 10);
    const idList = `(${sendIds.map(id => `"${id}"`).join(',')})`;
    const evR = await fetch(
      `${supaUrl}/rest/v1/events_master?id=in.${idList}&event_date=lte.${winCut}` +
      `&select=id,external_id,league,team,opponent,event_date,venue,best_price,priced_at`, { headers: sh });
    let games = await evR.json();
    if (!Array.isArray(games)) { res.status(502).json({ error: 'events fetch failed', detail: games }); return; }

    const eligibleTotal = games.length;
    games = games.filter(g => {
      if (g.best_price != null && Number(g.best_price) < Number(rules.price_skip_below)) return false; // locked-in cheap
      // tiered freshness: near-term games use the short window, far games the long one
      const daysUntil = Math.round((new Date(g.event_date) - new Date(today)) / 864e5);
      const cut = daysUntil <= rules.price_near_days ? nearCut : farCut;
      if (g.best_price != null && g.priced_at && g.priced_at > cut) return false;                       // still fresh for its tier
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

    // Every league present, not just MLB. The old call passed p_league:'mlb' into a function
    // that filters `where league = p_league`, so an NFL or NHL price was paid for and then
    // discarded — priced would count it, written never would. The one-argument overload
    // (migration 038) matches on external_id, which is globally unique, and takes the league
    // from the row it updates.
    let written = 0, writeError = null;
    if (!dry && priceRows.length) {
      const wR = await fetch(`${supaUrl}/rest/v1/rpc/set_event_prices`, {
        method: 'POST', headers: sh, body: JSON.stringify({ p_rows: priceRows }) });
      const wBody = await wR.json().catch(() => null);
      if (!wR.ok) { writeError = (wBody && (wBody.message || wBody.error)) || `write failed (HTTP ${wR.status})`; }
      else { written = Number(wBody) || 0; }
    }

    // Which leagues this run actually touched — makes a league silently failing to write
    // visible instead of hiding inside a single total.
    const leagueOf = new Map(games.map(g => [g.external_id, g.league]));
    const byLeague = {};
    for (const row of priceRows) {
      const lg = leagueOf.get(row.external_id) || 'unknown';
      byLeague[lg] = (byLeague[lg] || 0) + 1;
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

    // ok:false when prices were found but could not be stored — the caller must not report a
    // run that cost money and changed nothing as a success.
    res.status(200).json({ ok: !writeError, dry, written, by_league: byLeague, write_error: writeError || undefined, ...runLog });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
