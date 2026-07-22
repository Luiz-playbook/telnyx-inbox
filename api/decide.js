// Daily AI campaign decider (metrics-first).
//
// The send/skip/template/timing decision is DETERMINISTIC — computed in SQL from
// historical blast_templates performance (rpc_event_recommendations). The LLM does
// NOT decide; it only writes the human-readable rationale for each decision. Every
// decision (send + skip) is logged to campaign_send_log via log_campaign_decisions.
//
// Runs two ways:
//   • Vercel Cron (daily, per vercel.json) — sends Authorization: Bearer CRON_SECRET
//   • On-demand from the UI — sends x-inbox-secret: <REPLY_SECRET>
//
// Env: OPENAI_API_KEY (+ optional OPENAI_MODEL), SUPABASE_URL, SUPABASE_ANON_KEY,
//      optional CRON_SECRET, REPLY_SECRET.
// Query/body flag `dry` (?dry=1 or {"dry":true}) computes reasons but skips logging.

export const config = { maxDuration: 60 };

const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();

const SYSTEM = [
  'You write one-sentence rationales for a ticket-marketing send decider. The decision (send/skip/hold) and the chosen email template are ALREADY made from historical performance data and the configured "Cole Rules" — do not second-guess or change them. For each event you are given the market, whether a blast has run there before, the historical open rate and click-through rate, the best-performing template, the best send weekday, the event fill %, days until the game, days since the last send, warning flags, and a reason code. Write a crisp, specific one-sentence justification a sales lead would trust. Cite the concrete numbers you were given (e.g. "18% open / 8% CTR across prior Boston blasts"). If a warning flag is set (opt-out running hot, or recent-send fatigue), mention it. Never invent numbers. reason codes: ok = good to send; nearly_full = skip, already ~full; no_history = skip, no comparable market blast to learn from; too_early = hold, game is beyond the forward-looking window; cooldown = hold, market was sent to inside the cooldown floor.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: { event_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['event_id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['reasons'],
  additionalProperties: false,
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function warnings(r) {
  const w = [];
  if (r.optout_warning) w.push('opt-out rate running hot');
  if (r.fatigue_warning) w.push(`sent ${r.days_since_send}d ago (fatigue)`);
  return w.length ? ` ⚠ ${w.join('; ')}` : '';
}
function fallbackReason(r) {
  if (r.reason_code === 'no_history') return `No prior blast in ${r.market_label || 'this market'} to learn from — skipping.`;
  if (r.reason_code === 'nearly_full') return `Already ~${Math.round(r.filled_pct)}% full — no blast needed.`;
  if (r.reason_code === 'too_early') return `Game is ${r.days_until} days out — beyond the forward-looking window, holding.`;
  if (r.reason_code === 'cooldown') return `Last sent ${r.days_since_send} days ago — inside the cooldown floor, holding.`;
  const bits = [];
  if (r.open_rate_w != null) bits.push(`${r.open_rate_w}% open`);
  if (r.ctr_w != null) bits.push(`${r.ctr_w}% CTR`);
  const perf = bits.length ? ` (${bits.join(' / ')} over ${r.n_blasts || 0} prior blast${r.n_blasts === 1 ? '' : 's'})` : '';
  const when = (r.best_dow != null) ? `, best on ${DOW[r.best_dow]}` : '';
  return `Send "${r.best_template || 'top template'}" to ${r.market_label}${perf}${when}.` + warnings(r);
}

export default async function handler(req, res) {
  // auth: cron bearer OR UI inbox-secret
  const cronSecret = process.env.CRON_SECRET;
  const replySecret = process.env.REPLY_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const inboxOk = replySecret && req.headers['x-inbox-secret'] === replySecret;
  if ((cronSecret || replySecret) && !bearerOk && !inboxOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const key = (process.env.OPENAI_API_KEY || '').trim();
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true' || (req.body && req.body.dry === true);
  const today = new Date().toISOString().slice(0, 10);
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };

  try {
    // 1. deterministic recommendations straight from the performance model
    const recRes = await fetch(`${supaUrl}/rest/v1/rpc/rpc_event_recommendations`, { method: 'POST', headers: sh, body: '{}' });
    const recs = await recRes.json();
    if (!recRes.ok || !Array.isArray(recs)) { res.status(502).json({ error: 'recommendations fetch failed', detail: recs }); return; }

    // 2. LLM writes a one-line rationale per event (grounded in the numbers). Optional.
    let reasonMap = {};
    if (key && recs.length) {
      const payload = recs.map(r => ({
        event_id: r.event_id, team: r.team, opponent: r.opponent, market: r.market_label,
        matched: r.matched, decision: r.decision, reason_code: r.reason_code,
        filled_pct: r.filled_pct, open_rate: r.open_rate_w, ctr: r.ctr_w, n_blasts: r.n_blasts,
        best_template: r.best_template, best_weekday: r.best_dow != null ? DOW[r.best_dow] : null,
        days_until: r.days_until, days_since_send: r.days_since_send,
        optout_warning: r.optout_warning, fatigue_warning: r.fatigue_warning,
      }));
      try {
        const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: MODEL, max_tokens: 3000,
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Events:\n' + JSON.stringify(payload) }],
            response_format: { type: 'json_schema', json_schema: { name: 'reasons', strict: true, schema: SCHEMA } },
          }),
        });
        const ai = await aiRes.json();
        if (aiRes.ok) {
          const txt = ai.choices?.[0]?.message?.content || '{}';
          (JSON.parse(txt).reasons || []).forEach(x => { if (x.event_id) reasonMap[x.event_id] = x.reason; });
        }
      } catch { /* fall back to templated reasons below */ }
    }

    // 3. assemble decisions (LLM reason if present, else a templated one)
    const decisions = recs.map(r => ({
      event_id: r.event_id, team: r.team,
      decision: r.decision, channel: r.channel,
      template_name: r.decision === 'send' ? (r.best_template || null) : null,
      reason: reasonMap[r.event_id] || fallbackReason(r),
      market: r.market_label, market_key: r.market_key,
      open_rate: r.open_rate_w, ctr: r.ctr_w, best_dow: r.best_dow,
      run_date: today,
    }));

    // 4. log every decision (unless dry run)
    let logged = null;
    if (!dry) {
      const logR = await fetch(`${supaUrl}/rest/v1/rpc/log_campaign_decisions`, {
        method: 'POST', headers: sh, body: JSON.stringify({ p_decisions: decisions }),
      });
      logged = await logR.json().catch(() => null);
    }

    res.status(200).json({
      ok: true, run_date: today, dry,
      evaluated: recs.length,
      to_send: decisions.filter(d => d.decision === 'send').length,
      skipped: decisions.filter(d => d.decision === 'skip').length,
      ai_reasons: Object.keys(reasonMap).length,
      logged, decisions,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
