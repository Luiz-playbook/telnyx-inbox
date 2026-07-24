// Sync blast send history from the Salesmsg API into Supabase (salesmsg_broadcasts).
// Every broadcast is tagged channel='Email' for now (SMS may come later). The full raw
// payload is stored so no field is lost; common fields are extracted best-effort.
//
// Runs on-demand from the UI (x-inbox-secret: REPLY_SECRET) and/or a cron
// (Authorization: Bearer CRON_SECRET). Upserts, so it's incremental — safe to call often.
//
// Env: SALESMSG_API_KEY (server-side only — never sent to the browser),
//      SUPABASE_URL, SUPABASE_ANON_KEY, optional CRON_SECRET / REPLY_SECRET.

export const config = { maxDuration: 60 };

const SM_BASE = 'https://api.salesmessage.com/pub/v2.1';
const pick = (o, keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; };

function mapBroadcast(b) {
  const rec = pick(b, ['recipients_count', 'total_recipients', 'audience_count', 'contacts_count', 'recipients']);
  return {
    broadcast_id: String(pick(b, ['id', 'uuid', 'broadcast_id']) ?? ''),
    channel: 'Email',
    name: pick(b, ['name', 'title', 'subject']),
    status: pick(b, ['status', 'state']),
    message: pick(b, ['message', 'text', 'body', 'content']),
    recipients: rec != null ? Number(rec) : null,
    sent_count: (v => v != null ? Number(v) : null)(pick(b, ['sent_count', 'sent', 'messages_sent', 'total_sent'])),
    delivered_count: (v => v != null ? Number(v) : null)(pick(b, ['delivered_count', 'delivered', 'total_delivered'])),
    sent_at: pick(b, ['sent_at', 'completed_at', 'finished_at', 'scheduled_at', 'send_at', 'created_at', 'updated_at']),
    raw: b,
  };
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET, replySecret = process.env.REPLY_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const inboxOk  = replySecret && req.headers['x-inbox-secret'] === replySecret;
  if ((cronSecret || replySecret) && !bearerOk && !inboxOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const key = (process.env.SALESMSG_API_KEY || '').trim();
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!key) { res.status(500).json({ error: 'SALESMSG_API_KEY is not set on the server' }); return; }
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }

  const smHeaders = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const supaHeaders = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };

  try {
    const all = [];
    let page = 1, lastPage = 1;
    do {
      const r = await fetch(`${SM_BASE}/broadcasts?page=${page}&per_page=100`, { headers: smHeaders });
      if (!r.ok) { res.status(502).json({ error: `Salesmsg error HTTP ${r.status}`, page }); return; }
      const j = await r.json();
      const rows = Array.isArray(j.data) ? j.data : [];
      all.push(...rows);
      lastPage = (j.meta && j.meta.last_page) || 1;
      page += 1;
    } while (page <= lastPage && page <= 50); // safety cap

    const mapped = all.map(mapBroadcast).filter(x => x.broadcast_id);

    let upserted = 0;
    if (mapped.length) {
      const up = await fetch(`${supaUrl}/rest/v1/rpc/upsert_salesmsg_broadcasts`, {
        method: 'POST', headers: supaHeaders, body: JSON.stringify({ p_rows: mapped }),
      });
      const body = await up.json().catch(() => null);
      if (!up.ok) { res.status(502).json({ error: 'supabase upsert failed', detail: body }); return; }
      upserted = typeof body === 'number' ? body : (mapped.length);
    }

    res.status(200).json({ ok: true, fetched: all.length, upserted });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
