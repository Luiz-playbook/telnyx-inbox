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
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.js),
//      optional CRON_SECRET/REPLY_SECRET.

import { PRICE_MODEL, PRICE_IN_COST, PRICE_OUT_COST, GROUNDING_PER_REQ, callGeminiPrices } from '../lib/price.js';
import { supabaseKey } from '../lib/supabase.js';

export const config = { maxDuration: 300 };

const MODEL = PRICE_MODEL;
const IN_COST = PRICE_IN_COST, OUT_COST = PRICE_OUT_COST;
const BATCH = 6;

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// How many grounded calls are in flight at once. Batches used to run strictly one after
// another, which made the wall clock the SUM of Gemini's latencies — and that latency is wildly
// variable: 27 games took 57s on one run and 240s on the next. A full 22-batch refresh
// therefore overran Vercel's ceiling and returned 504, losing every price already paid for.
const CONCURRENCY = 5;

// One grounded pass over the batches; returns priced rows, batches that came back empty, and
// any that were never attempted because the deadline arrived. Nothing is thrown on timeout:
// a partial result that gets written beats a 504 that discards work already billed for.
async function pricePass(gkey, batches, acc, deadline) {
  const priced = [], failedBatches = [], skipped = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= batches.length) return;
      const b = batches[idx];
      if (Date.now() > deadline) { skipped.push(b); continue; }   // drain, don't start
      const r = await callGeminiPrices(gkey, b);
      if (!r.ok) { failedBatches.push(b); continue; }
      acc.inTok += r.inTok; acc.outTok += r.outTok; acc.groundedCalls++;
      priced.push(...r.priced);
      if (r.priced.length === 0) failedBatches.push(b); // whole-batch miss -> retry candidate
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return { priced, failedBatches, skipped };
}

