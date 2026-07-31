// Every blast this business has sent, from whichever platform sent it, in one list.
//
// The Market History tab used to read salesmsg_broadcasts directly from the browser, so it
// showed only what the Salesmsg sync had pulled — and nothing else. The Textable history
// imported on 2026-07-31 lives in ticketblaster_market_blasts_log (the table the decider
// reads for cooldown) and was therefore invisible in the tab named after it.
//
// WHY AN ENDPOINT RATHER THAN A DIRECT TABLE READ. ticketblaster_market_blasts_log is not
// readable with the anon key — RLS returns an empty array rather than an error, which is
// exactly how the tab could look "empty" while holding 11 rows. Reading it needs the
// service-role key, and that key must never reach the browser. So the join happens here.
//
// Returns blast history: market, channel, recipients, when, and the copy that was sent.
// No credentials, no recipient addresses — just what was blasted where.

export const config = { maxDuration: 30 };

const num = v => (v == null || v === '' ? null : Number(v));

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET, replySecret = process.env.REPLY_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const inboxOk = replySecret && req.headers['x-inbox-secret'] === replySecret;
  if ((cronSecret || replySecret) && !bearerOk && !inboxOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const url = process.env.SUPABASE_URL;
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim() || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / key not set' }); return; }
  const h = { apikey: key, Authorization: `Bearer ${key}` };

  const get = async (path) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { headers: h });
    if (!r.ok) return [];
    const j = await r.json().catch(() => []);
    return Array.isArray(j) ? j : [];
  };

  try {
    const [blasts, broadcasts] = await Promise.all([
      get('ticketblaster_market_blasts_log?select=id,market_key,state_code,channel,template_name,recipient_count,source,blasted_at,message,notes&order=blasted_at.desc&limit=1000'),
      get('salesmsg_broadcasts?select=broadcast_id,name,channel,status,recipients,sent_count,delivered_count,message,sent_at&order=sent_at.desc&limit=1000'),
    ]);

    // One shape for both, so the table does not care where a row came from. `source` is the
    // platform, and it is shown — a Textable blast and a CakeMail one are not interchangeable
    // when you are reading history to decide what worked.
    const rows = [
      ...blasts.map(b => ({
        id: b.id,
        sent_at: b.blasted_at,
        name: b.template_name || '(untitled blast)',
        channel: (b.channel || 'sms').toLowerCase() === 'email' ? 'Email' : 'SMS',
        source: b.source || 'log',
        market: b.market_key || null,
        state_code: b.state_code || null,
        recipients: num(b.recipient_count),
        sent_count: null,               // the log records the send, not per-recipient delivery
        status: null,
        message: b.message || null,
        notes: b.notes || null,
      })),
      ...broadcasts.map(b => ({
        id: `sm:${b.broadcast_id}`,
        sent_at: b.sent_at,
        name: b.name || '(untitled broadcast)',
        channel: b.channel === 'Email' ? 'Email' : (b.channel || 'SMS'),
        source: 'salesmsg',
        market: null,                   // Salesmsg broadcasts target audiences, not markets
        state_code: null,
        recipients: num(b.recipients),
        sent_count: num(b.sent_count),
        status: b.status || null,
        message: b.message || null,
        notes: null,
      })),
    ];

    // Newest first; rows with no date sort last rather than jumping to the top.
    rows.sort((a, b) => {
      const ta = a.sent_at ? Date.parse(a.sent_at) : -Infinity;
      const tb = b.sent_at ? Date.parse(b.sent_at) : -Infinity;
      return tb - ta;
    });

    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ ok: true, rows, counts: { blast_log: blasts.length, salesmsg: broadcasts.length } });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e), rows: [] });
  }
}
