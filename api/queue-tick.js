// Auto-send tick for the daily blast queue (Vercel Cron).
//
// A queued blast sends when its scheduled slot arrives — confirmed or not (approval is
// optional, not blocking). Placeholder/demo rows (is_placeholder=true) are NEVER auto-sent
// — this endpoint is dormant until real blasts are queued.
//
// The old rule also fired any row left unactioned 48h after it was QUEUED, ignoring
// scheduled_for. With the multi-day queue (four days lined up at once, migration 030) that
// would blast a day-4 market on day 2, so scheduled_for is now the only trigger.
//
// Runs from Vercel Cron (Authorization: Bearer CRON_SECRET) or on-demand
// (x-inbox-secret: REPLY_SECRET). Reads the queue + recipients via anon RPCs; sends
// through the same webhooks as the manual Queue "Confirm"; marks rows sent.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, optional CRON_SECRET / REPLY_SECRET,
//      BULK_SEND_WEBHOOK_URL (SMS), EMAIL_SEND_WEBHOOK_URL (Gmail mail merge),
//      CAKEMAIL_PAT (CakeMail — sent straight from here, no n8n).
//
// Email routing is decided by the row's email_from: a value shaped
// 'cakemail:<account_id>:<sender_id>' goes straight to the CakeMail API via
// lib/cakemail.js, anything else to the Gmail mail merge webhook.
// Keep this in sync with EMAIL_SENDERS / cakemailSender in ui/index.html.

import { sendCampaign, parseCakemailFrom, cakemailKey } from '../lib/cakemail.js';

export const config = { maxDuration: 60 };

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

    // due = real, not already sent, and its scheduled slot has arrived
    const due = q.filter(r => !r.is_placeholder && r.status !== 'sent' && r.status !== 'sending'
      && new Date(r.scheduled_for).getTime() <= now);

    // 14-day per-market cooldown pre-filter: markets blasted recently never reach the send step.
    const cd = await (await rpc('market_cooldowns')).json();
    const cooled = new Set((Array.isArray(cd) ? cd : []).filter(c => c.cooled).map(c => (c.market_code || '').toUpperCase()));

    const results = [], held = [];
    for (const r of due) {
      const mkt = (r.state_code || '').toUpperCase();
      if (mkt && cooled.has(mkt)) { held.push({ id: r.id, title: r.title, market: mkt }); continue; } // cooling down — skip
      const reason = r.status === 'confirmed' ? 'scheduled' : 'scheduled-unactioned';
      let phones = [], emails = [];
      if (r.sms && r.state_code)   { const d = await (await rpc('market_phones', { p_code: r.state_code })).json(); phones = [...new Set((d||[]).map(x => normPhone(x.phone)).filter(validPhone))]; }
      if (r.email && r.state_code) { const d = await (await rpc('market_emails', { p_code: r.state_code })).json(); emails = [...new Set((d||[]).map(x => (x.email||'').trim().toLowerCase()).filter(validEmail))]; }

      const sent = [];
      if (r.sms && phones.length && hookOk(smsHook)) {
        const messages = phones.map(to => ({ from: r.sms_from || undefined, to, text: r.sms_copy || '' }));
        const rr = await fetch(smsHook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbox-secret': replySecret || '' }, body: JSON.stringify({ from: r.sms_from || undefined, messages }) });
        sent.push(rr.ok ? `SMS ${messages.length}` : `SMS failed`);
      }
      if (r.email && emails.length) {
        const html = nl2br(r.email_copy || '');
        const cm = parseCakemailFrom(r.email_from);
        if (cm) {
          // Straight to the CakeMail API — one campaign for the whole market, five calls
          // total regardless of recipient count. A failure here must not abort the run:
          // record it and let the remaining due rows proceed.
          if (!cakemailKey()) { sent.push('CakeMail not configured (CAKEMAIL_PAT unset)'); }
          else {
            try {
              const out = await sendCampaign({
                accountId: cm.accountId, senderId: cm.senderId,
                emails, subject: r.title, html,
                name: `${r.title} — ${r.state_code || 'blast'}`,
                tags: ['telnyx-inbox', r.state_code || 'blast'].filter(Boolean),
              });
              sent.push(`CakeMail ${out.recipients} (campaign ${out.campaignId})`);
            } catch (e) {
              sent.push(`CakeMail failed: ${String((e && e.message) || e)}`);
            }
          }
        } else if (hookOk(emailHook)) {
          const messages = emails.map(to => ({ from: r.email_from || undefined, to, subject: r.title, html }));
          const rr = await fetch(emailHook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbox-secret': replySecret || '' }, body: JSON.stringify({ from: r.email_from || undefined, messages }) });
          sent.push(rr.ok ? `Email ${messages.length}` : `Email failed`);
        }
      }
      const summary = [phones.length ? `${phones.length} SMS` : '', emails.length ? `${emails.length} email` : ''].filter(Boolean).join(' · ');
      await rpc('queue_mark_sent', { p_id: r.id, p_recipients: summary });
      // Write to the notebook so this market goes on cooldown. Per Josh: an email send
      // counts for both channels, so one row (market + day) cools email AND SMS.
      if (r.state_code && (phones.length || emails.length)) {
        await rpc('log_market_blast', { p_code: r.state_code, p_name: r.state_name || null, p_channel: emails.length ? 'Email' : 'SMS', p_queue_id: r.id });
      }
      results.push({ id: r.id, title: r.title, reason, sent, recipients: summary });
    }

    res.status(200).json({ ok: true, checked: q.length, due: due.length, sent: results, held, webhooks: { sms: hookOk(smsHook), email: hookOk(emailHook), cakemail: !!cakemailKey() } });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
