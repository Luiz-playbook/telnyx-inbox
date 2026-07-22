// Serverless Cron (Vercel): the daily AI campaign decider, in-code (no n8n).
// Runs on the schedule in vercel.json → for each upcoming event, Claude decides
// send/skip + which template, and each decision is written to campaign_send_log.
//
// Env vars (Vercel > Settings > Environment Variables):
//   ANTHROPIC_API_KEY   – required, the Claude API key
//   SUPABASE_URL        – already set (used by the frontend build)
//   SUPABASE_ANON_KEY   – already set; reads are anon-policy'd, writes go through
//                         the log_campaign_decisions() SECURITY DEFINER RPC
//   CRON_SECRET         – optional; if set, only requests with
//                         `Authorization: Bearer <CRON_SECRET>` run (Vercel cron sends it)
//
// Decides + logs only. Actual sending is not wired here yet (needs per-market lists).

export const config = { maxDuration: 60 };

const SYSTEM = [
  'You are the daily campaign send decider for a ticket-sales team. Each day you decide, per upcoming event, whether it deserves an email/SMS blast and which historical template to reuse. Follow these rules exactly:',
  '',
  'ELIGIBILITY (send only if ALL true): event_date is in the future; the event is NOT already full (filled_pct is null or < 90); a template in the library plausibly matches the event\'s market (bridge team_name -> city/metro -> the template list_name, a metro/region like "Cleveland", "Yankees New York City", "Georgia", "Washington DC & DMV"). If no template matches the market, decision = skip with reason "no list".',
  'PRIORITISATION: lower filled_pct = higher urgency (0% is most urgent); null fill = medium.',
  'TEMPLATE CHOICE: among templates matching the market, pick the best historical performer (highest open_rate, tie-break clickthru_rate; ignore rows with 0 sent_emails). Return its exact name.',
  'SUPPRESSION: never recommend sending on or after the event_date.',
  '',
  'Return one decision per event. channel is "email" for now (SMS lists not ready). template_name is the chosen template name, or null when skipping. Keep reason to one short sentence.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          team: { type: 'string' },
          decision: { type: 'string', enum: ['send', 'skip'] },
          channel: { type: 'string', enum: ['email', 'sms', 'none'] },
          template_name: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
        required: ['event_id', 'team', 'decision', 'channel', 'template_name', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
};

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!anthropicKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server' }); return; }
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }

  const today = new Date().toISOString().slice(0, 10);
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}` };

  try {
    // 1. pull upcoming events + the template library
    const [evR, tplR] = await Promise.all([
      fetch(`${supaUrl}/rest/v1/icp_events?select=id,team_name,opponent,event_date,filled_pct&event_date=gte.${today}&order=event_date.asc`, { headers: sh }),
      fetch(`${supaUrl}/rest/v1/blast_templates?select=list_name,name,open_rate,clickthru_rate,sent_emails,scheduled_for`, { headers: sh }),
    ]);
    const events = await evR.json(), templates = await tplR.json();
    if (!Array.isArray(events)) { res.status(502).json({ error: 'events fetch failed', detail: events }); return; }

    // 2. ask Claude to decide
    const user = `TODAY: ${today}\n\nUPCOMING EVENTS:\n${JSON.stringify(events)}\n\nTEMPLATE LIBRARY (historical blasts, list_name = market):\n${JSON.stringify(templates)}`;
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      }),
    });
    const claude = await claudeRes.json();
    if (!claudeRes.ok) { res.status(502).json({ error: 'anthropic error', detail: claude }); return; }
    const text = (claude.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let parsed; try { parsed = JSON.parse(text); } catch { res.status(502).json({ error: 'could not parse decisions', text }); return; }
    const decisions = (parsed.decisions || []).map(d => ({ ...d, run_date: today }));

    // 3. log every decision (send + skip) via the SECURITY DEFINER RPC
    const logR = await fetch(`${supaUrl}/rest/v1/rpc/log_campaign_decisions`, {
      method: 'POST', headers: { ...sh, 'content-type': 'application/json' },
      body: JSON.stringify({ p_decisions: decisions }),
    });
    const logged = await logR.json().catch(() => null);

    res.status(200).json({
      ok: true, run_date: today,
      evaluated: events.length, decided: decisions.length,
      to_send: decisions.filter(d => d.decision === 'send').length, logged,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
