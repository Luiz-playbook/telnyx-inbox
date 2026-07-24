// Auto-send tick for the daily blast queue (Vercel Cron).
//
// A queued blast sends when EITHER: it's confirmed and its scheduled time has arrived,
// OR it was never actioned within 48h of being queued (approval is optional, not blocking).
// Placeholder/demo rows (is_placeholder=true) are NEVER auto-sent — this endpoint is
// dormant until real blasts are queued.
//
// Runs from Vercel Cron (Authorization: Bearer CRON_SECRET) or on-demand
// (x-inbox-secret: REPLY_SECRET). Reads the queue + recipients via anon RPCs; sends
// through the same webhooks as the manual Queue "Confirm"; marks rows sent.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, optional CRON_SECRET / REPLY_SECRET,
//      BULK_SEND_WEBHOOK_URL (SMS), EMAIL_SEND_WEBHOOK_URL (email).

export const config = { maxDuration: 60 };

const AUTOSEND_MS = 48 * 3600 * 1000;

const normPhone = p => { let d=(p||'').replace(/[^\d+]/g,''); if(d&&d[0]!=='+'){ if(d.length===10)d='+1'+d; else if(d.length===11&&d[0]==='1')d='+'+d; } return d; };
const validPhone = p => /^\+\d{10,15}$/.test(p||'');
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e||'');
const nl2br = s => (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\n/g,'<br>');

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET, replySecret = process.env.REPLY_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const inboxOk  = replySecret && req.headers['x-inbox-secret'] === replySecret;
  if ((cronSecret || replySecret) && !bearerOk && !inboxOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };
  const rpc = (fn, body) => fetch(`${supaUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sh, body: JSON.stringify(body || {}) });

  const now = Date.now();
  const smsHook = process.env.BULK_SEND_WEBHOOK_URL, emailHook = process.env.EMAIL_SEND_WEBHOOK_URL;
  const hookOk = u => u && !String(u).startsWith('<<');

  try {
    const q = await (await rpc('get_campaign_queue')).json();
    if (!Array.isArray(q)) { res.status(502).json({ error: 'queue fetch failed', detail: q }); return; }

    // due = real, not already sent, and (schedule reached OR pending past the 48h auto-send window)
    const due = q.filter(r => !r.is_placeholder && r.status !== 'sent' && r.status !== 'sending' && (
      new Date(r.scheduled_for).getTime() <= now ||
      (r.status === 'pending' && new Date(r.created_at).getTime() + AUTOSEND_MS <= now)
    ));

    const results = [];
    for (const r of due) {
      const reason = new Date(r.scheduled_for).getTime() <= now ? 'scheduled' : 'auto-48h';
      let phones = [], emails = [];
      if (r.sms && r.state_code)   { const d = await (await rpc('market_phones', { p_code: r.state_code })).json(); phones = [...new Set((d||[]).map(x => normPhone(x.phone)).filter(validPhone))]; }
      if (r.email && r.state_code) { const d = await (await rpc('market_emails', { p_code: r.state_code })).json(); emails = [...new Set((d||[]).map(x => (x.email||'').trim().toLowerCase()).filter(validEmail))]; }

      const sent = [];
      if (r.sms && phones.length && hookOk(smsHook)) {
        const messages = phones.map(to => ({ from: r.sms_from || undefined, to, text: r.sms_copy || '' }));
        const rr = await fetch(smsHook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbox-secret': replySecret || '' }, body: JSON.stringify({ from: r.sms_from || undefined, messages }) });
        sent.push(rr.ok ? `SMS ${messages.length}` : `SMS failed`);
      }
      if (r.email && emails.length && hookOk(emailHook)) {
        const html = nl2br(r.email_copy || '');
        const messages = emails.map(to => ({ from: r.email_from || undefined, to, subject: r.title, html }));
        const rr = await fetch(emailHook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbox-secret': replySecret || '' }, body: JSON.stringify({ from: r.email_from || undefined, messages }) });
        sent.push(rr.ok ? `Email ${messages.length}` : `Email failed`);
      }
      const summary = [phones.length ? `${phones.length} SMS` : '', emails.length ? `${emails.length} email` : ''].filter(Boolean).join(' · ');
      await rpc('queue_mark_sent', { p_id: r.id, p_recipients: summary });
      results.push({ id: r.id, title: r.title, reason, sent, recipients: summary });
    }

    res.status(200).json({ ok: true, checked: q.length, due: due.length, sent: results, webhooks: { sms: hookOk(smsHook), email: hookOk(emailHook) } });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
