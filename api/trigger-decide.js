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
// Auth: cron bearer (CRON_SECRET) OR UI inbox-secret (REPLY_SECRET), same as decide.js.
// Env: OPENAI_API_KEY (+ optional OPENAI_MODEL), SUPABASE_URL, SUPABASE_ANON_KEY.
//
// MULTI-DAY / ADDITIVE (Josh, 2026-07-28). Body {per_day, through} schedules blasts across
// a window instead of dumping them all on today: `per_day` markets for every day from today
// through `through` (default 4/day for 4 days = 16 in the queue). What the queue ALREADY
// holds is read first, so a re-run only fills the gaps — same input never produces a second
// copy of the same market, and days that are already full are left alone. Each pick carries
// a `slot_date`; the browser enqueues it at that date (queue_enqueue_test also de-dupes
// server-side, migration 030). Legacy body {cap} with no `through` keeps the old
// everything-today behaviour.

export const config = { maxDuration: 30 };

const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();

const SYSTEM = [
  'You are the send-decider for Playbook\'s ticket-marketing blasts. You are given a list of markets that have ALREADY passed every hard rule (cooldown, forward-looking window, fill %, opt-out health, has prior history) — so every candidate is safe to send. Your job is to choose which ones to actually blast right now, and in what order, to maximize return.',
  'Rank the strongest opportunities first. Prefer markets with proven historical performance (higher open / click rates over more prior blasts), lower current fill % (more seats to move), and a healthy opt-out rate. A game that is closer (fewer days until) is more urgent. You MAY veto a candidate you think is a poor use of a send right now — but only from the given list.',
  'HARD CONSTRAINTS: never invent an event_id — only use ones provided. Never add a market that is not in the candidate list. Cite the concrete numbers you were given in each one-sentence reason (e.g. "18% open / 8% CTR over 3 blasts, only 20% filled"). Return picks best-first.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { event_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['event_id', 'reason'],
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
  const cronSecret = process.env.CRON_SECRET, replySecret = process.env.REPLY_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const inboxOk  = replySecret && req.headers['x-inbox-secret'] === replySecret;
  if ((cronSecret || replySecret) && !bearerOk && !inboxOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }

  const through = req.body?.through || null;
  const days = windowDays(through);
  const perDay = through
    ? Math.max(1, Math.min(10, Number(req.body?.per_day) || 4))
    : Math.max(1, Math.min(10, Number(req.body?.cap) || 3));   // legacy: cap == one day's worth

  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };
  const rpc = (fn) => fetch(`${supaUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sh, body: '{}' });

  try {
    const [recRes, cntRes, qRes] = await Promise.all([
      rpc('rpc_event_recommendations'), rpc('market_recipient_counts'), rpc('get_campaign_queue'),
    ]);
    const recs = await recRes.json();
    const counts = await cntRes.json().catch(() => []);
    const queue = await qRes.json().catch(() => []);
    if (!recRes.ok || !Array.isArray(recs)) { res.status(502).json({ error: 'recommendations fetch failed', detail: recs }); return; }

    // What the queue already holds. Live = anything not already sent; those slots are taken
    // and their events/markets must not be picked again, or the trigger duplicates itself.
    const live = (Array.isArray(queue) ? queue : []).filter(r => r.status !== 'sent' && r.status !== 'sending');
    const takenEvents = new Set(live.map(r => String(r.event_id || '')).filter(Boolean));
    const takenMarkets = new Set(live.map(r => String(r.state_code || '').toUpperCase()).filter(Boolean));
    const filled = {};                                  // slot_date -> live rows on that day
    live.forEach(r => { const d = String(r.scheduled_for || '').slice(0, 10); filled[d] = (filled[d] || 0) + 1; });

    // Per-day gaps: only the shortfall gets filled, so a full day is never touched again.
    const plan = days.map(d => {
      const existing = filled[d] || 0;
      return { date: d, existing, need: Math.max(0, perDay - existing), added: 0 };
    });
    const need = Math.min(MAX_PICKS, plan.reduce((s, p) => s + p.need, 0));

    const reach = {};
    (Array.isArray(counts) ? counts : []).forEach(m => { reach[m.market_key] = m; });

    // rule-approved candidates (the safety floor already applied in SQL), in rank order.
    // Anything already sitting in the queue is dropped here — that's the additive rule.
    const alreadyQueued = [];
    const approved = recs.filter(r => r.decision === 'send').filter(r => {
      const code = String((reach[r.market_key] || {}).state_code || '').toUpperCase();
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
        }));
        const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: MODEL, max_tokens: 2000,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: `Choose up to ${need} markets to blast across the next ${days.length} day(s) — ${perDay} per day, best-first. Candidates:\n` + JSON.stringify(payload) },
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
            if (c && !seen.has(String(p.event_id))) { seen.add(String(p.event_id)); picks.push({ ...c, reason: p.reason || null }); }
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
      usedMarkets.add(mk);
      plan[di].added++;
      scheduled.push({ ...p, slot_date: plan[di].date });
    }
    picks = scheduled;

    res.status(200).json({
      ok: true, evaluated: recs.length, llm, candidates: candidates.length,
      per_day: perDay, through: days[days.length - 1], days: days.length,
      cap: need, need, plan, already_queued: alreadyQueued,
      picks, vetoed, skipBy,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