export default async function handler(req, res) {
  // Dedicated secret for the price/schedule crons, isolated from the shared CRON_SECRET so
  // enabling these never wakes the other crons. Accepted via ?token= (Vercel delivers it in
  // the cron path) or Bearer header. Unset => endpoint open; the cooldown below caps cost.
  const priceSecret = process.env.PRICE_CRON_SECRET;
  const tokenOk = priceSecret && (req.query?.token === priceSecret || req.headers.authorization === `Bearer ${priceSecret}`);
  if (priceSecret && !tokenOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const gkey = (process.env.GEMINI_API_KEY || '').trim();
  const supaUrl = process.env.SUPABASE_URL, supaKey = supabaseKey();
  if (!gkey || !supaUrl || !supaKey) { res.status(500).json({ error: 'GEMINI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
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
      // status=eq.scheduled: never pay the model to look up a price for a cancelled or postponed
      // game (migration 053). The decider already skips them, but this endpoint spends money and
      // should not depend on an upstream filter staying correct to avoid spending it.
      `${supaUrl}/rest/v1/events_master?id=in.${idList}&event_date=lte.${winCut}&status=eq.scheduled` +
      // team_full feeds the SeatGeek /<team>-tickets fallback slug — "guardians" is not one.
      `&select=id,external_id,league,team,team_full,opponent,event_date,venue,state_code,best_price,priced_at,price_url`, { headers: sh });
    let games = await evR.json();
    if (!Array.isArray(games)) { res.status(502).json({ error: 'events fetch failed', detail: games }); return; }

    const eligibleTotal = games.length;
    // force = "reprice everything eligible", which is what the Refresh prices button means to
    // an operator: they pressed refresh, they expect a refresh, not a subset. The per-game
    // freshness and cheap-price skips exist to keep the CRON cheap; a human who has been shown
    // the game count and the estimated cost and said yes has already answered that question.
    games = force ? games : games.filter(g => {
      // Locked-in cheap: a game already under the floor is not repriced, because the price is
      // as good as it gets. But that rule also meant a cheap game priced before listing URLs
      // were captured could NEVER acquire one — it is skipped by every future run forever, so
      // its price stays permanently unverifiable. Let a cheap game through exactly while it
      // has no url; once the run gives it one, the skip applies again. The freshness check
      // below still bounds the retry to one attempt per staleness window.
      if (g.best_price != null && Number(g.best_price) < Number(rules.price_skip_below) && g.price_url) return false;
      // tiered freshness: near-term games use the short window, far games the long one
      const daysUntil = Math.round((new Date(g.event_date) - new Date(today)) / 864e5);
      const cut = daysUntil <= rules.price_near_days ? nearCut : farCut;
      if (g.best_price != null && g.priced_at && g.priced_at > cut) return false;                       // still fresh for its tier
      return true;
    });
    const limit = Number(req.query?.limit || 0);
    if (limit > 0) games = games.slice(0, limit);

    // ?estimate=1 — how much would a full refresh cost? Answers WITHOUT calling the model, so
    // the confirm dialog can state the real number of games and a real price before anyone
    // commits to spending. Free, and nothing is written or logged.
    if (req.query?.estimate === '1' || req.query?.estimate === 'true') {
      const wouldPrice = games.length;   // already narrowed above, or not, per `force`
      const batchCount = Math.ceil(wouldPrice / BATCH);
      res.status(200).json({
        ok: true, estimate: true, eligible: eligibleTotal, would_price: wouldPrice,
        batches: batchCount, est_cost_usd: Number((batchCount * GROUNDING_PER_REQ).toFixed(4)),
        window_days: Number(rules.price_window_days),   // so the UI never hardcodes the horizon
      });
      return;
    }

    const acc = { inTok: 0, outTok: 0, groundedCalls: 0 };
    const batches = chunk(games, BATCH);

    // Stop starting new work with enough margin to still write, log and respond inside the
    // platform's 300s ceiling. Overrunning it returns 504 and loses every price already paid
    // for, which is strictly worse than a smaller batch of prices that actually lands.
    const BUDGET_MS = 200e3;
    const deadline = started + BUDGET_MS;

    // pass 1, then one retry pass over the batches that came back empty
    const p1 = await pricePass(gkey, batches, acc, deadline);
    let retriedBatches = 0;
    let allPriced = p1.priced;
    let skippedBatches = p1.skipped.length;
    // Only retry if there is real time left — a retry that overruns costs the whole run.
    if (p1.failedBatches.length && Date.now() < deadline - 30e3) {
      retriedBatches = p1.failedBatches.length;
      const p2 = await pricePass(gkey, p1.failedBatches, acc, deadline);
      allPriced = allPriced.concat(p2.priced);
      skippedBatches += p2.skipped.length;
    }

    // dedupe (a game could be priced in pass 1 and again in a retry batch)
    const byId = new Map(allPriced.map(r => [r.external_id, r]));
    // A price nobody can check is not worth storing: the Cheapest cell exists so an operator can
    // click through and confirm the number before a blast quotes it. A price with no listing URL
    // is unverifiable, so it is dropped rather than shown as fact. This does cost coverage —
    // the model returns a usable link for roughly 60% of the games it prices — so the count is
    // reported as `unverified` rather than hidden.
    const all = [...byId.values()];
    const priceRows = all.filter(r => r.url);
    const unverified = all.length - priceRows.length;

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
      priced: priceRows.length, missing: games.length - priceRows.length,   // includes the unverified drops
      batches: batches.length, retried_batches: retriedBatches,
      in_tokens: acc.inTok, out_tokens: acc.outTok, cost_usd: Number(cost.toFixed(4)),
      duration_ms: durationMs, dry_run: dry,
    };
    if (!dry) await fetch(`${supaUrl}/rest/v1/rpc/record_price_run`, { method: 'POST', headers: sh, body: JSON.stringify({ p: runLog }) }).catch(() => {});

    // ok:false when prices were found but could not be stored — the caller must not report a
    // run that cost money and changed nothing as a success.
    res.status(200).json({
      ok: !writeError, dry, written, by_league: byLeague, unverified,
      // Games left unpriced because time ran out — the caller can just run again to pick them up.
      timed_out: skippedBatches > 0 || undefined,
      not_reached: skippedBatches ? skippedBatches * BATCH : undefined,
      write_error: writeError || undefined, ...runLog,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
