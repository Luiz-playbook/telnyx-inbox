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
// (x-send-secret: SEND_SECRET — server-only; the browser's public REPLY_SECRET is NOT accepted).
// Reads the queue + recipients via anon RPCs; sends
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

import { sendCampaign, parseCakemailFrom, cakemailKey, cakemailKeyEnvName } from '../lib/cakemail.js';

export const config = { maxDuration: 60 };

const normPhone = p => { let d=(p||'').replace(/[^\d+]/g,''); if(d&&d[0]!=='+'){ if(d.length===10)d='+1'+d; else if(d.length===11&&d[0]==='1')d='+'+d; } return d; };
const validPhone = p => /^\+\d{10,15}$/.test(p||'');
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e||'');
const nl2br = s => (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\n/g,'<br>');

// Who may press "Send now". The browser cannot hold a shared secret — anything shipped to
// it is public, which is why REPLY_SECRET was removed from this route in 3c5b0ce — so the
// operator proves identity instead: the Supabase session created by ui/auth-gate.js.
//
// The token is verified BY SUPABASE, not parsed here. We hand it to /auth/v1/user; a
// forged or expired token simply fails to resolve to a user. That is the difference
// between this and the old REPLY_SECRET check, which trusted a string the page gave out
// to every visitor.
const OPERATOR_DOMAIN = 'callplaybook.com';

