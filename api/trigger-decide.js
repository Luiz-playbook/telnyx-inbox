// Trigger Blast decider (rules + LLM re-rank/veto).
//
// The deterministic engine (rpc_event_recommendations) is the SAFETY FLOOR: cooldown,
// forward window, fill %, opt-out health, and "has history" are enforced in SQL and the
// LLM can NEVER override them. This endpoint takes the rule-approved decision='send'
// candidates, asks the LLM to choose the best `cap` to blast now (re-rank) and optionally
// veto weak ones with a written reason, then enforces server-side that every returned
// event_id came from the approved set. It does NOT enqueue — the browser does that via
// queue_enqueue_test / log_market_blast so nothing here can send.
//
// Auth: lib/auth.js — Bearer CRON_SECRET (cron, VPS) or a signed-in user's Supabase token.
// Env: OPENAI_API_KEY (+ optional OPENAI_MODEL), SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.js).
//
// MULTI-DAY / ADDITIVE (Josh, 2026-07-28). Body {per_day, through} schedules blasts across
// a window instead of dumping them all on today: `per_day` markets for every day from today
// through `through` (default 4/day for 4 days = 16 in the queue). What the queue ALREADY
// holds is read first, so a re-run only fills the gaps — same input never produces a second
// copy of the same market, and days that are already full are left alone. Each pick carries
// a `slot_date`; the browser enqueues it at that date (queue_enqueue_test also de-dupes
// server-side, migration 030). Legacy body {cap} with no `through` keeps the old
// everything-today behaviour.

import { supabaseKey } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';

export const config = { maxDuration: 30 };

const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();

