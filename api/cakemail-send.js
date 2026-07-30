// On-demand CakeMail send for the UI (Queue "Send now" / manual confirm).
// The cron path (api/queue-tick.js) imports lib/cakemail.js directly instead of calling
// this endpoint — no reason to pay an HTTP hop to reach the same function.
//
// THIS SENDS REAL EMAIL. Guarded by the same shared secret as the other write endpoints.
//
// POST { account_id, sender_id, emails:[...], subject, html, reply_to_email?, name?, tags? }
// →    { ok:true, list_id, campaign_id, recipients }
//
// Env: CAKEMAIL_PAT (server-side only), REPLY_SECRET / CRON_SECRET.

import { sendCampaign } from '../lib/cakemail.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // SEND ROUTE — requires a SERVER-ONLY secret. REPLY_SECRET is published in the public
  // config.js, so it is intentionally NOT accepted here: the browser must never trigger a send.
  const cronSecret = process.env.CRON_SECRET, sendSecret = process.env.SEND_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const sendOk   = sendSecret && req.headers['x-send-secret'] === sendSecret;
  if (!bearerOk && !sendOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const b = req.body && typeof req.body === 'object' ? req.body : (() => {
    try { return JSON.parse(req.body || '{}'); } catch { return {}; }
  })();

  try {
    const out = await sendCampaign({
      accountId: b.account_id,
      senderId: b.sender_id,
      emails: b.emails,
      subject: b.subject,
      html: b.html,
      replyTo: b.reply_to_email || null,
      name: b.name || null,
      tags: Array.isArray(b.tags) ? b.tags : [],
    });
    res.status(200).json({ ok: true, list_id: out.listId, campaign_id: out.campaignId, recipients: out.recipients });
  } catch (e) {
    // CakeMail's own message is the useful part (bad sender, low account score, missing
    // address). 502 for its rejections, 500 for ours.
    const status = e && e.status ? 502 : 500;
    res.status(status).json({ error: String((e && e.message) || e) });
  }
}