async function verifyOperator(token, supaUrl, supaKey) {
  if (!token) return null;
  try {
    const r = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supaKey },
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    const email = String((u && u.email) || '').toLowerCase();
    // Same allowlist the sign-in gate enforces, re-checked here: the gate is UI, this is the
    // control. A Google account outside the domain can hold a valid Supabase session.
    return email.endsWith('@' + OPERATOR_DOMAIN) ? email : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }

  // SEND ROUTE — three ways in, in descending order of trust:
  //   1. CRON_SECRET bearer — Vercel Cron, may sweep the whole due queue.
  //   2. SEND_SECRET header — server-to-server, same reach.
  //   3. A signed-in @callplaybook.com operator — ONE named row only (see below).
  // REPLY_SECRET is still not accepted: it is published in config.js.
  const cronSecret = process.env.CRON_SECRET, sendSecret = process.env.SEND_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const sendOk   = sendSecret && req.headers['x-send-secret'] === sendSecret;
  const operator = (bearerOk || sendOk)
    ? null
    : await verifyOperator(req.headers['x-sb-access-token'], supaUrl, supaKey);
  if (!bearerOk && !sendOk && !operator) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };
  const rpc = (fn, body) => fetch(`${supaUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sh, body: JSON.stringify(body || {}) });

  const now = Date.now();
  const webhookSecret = process.env.REPLY_SECRET || ''; // outbound gate the n8n workflows expect (unrelated to inbound auth)
  // US Eastern, compared against events_master.event_date (a plain date, no time). All fixtures
  // are North American and event_date is their local date, so the server's own clock — UTC on
  // Vercel — would call tonight's games "yesterday" for the last hours of every UTC day and
  // refuse to send perfectly valid blasts.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const smsHook = process.env.BULK_SEND_WEBHOOK_URL, emailHook = process.env.EMAIL_SEND_WEBHOOK_URL;
  const hookOk = u => u && !String(u).startsWith('<<');

  // Manual "Send now" from the Queue posts { id } and targets exactly that row. It is an
  // explicit operator action on one blast, so it skips the two gates the CRON pass needs and
  // the operator has already answered for: the scheduled slot (that's the whole point) and
  // is_placeholder (every row Trigger Blast queues is a placeholder, so the cron must never
  // fire them on its own — but the operator asking for this one is not the cron).
  //
  // What it does NOT skip is send_allowlist: while that list is non-empty, market_emails /
  // market_phones resolve to zero rows for any market not on it, so a real market still
  // reaches nobody. The market cooldown is likewise not silently ignored — it's reported back
  // as cooldown_overridden so the caller can say so.
  // Which sending accounts actually have a key on this deployment. Reported back so a
  // "Forbidden" can be told apart from a key that was never set, without leaking the tokens.
  // The accounts a sender option can actually address: 1761047 is the production Josh
  // sub-account as of 2026-07-31 (PBSPORTS_CAKEMAIL_*), 1679456 is the test account.
  // 1679383 is gone from this list with cole@ — the sender still exists in CakeMail, but no
  // option sends from it, and reporting a key for an account nothing uses is just noise.
  const CAKEMAIL_ACCOUNTS = ['1679456', '1761047'].filter(id => !!cakemailKey(id));

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const onlyId = body && typeof body.id === 'string' ? body.id : null;

  // A signed-in operator may send ONE named blast — the thing the Queue's "Send now" button
  // does — and nothing else. Without this, a browser session would be able to POST {} and
  // sweep every due row in the queue at once, which is the cron's job and no button's.
  if (operator && !onlyId) {
    res.status(403).json({ error: 'A signed-in operator may only send one named blast — pass { id }. Queue-wide sends run from the cron.' });
    return;
  }

  try {
    const q = await (await rpc('get_campaign_queue')).json();
    if (!Array.isArray(q)) { res.status(502).json({ error: 'queue fetch failed', detail: q }); return; }

    // due = real, not already sent, and its scheduled slot has arrived — unless one row was
    // named, in which case that row IS the work.
    const sendable = r => r.status !== 'sent' && r.status !== 'sending';
    const due = onlyId
      ? q.filter(r => r.id === onlyId && sendable(r))
      : q.filter(r => !r.is_placeholder && sendable(r) && new Date(r.scheduled_for).getTime() <= now);
    if (onlyId && !due.length) {
      const row = q.find(r => r.id === onlyId);
      res.status(row ? 409 : 404).json({ error: row ? `blast is already ${row.status}` : 'blast not found', id: onlyId });
      return;
    }

    // 14-day per-market cooldown pre-filter: markets blasted recently never reach the send step.
    const cd = await (await rpc('market_cooldowns')).json();
    const cooled = new Set((Array.isArray(cd) ? cd : []).filter(c => c.cooled).map(c => (c.market_code || '').toUpperCase()));

    const results = [], held = [], errors = [];
    for (const r of due) {
      const mkt = (r.state_code || '').toUpperCase();
      const cooling = !!(mkt && cooled.has(mkt));
      // The cron respects the cooldown absolutely; a named row proceeds but says it did.
      if (cooling && !onlyId) { held.push({ id: r.id, title: r.title, market: mkt, reason: 'cooldown' }); continue; }

      // A blast sells tickets to ONE game. This endpoint fires on scheduled_for and used to
      // ignore event_date entirely, so a row that sat in the queue too long — or was snoozed
      // past its own game — would happily advertise a match that has already been played.
      // The cron will not send those. Send now still can, deliberately: the operator sees a
      // "!" on the row and is told in the confirm dialog before anything happens.
      const gamePast = !!(r.event_date && r.event_date < today);
      if (gamePast && !onlyId) {
        held.push({ id: r.id, title: r.title, market: mkt, reason: 'game-already-played', event_date: r.event_date });
        continue;
      }
      const reason = onlyId ? 'manual-send-now' : (r.status === 'confirmed' ? 'scheduled' : 'scheduled-unactioned');
      let phones = [], emails = [];
      if (r.sms && r.state_code)   { const d = await (await rpc('market_phones', { p_code: r.state_code })).json(); phones = [...new Set((d||[]).map(x => normPhone(x.phone)).filter(validPhone))]; }
      if (r.email && r.state_code) { const d = await (await rpc('market_emails', { p_code: r.state_code })).json(); emails = [...new Set((d||[]).map(x => (x.email||'').trim().toLowerCase()).filter(validEmail))]; }

      // sent = channels that actually delivered; failed = channels that did not. The two were
      // one list, so "CakeMail failed: …" counted as a send: the row was marked sent, the
      // market went on a 14-day cooldown, and the blast could never be retried — all for an
      // email nobody received. Nothing is recorded now unless at least one channel succeeded.
      const sent = [], failed = [];
      if (r.sms && phones.length && hookOk(smsHook)) {
        const messages = phones.map(to => ({ from: r.sms_from || undefined, to, text: r.sms_copy || '' }));
        const rr = await fetch(smsHook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbox-secret': webhookSecret }, body: JSON.stringify({ from: r.sms_from || undefined, messages }) });
        (rr.ok ? sent : failed).push(rr.ok ? `SMS ${messages.length}` : `SMS failed (HTTP ${rr.status})`);
      }
      if (r.email && emails.length) {
        const html = nl2br(r.email_copy || '');
        // The row's title is queue bookkeeping — "[TEST] angels — Anaheim" — and it used to
        // be sent as the subject line, so that string reached the recipient's inbox.
        // api/queue-draft.js now fills email_subject from the template ("Early access
        // tickets — Angels at Anaheim Ducks"); title remains the fallback for rows queued
        // before migration 044, or drafted with no email template.
        const subject = String(r.email_subject || '').trim() || r.title;
        const cm = parseCakemailFrom(r.email_from);
        if (cm) {
          // Straight to the CakeMail API — one campaign for the whole market, five calls
          // total regardless of recipient count. A failure here must not abort the run:
          // record it and let the remaining due rows proceed.
          // The key is per sub-account, so it is checked against the account this row sends from.
          if (!cakemailKey(cm.accountId)) { failed.push(`CakeMail not configured for account ${cm.accountId} — set ${cakemailKeyEnvName(cm.accountId)}`); }
          else {
            try {
              const out = await sendCampaign({
                accountId: cm.accountId, senderId: cm.senderId,
                emails, subject, html,
                // `name` is CakeMail's internal campaign label, not anything a recipient
                // sees — the row title is the right thing there, subject is not.
                name: `${r.title} — ${r.state_code || 'blast'}`,
                tags: ['telnyx-inbox', r.state_code || 'blast'].filter(Boolean),
              });
              sent.push(`CakeMail ${out.recipients} (campaign ${out.campaignId})`);
            } catch (e) {
              failed.push(`CakeMail failed: ${String((e && e.message) || e)}`);
            }
          }
        } else if (hookOk(emailHook)) {
          const messages = emails.map(to => ({ from: r.email_from || undefined, to, subject, html }));
          const rr = await fetch(emailHook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbox-secret': webhookSecret }, body: JSON.stringify({ from: r.email_from || undefined, messages }) });
          (rr.ok ? sent : failed).push(rr.ok ? `Email ${messages.length}` : `Email failed (HTTP ${rr.status})`);
        } else {
          failed.push('No email route: the row has no CakeMail sender and EMAIL_SEND_WEBHOOK_URL is unset');
        }
      }
      const summary = [phones.length ? `${phones.length} SMS` : '', emails.length ? `${emails.length} email` : ''].filter(Boolean).join(' · ');

      // A blast that delivered on no channel is left untouched — still queued, still
      // retryable, and the market is NOT put on cooldown for a send that never happened.
      if (!sent.length) {
        errors.push({ id: r.id, title: r.title, reason, failed, resolved: summary || 'no recipients resolved' });
        continue;
      }

      await rpc('queue_mark_sent', { p_id: r.id, p_recipients: summary });
      // Write to the notebook so this market goes on cooldown. Per Josh: an email send
      // counts for both channels, so one row (market + day) cools email AND SMS.
      if (r.state_code && (phones.length || emails.length)) {
        await rpc('log_market_blast', { p_code: r.state_code, p_name: r.state_name || null, p_channel: emails.length ? 'Email' : 'SMS', p_queue_id: r.id });
      }
      results.push({ id: r.id, title: r.title, reason, sent, failed: failed.length ? failed : undefined, recipients: summary, cooldown_overridden: cooling || undefined });
    }

    res.status(200).json({ ok: true, manual: !!onlyId, checked: q.length, due: due.length, sent: results, held, errors, webhooks: { sms: hookOk(smsHook), email: hookOk(emailHook), cakemail: CAKEMAIL_ACCOUNTS } });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