const SYSTEM = [
  'You are the send-decider for Playbook\'s ticket-marketing blasts. You are given a list of markets that have ALREADY passed every hard rule (cooldown, forward-looking window, fill %, opt-out health, has prior history) — so every candidate is safe to send. Your job is to choose which ones to actually blast right now, and in what order, to maximize return.',
  'Rank the strongest opportunities first. Prefer markets with proven historical performance (higher open / click rates over more prior blasts), lower current fill % (more seats to move), and a healthy opt-out rate. A game that is closer (fewer days until) is more urgent. You MAY veto a candidate you think is a poor use of a send right now — but only from the given list.',
  'HARD CONSTRAINTS: never invent an event_id — only use ones provided. Never add a market that is not in the candidate list. Cite the concrete numbers you were given in each one-sentence reason (e.g. "18% open / 8% CTR over 3 blasts, only 20% filled"). Return picks best-first.',
  'Each market splits into three audience segments — ICP, SCP and Other — and each one you choose becomes its own blast with its own copy and its own recipients. ICP IS THE PRIMARY TARGET: always include it when it has recipients, and never drop it in favour of the other two. Consider all three on every pick, and include SCP and Other when their reach makes them worth a separate send. Exclude a segment only when it has no recipients or you can say why it is a poor send; you are given each segment\'s email and SMS reach to judge that.',
  'You may also be given RECENTLY REJECTED blasts: ones a human operator refused to send, sometimes with a written reason. Those exact games are already filtered out of your candidate list, so you do not need to avoid them — read them for the PATTERN. If the operator keeps refusing a kind of matchup, a market, or a price point, weight similar candidates down and say so in your reason. Treat a written reason as a stronger signal than a bare rejection.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          reason: { type: 'string' },
          // Which audience slices of this market to blast. The server re-checks every entry
          // against real reach and forces ICP back in, so a bad answer here cannot lose a send.
          segments: { type: 'array', items: { type: 'string', enum: ['ICP', 'SCP', 'Other'] } },
        },
        required: ['event_id', 'reason', 'segments'],
        additionalProperties: false,
      },
    },
    vetoed: {
      type: 'array',
      items: {
        type: 'object',
        properties: { event_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['event_id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks', 'vetoed'],
  additionalProperties: false,
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MAX_DAYS = 14;      // widest window a single trigger may schedule
const MAX_PICKS = 40;     // hard ceiling on rows one run can add

// How far back a rejection still counts. Josh, 2026-07-31: "whenever you run trigger blast,
// I'd probably pull all deletions from the last 21 days".
const REJECT_DAYS = 21;

const dayStr = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return dayStr(d); };

// today .. through (inclusive), clamped to MAX_DAYS. Bad/past `through` = today only.
function windowDays(through) {
  const start = dayStr(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(through || ''))) return [start];
  const days = [];
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = addDays(start, i);
    days.push(d);
    if (d >= through) break;
  }
  return days;
}

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  const supaUrl = process.env.SUPABASE_URL, supaKey = supabaseKey();
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }

  const through = req.body?.through || null;
  const days = windowDays(through);
  const perDay = through
    ? Math.max(1, Math.min(10, Number(req.body?.per_day) || 4))
    : Math.max(1, Math.min(10, Number(req.body?.cap) || 3));   // legacy: cap == one day's worth

  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };
  const rpc = (fn, body) => fetch(`${supaUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sh, body: JSON.stringify(body || {}) });

  try {
    const [recRes, cntRes, qRes, rjRes, segRes] = await Promise.all([
      rpc('rpc_event_recommendations'), rpc('market_recipient_counts'), rpc('get_campaign_queue'),
      rpc('queue_rejections', { p_days: REJECT_DAYS }),
      rpc('market_recipient_counts_by_segment'),
    ]);
    const recs = await recRes.json();
    const counts = await cntRes.json().catch(() => []);
    const queue = await qRes.json().catch(() => []);
    // Missing on a deployment that has not run migration 048 yet — an empty rejection list is
    // the old behaviour, so this degrades to it rather than failing the run.
    const rejections = rjRes.ok ? await rjRes.json().catch(() => []) : [];
    // Missing until migration 050 is applied. An empty map means every segment reports zero
    // reach, and the fallback below turns that into a single segment-less row per event —
    // exactly the pre-segment behaviour, rather than a run that produces nothing.
    const segCounts = segRes.ok ? await segRes.json().catch(() => []) : [];
    if (!recRes.ok || !Array.isArray(recs)) { res.status(502).json({ error: 'recommendations fetch failed', detail: recs }); return; }

    // What the queue already holds. Live = anything not already sent; those slots are taken
    // and their events/markets must not be picked again, or the trigger duplicates itself.
    //
    // REJECTED IS NOT LIVE (migration 048). A blast the operator refused must give its day slot
    // and its market back — otherwise every rejection permanently burns a slot and the queue
    // starves itself. What a rejection holds instead is the (event, segment) block below, which
    // is a different thing and outlives the row's presence in the queue.
    const live = (Array.isArray(queue) ? queue : [])
      .filter(r => r.status !== 'sent' && r.status !== 'sending' && r.status !== 'rejected');
    const takenEvents = new Set(live.map(r => String(r.event_id || '')).filter(Boolean));
    const takenMarkets = new Set(live.map(r => String(r.state_code || '').toUpperCase()).filter(Boolean));
    // A day's capacity is counted in EVENTS, not rows. One event is up to three queue rows
    // (ICP / SCP / Other), so counting rows would let three segments of one game fill a whole
    // day meant for four different games. Distinct event_id per day is the same number in the
    // pre-segment world, where every event has exactly one row.
    const filled = {};                                  // slot_date -> distinct live events that day
    const seenPerDay = {};
    live.forEach(r => {
      const d = String(r.scheduled_for || '').slice(0, 10);
      const ev = String(r.event_id || r.id || '');
      (seenPerDay[d] = seenPerDay[d] || new Set()).add(ev);
      filled[d] = seenPerDay[d].size;
    });

    // Rejections. Keyed on event AND segment: refusing the SCP row for a fixture says something
    // about SCP, not about the fixture, so ICP for that same game stays pickable. A rejection
    // carrying no segment (every row queued before 048) blocks the event outright — that is the
    // honest reading of a refusal that was never segment-scoped.
    const rejectedPairs = new Set();     // `${event_id}|${segment}`
    const rejectedEvents = new Set();    // segment-less rejections — block the whole event
    (Array.isArray(rejections) ? rejections : []).forEach(r => {
      const ev = String(r.event_id || '');
      if (!ev) return;
      if (r.segment) rejectedPairs.add(`${ev}|${r.segment}`);
      else rejectedEvents.add(ev);
    });

    // What the model is shown. Ids mean nothing to it, so this carries only what a human wrote
    // or would recognise — and above all the reason, which is the part that generalises beyond
    // the one fixture already filtered out of the candidate list.
    const rejectContext = (Array.isArray(rejections) ? rejections : []).map(r => ({
      game: [r.team, r.opponent].filter(Boolean).join(' vs ') || r.title || null,
      market: r.state_code || null,
      segment: r.segment || null,
      event_date: r.event_date || null,
      reason: r.note || null,
      rejected_at: String(r.rejected_at || '').slice(0, 10),
    }));

    // Per-day gaps: only the shortfall gets filled, so a full day is never touched again.
    const plan = days.map(d => {
      const existing = filled[d] || 0;
      return { date: d, existing, need: Math.max(0, perDay - existing), added: 0 };
    });
    const need = Math.min(MAX_PICKS, plan.reduce((s, p) => s + p.need, 0));

    const reach = {};
    (Array.isArray(counts) ? counts : []).forEach(m => { reach[m.market_key] = m; });

    // market_key -> { ICP: {phone,email}, SCP: …, Other: … }. A segment absent here has no
    // contactable people in that market and must never become a queued blast.
    const SEGMENTS = ['ICP', 'SCP', 'Other'];
    const segReach = {};
    (Array.isArray(segCounts) ? segCounts : []).forEach(m => {
      const phone = Number(m.phone_count) || 0, email = Number(m.email_count) || 0;
      if (!phone && !email) return;
      (segReach[m.market_key] = segReach[m.market_key] || {})[m.segment] = { phone, email };
    });

    // rule-approved candidates (the safety floor already applied in SQL), in rank order.
    // Anything already sitting in the queue is dropped here — that's the additive rule.
    // One test, whatever the candidate is scoped to. Passing segment = null (what a candidate
    // carries today, before the per-segment queue lands) checks only the segment-less
    // rejections; once candidates are event × segment the same call starts honouring pairs.
    const isRejected = (eventId, segment) =>
      rejectedEvents.has(String(eventId)) || (!!segment && rejectedPairs.has(`${eventId}|${segment}`));

    const alreadyQueued = [], wasRejected = [];
    const approved = recs.filter(r => r.decision === 'send').filter(r => {
      const code = String((reach[r.market_key] || {}).state_code || '').toUpperCase();
      // Checked before the duplicate test so a refused game is reported as refused, not as
      // "already queued" — the operator needs to see their own decision reflected back.
      if (isRejected(r.event_id, r.segment || null)) {
        wasRejected.push({ event_id: r.event_id, market_label: r.market_label, segment: r.segment || null });
        return false;
      }
      const dup = takenEvents.has(String(r.event_id)) || (code && takenMarkets.has(code));
      if (dup) alreadyQueued.push({ event_id: r.event_id, market_label: r.market_label });
      return !dup;
    });
    const candidates = approved.map(r => {
      const rc = reach[r.market_key] || {};
      return {
        event_id: r.event_id, team: r.team, market_key: r.market_key, market_label: r.market_label,
        state_code: rc.state_code || null,
        filled_pct: r.filled_pct, days_until: r.days_until, n_blasts: r.n_blasts,
        open_rate_w: r.open_rate_w, ctr_w: r.ctr_w, unsub_rate: r.unsub_rate,
        best_template: r.best_template, best_dow: r.best_dow != null ? DOW[r.best_dow] : null,
        phone_count: Number(rc.phone_count) || 0, email_count: Number(rc.email_count) || 0,
        seg_reach: segReach[r.market_key] || {},
      };
    });

    // held-back breakdown for the summary
    const skipBy = {};
    recs.filter(r => r.decision !== 'send').forEach(r => { const k = r.reason_code || 'other'; skipBy[k] = (skipBy[k] || 0) + 1; });

    const byId = Object.fromEntries(candidates.map(c => [String(c.event_id), c]));

    let picks = [], vetoed = [], llm = false;
    const key = (process.env.OPENAI_API_KEY || '').trim();

    if (key && candidates.length && need) {
      try {
        const payload = candidates.map(c => ({
          event_id: c.event_id, team: c.team, market: c.market_label,
          filled_pct: c.filled_pct, days_until: c.days_until, n_blasts: c.n_blasts,
          open_rate: c.open_rate_w, ctr: c.ctr_w, unsub_rate: c.unsub_rate,
          best_template: c.best_template, best_weekday: c.best_dow,
          email_recipients: c.email_count, sms_recipients: c.phone_count,
          // Per-segment reach, so "is SCP worth its own blast here" is an answerable question
          // rather than a guess. Segments missing from this object have nobody to send to.
          segment_reach: c.seg_reach,
        }));
        const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: MODEL, max_tokens: 2000,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: `Choose up to ${need} markets to blast across the next ${days.length} day(s) — ${perDay} per day, best-first. Candidates:\n`
                + JSON.stringify(payload)
                // Capped: this is context, not the task, and a long tail of stale refusals
                // would crowd out the candidates it is meant to inform. Newest first out of
                // queue_rejections, so the cut drops the least current ones.
                + (rejectContext.length
                    ? `\n\nRecently rejected by the operator (last ${REJECT_DAYS} days) — read for pattern:\n` + JSON.stringify(rejectContext.slice(0, 25))
                    : '') },
            ],
            response_format: { type: 'json_schema', json_schema: { name: 'trigger_decision', strict: true, schema: SCHEMA } },
          }),
        });
        const ai = await aiRes.json();
        if (aiRes.ok) {
          const out = JSON.parse(ai.choices?.[0]?.message?.content || '{}');
          // enforce: only event_ids from the approved set survive
          const seen = new Set();
          (out.picks || []).forEach(p => {
            const c = byId[String(p.event_id)];
            if (c && !seen.has(String(p.event_id))) { seen.add(String(p.event_id)); picks.push({ ...c, reason: p.reason || null, segments: Array.isArray(p.segments) ? p.segments : null }); }
          });
          (out.vetoed || []).forEach(v => {
            const c = byId[String(v.event_id)];
            if (c) vetoed.push({ event_id: c.event_id, market_label: c.market_label, reason: v.reason || null });
          });
          llm = true;
        }
      } catch { /* fall through to rule order */ }
    }

    // fallback / backfill: if the LLM didn't run or under-picked, top up from rule order
    if (!picks.length) {
      picks = candidates.map(c => ({ ...c, reason: null }));
    } else if (picks.length < need) {
      const have = new Set(picks.map(p => String(p.event_id)));
      const vetoedIds = new Set(vetoed.map(v => String(v.event_id)));
      for (const c of candidates) {
        if (picks.length >= need) break;
        const id = String(c.event_id);
        if (!have.has(id) && !vetoedIds.has(id)) { picks.push({ ...c, reason: null }); have.add(id); }
      }
    }
    picks = picks.slice(0, need);

    // Spread the picks over the window: fill each day up to its gap, one market per market
    // per window (a second game in a market the same week is a duplicate blast, not a pick).
    const usedMarkets = new Set();
    const scheduled = [];
    let di = 0;
    for (const p of picks) {
      const mk = String(p.market_key || p.event_id);
      if (usedMarkets.has(mk)) continue;
      while (di < plan.length && plan[di].added >= plan[di].need) di++;
      if (di >= plan.length) break;                 // window full — the rest waits for the next run

      // One event becomes up to three blasts, one per audience segment. The model's answer is a
      // SUGGESTION that is re-checked here, because the cost of the two mistakes is not
      // symmetric: a segment with no recipients is dropped whatever it said, and ICP is put back
      // whenever it has reach. ICP is the primary target — losing it to a bad model answer is
      // the one failure worth engineering against. A segment already refused for this event
      // stays refused.
      const available = SEGMENTS.filter(s => p.seg_reach && p.seg_reach[s]);
      const asked = Array.isArray(p.segments) && p.segments.length ? p.segments : available;
      let segs = available.filter(s => asked.includes(s));
      if (available.includes('ICP') && !segs.includes('ICP')) segs.unshift('ICP');
      segs = segs.filter(s => !isRejected(p.event_id, s));

      // No segmented reach at all (migration 050 not applied, or a market whose contacts carry
      // no segment) falls back to ONE segment-less row — the pre-segment behaviour, which still
      // sends. An event whose every segment is refused or unreachable is skipped entirely, and
      // must not consume a day slot on the way out.
      const rows = available.length ? segs : [null];
      if (!rows.length) continue;

      usedMarkets.add(mk);
      plan[di].added++;                             // a day holds EVENTS, not rows
      rows.forEach(s => scheduled.push({
        ...p,
        segment: s,
        phone_count: s ? p.seg_reach[s].phone : p.phone_count,
        email_count: s ? p.seg_reach[s].email : p.email_count,
        slot_date: plan[di].date,
      }));
    }
    picks = scheduled;

    res.status(200).json({
      ok: true, evaluated: recs.length, llm, candidates: candidates.length,
      per_day: perDay, through: days[days.length - 1], days: days.length,
      cap: need, need, plan, already_queued: alreadyQueued,
      // Held back because the operator refused them, as distinct from held back by a rule.
      // Reported separately so the Trigger Blast summary can say which is which.
      rejected_held: wasRejected, rejections_considered: rejectContext.length,
      picks, vetoed, skipBy,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
