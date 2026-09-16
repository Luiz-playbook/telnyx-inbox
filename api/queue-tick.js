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
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.js), optional CRON_SECRET / REPLY_SECRET,
//      BULK_SEND_WEBHOOK_URL (SMS), EMAIL_SEND_WEBHOOK_URL (Gmail mail merge),
//      CAKEMAIL_PAT (CakeMail — sent straight from here, no n8n).
//
// Email routing is decided by the row's email_from: a value shaped
// 'cakemail:<account_id>:<sender_id>' goes straight to the CakeMail API via
// lib/cakemail.js, anything else to the Gmail mail merge webhook.
// Keep this in sync with EMAIL_SENDERS / cakemailSender in ui/index.html.

import { sendCampaign, parseCakemailFrom, cakemailKey, cakemailKeyEnvName } from '../lib/cakemail.js';
import { parseSalesmsgFrom, sendSmsBulk } from '../lib/salesmsg.js';
import { logOutboundSmsBatch, hubspotConfigured } from '../lib/hubspot.js';
import { supabaseKey } from '../lib/supabase.js';

export const config = { maxDuration: 60 };

const normPhone = p => { let d=(p||'').replace(/[^\d+]/g,''); if(d&&d[0]!=='+'){ if(d.length===10)d='+1'+d; else if(d.length===11&&d[0]==='1')d='+'+d; } return d; };
const validPhone = p => /^\+\d{10,15}$/.test(p||'');
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e||'');
const nl2br = s => (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\n/g,'<br>');

export default async function handler(req, res) {
  const supaUrl = process.env.SUPABASE_URL, supaKey = supabaseKey();
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };
  const rpc = (fn, body) => fetch(`${supaUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sh, body: JSON.stringify(body || {}) });

  // EVERY RECIPIENT, NOT THE FIRST THOUSAND.
  //
  // PostgREST caps any single response at 1,000 rows. market_phones / market_emails were called
  // once and whatever came back was treated as the audience, so a blast to Minnesota resolved
  // 1,000 of its 3,753 numbers, sent to those, marked the row sent and put the market on a
  // 14-day cooldown. The other 2,753 people were never contacted and nothing said so — the UI
  // reads its counts from market_counts, which queries the table directly and is not capped, so
  // the operator approved "3,753 phone numbers" and 1,000 were reached.
  //
  // Measured across the live markets before this fix: 18 of 52 markets truncated on phone and
  // 22 on email — 15,853 of 45,855 numbers and 23,890 of 56,331 addresses silently unreachable.
  //
  // Migration 054 was meant to have removed this. It removed the `limit 1000` written inside the
  // SQL; it could not remove the cap sitting one layer above, in PostgREST itself. Two caps, one
  // fixed, and the second kept doing the same job unnoticed.
  //
  // THE SAME BUG WAS ALREADY FOUND AND FIXED ONCE, in the Offers tab (ui/index.html,
  // fetchAllEvents) — where it presented as NFL and NHL missing from the table because the first
  // 1,000 rows were all MLB. The fix here is the same shape, so the two read alike.
  //
  // WHY QUERY PARAMS AND NOT A Range HEADER: Range is ignored on an RPC POST, as the Offers-tab
  // comment records. limit/offset go on the URL.
  //
  // OFFSET PAGING IS SAFE HERE ONLY BECAUSE BOTH FUNCTIONS END IN AN ORDER BY (migration 054:
  // `order by mc.phone` / `order by mc.email`). Paging an unordered result loses rows — Postgres
  // may return them differently per request, so a row can slip between pages. Ties on the same
  // value can still shuffle across a page boundary, but every row sharing a value is contiguous
  // in the ordering, so a shuffle can only repeat a value, never lose a distinct one; the caller
  // dedupes through a Set. Remove either ORDER BY and this becomes lossy again.
  //
  // A FAILED PAGE THROWS. It must never return what it has so far: a partial audience that reads
  // as a complete one is the exact failure this function exists to end, and it would be worse
  // than the bug — the row would be marked sent for an audience nobody chose.
  const PAGE = 1000, MAX_ROWS = 100000;   // MAX_ROWS is a runaway guard, not an expected ceiling
  async function rpcAll(fn, body) {
    const out = [];
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const url = `${supaUrl}/rest/v1/rpc/${fn}?limit=${PAGE}&offset=${offset}`;
      const r = await fetch(url, { method: 'POST', headers: sh, body: JSON.stringify(body || {}) });
      if (!r.ok) throw new Error(`${fn} page at offset ${offset} failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      const page = await r.json();
      if (!Array.isArray(page)) throw new Error(`${fn} returned ${typeof page} at offset ${offset}`);
      out.push(...page);
      // A short page is the last page. An exactly-full final page costs one extra empty request,
      // which is the right trade against guessing the total up front.
      if (page.length < PAGE) return out;
    }
    throw new Error(`${fn} exceeded ${MAX_ROWS} rows — refusing to send to a guessed audience`);
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const onlyId = body && typeof body.id === 'string' ? body.id : null;

  // AUTH. Two server-only credentials have full reach:
  //   CRON_SECRET bearer  — Vercel Cron, sweeps every due row.
  //   SEND_SECRET header  — server-to-server, same reach.
  //
  // Beyond those, the Queue's "Send now" button posts { id } from the browser with NO
  // credential, because a browser cannot keep one: config.js is served to every visitor, so
  // any secret placed there is public (that is why 3c5b0ce removed REPLY_SECRET from this
  // route). Rather than re-publish a secret or bolt a login onto the app, the open path is
  // gated on the thing that actually bounds the damage — TEST MODE.
  //
  // While send_allowlist is non-empty, market_emails / market_phones resolve to ZERO rows
  // for every market not on it. An anonymous caller can therefore only ever mail the test
  // market, whose recipients we own. That is a real limit, enforced in SQL, not a promise.
  //
  // The moment the allowlist is emptied — the moment real markets can receive mail — this
  // path closes and a secret is required again. The button stops working the day the stakes
  // change, instead of quietly becoming a public send button pointed at real customers.
  const cronSecret = process.env.CRON_SECRET, sendSecret = process.env.SEND_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const sendOk   = sendSecret && req.headers['x-send-secret'] === sendSecret;

  if (!bearerOk && !sendOk) {
    // No credential. Allowed only for ONE named row, and only in test mode: a sweep is the
    // cron's job, and { } from a browser must never fan out across the queue.
    if (!onlyId) {
      res.status(401).json({ error: 'unauthorized — a queue-wide send needs CRON_SECRET or SEND_SECRET' });
      return;
    }
    const tm = await rpc('send_test_mode').then(r => r.json()).catch(() => null);
    const testMode = Array.isArray(tm) && tm.length > 0;
    if (!testMode) {
      res.status(401).json({
        error: 'Send now is open only while TEST MODE is on (send_allowlist non-empty). '
             + 'The allowlist is now empty, so real markets can receive mail and this route needs SEND_SECRET.',
      });
      return;
    }
  }

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
  // is_placeholder (a demo row is not something the cron should ever fire on its own — but the
  // operator asking for this one is not the cron).
  //
  // IT DOES NOT SKIP sendable(), and must not: rejected and archived mean "no" however the send
  // was triggered. Pressing Send now on a blast someone else rejected should fail, not deliver.
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

  try {
    const q = await (await rpc('get_campaign_queue')).json();
    if (!Array.isArray(q)) { res.status(502).json({ error: 'queue fetch failed', detail: q }); return; }

    // due = real, not already sent, and its scheduled slot has arrived — unless one row was
    // named, in which case that row IS the work.
    // WHAT MAY NEVER BE SENT.
    //
    // 'sent' and 'sending' were the only exclusions here, which was safe ONLY because every row
    // was is_placeholder = true and the cron therefore never reached this test at all. Migration
    // 074 makes queued rows real, and that turns this line into the thing standing between a
    // refused blast and a delivered one — so the two states that mean "no" are now named.
    //
    // REJECTED. An operator read the blast and refused it, with a written reason (migration 048).
    // Without this, a rejected row whose slot had passed would have been picked up by the next
    // hourly tick and sent — the operator's decision reversed by a filter that never knew about
    // it. Of the 83 rows in the queue when 074 was written, 9 were rejected.
    //
    // ARCHIVED. "Not now, but keep it" (migration 045). Archiving hides a row from the Queue, so
    // sending one would deliver a blast nobody can see in the UI — invisible and unstoppable.
    // All 82 open rows were archived immediately before 074 to clear the queue; had this guard
    // not gone in with it, the first tick after the migration would have sent the lot.
    //
    // NOT status 'snoozed' — snoozing moves scheduled_for, so the slot check already holds it.
    const sendable = r => r.status !== 'sent' && r.status !== 'sending'
                       && r.status !== 'rejected' && !r.archived_at;
    const due = onlyId
      ? q.filter(r => r.id === onlyId && sendable(r))
      : q.filter(r => !r.is_placeholder && sendable(r) && new Date(r.scheduled_for).getTime() <= now);
    if (onlyId && !due.length) {
      const row = q.find(r => r.id === onlyId);
      res.status(row ? 409 : 404).json({ error: row ? `blast is already ${row.status}` : 'blast not found', id: onlyId });
      return;
    }

    // 14-day cooldown pre-filter: recently blasted markets never reach the send step.
    //
    // Keyed on market AND segment since migration 049 — blasting Ontario ICP leaves Ontario SCP
    // and Other open. A row with no segment targets the whole market, so it is held if ANY
    // segment is cooling; there is no partial version of "send to everyone".
    const cd = await (await rpc('market_cooldowns')).json();
    const cooled = new Set((Array.isArray(cd) ? cd : []).filter(c => c.cooled)
      .map(c => `${(c.market_code || '').toUpperCase()}|${c.segment || ''}`));
    const SEGMENTS = ['ICP', 'SCP', 'Other'];
    const isCooled = (code, segment) => !code ? false
      : segment ? cooled.has(`${code}|${segment}`)
                : SEGMENTS.some(s => cooled.has(`${code}|${s}`));

    const results = [], held = [], errors = [];
    for (const r of due) {
      const mkt = (r.state_code || '').toUpperCase();
      const cooling = isCooled(mkt, r.segment || null);
      // The cron respects the cooldown absolutely; a named row proceeds but says it did.
      if (cooling && !onlyId) { held.push({ id: r.id, title: r.title, market: mkt, segment: r.segment || null, reason: 'cooldown' }); continue; }

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

      // Cancelled / postponed game (migration 053). Held for the cron exactly like gamePast, but
      // a CANCELLED game also refuses "Send now" — and that asymmetry is the point. "The game was
      // played" is a judgement an operator can reasonably overrule (a late blast for a series, a
      // timezone edge). "The game does not exist" cannot be overruled by anyone: there is no
      // ticket to sell, so the send is wrong no matter who asks for it.
      //
      // Postponed is the softer case and holds indefinitely rather than cancelling the row: most
      // postponements get a new date within days, and because the queue joins events_master, the
      // row picks that date up on its own and becomes sendable again with no operator action.
      const off = r.event_status && r.event_status !== 'scheduled' ? r.event_status : null;
      if (off === 'cancelled') {
        const msg = { id: r.id, title: r.title, market: mkt, reason: 'game-cancelled', event_date: r.event_date };
        if (onlyId) { res.status(409).json({ error: 'This game has been cancelled — the blast cannot be sent.', ...msg }); return; }
        held.push(msg);
        continue;
      }
      if (off && !onlyId) {
        held.push({ id: r.id, title: r.title, market: mkt, reason: `game-${off}`, event_date: r.event_date });
        continue;
      }
      const reason = onlyId ? 'manual-send-now' : (r.status === 'confirmed' ? 'scheduled' : 'scheduled-unactioned');
      let phones = [], emails = [];
      // p_segment null = the whole market, every segment — which is exactly what a row with no
      // segment means, and what every row queued before migration 050 is.
      const seg = r.segment || null;
      // rpcAll, not rpc: see the note on the helper. A single call returned at most 1,000.
      if (r.sms && r.state_code)   { const d = await rpcAll('market_phones', { p_code: r.state_code, p_segment: seg }); phones = [...new Set((d||[]).map(x => normPhone(x.phone)).filter(validPhone))]; }
      if (r.email && r.state_code) { const d = await rpcAll('market_emails', { p_code: r.state_code, p_segment: seg }); emails = [...new Set((d||[]).map(x => (x.email||'').trim().toLowerCase()).filter(validEmail))]; }

      // sent = channels that actually delivered; failed = channels that did not. The two were
      // one list, so "CakeMail failed: …" counted as a send: the row was marked sent, the
      // market went on a 14-day cooldown, and the blast could never be retried — all for an
      // email nobody received. Nothing is recorded now unless at least one channel succeeded.
      const sent = [], failed = [];
      // AI-976: recipients to write to HubSpot once this row's sends are done. Collected
      // rather than logged inline so the CRM write never sits between resolving an audience
      // and putting the messages on the wire.
      const hubspotLog = [];
      if (r.sms && phones.length) {
        // SMS routing mirrors the email side: the row's sms_from decides the carrier. A value
        // shaped 'salesmsg:<team_id>:<phone>' goes straight to the Salesmsg API via
        // lib/salesmsg.js (OAuth, no API key); anything else is a Telnyx number and goes to
        // the n8n bulk webhook. Keep in sync with SMS_SENDERS / salesmsgSender in ui/index.html.
        const sm = parseSalesmsgFrom(r.sms_from);
        if (sm) {
          try {
            // Fan-out, not one call: Salesmsg broadcasts target saved contacts through a
            // filter, so raw market numbers have to be sent individually. Partial success is
            // normal and is reported per number rather than collapsing to pass/fail.
            const out = await sendSmsBulk({ teamId: sm.teamId, to: phones, message: r.sms_copy || '' });
            if (out.sent) sent.push(`SMS ${out.sent} (Salesmsg ${sm.phone})`);
            if (out.failed.length) failed.push(`Salesmsg: ${out.failed.length} of ${out.total} failed — ${out.failed[0].error}`);
            // AI-976. Salesmsg reports per number, so only the ones it actually accepted are
            // logged — writing a HubSpot interaction for a number it refused would put a message
            // on someone's timeline that never left the building.
            hubspotLog.push(...(out.sentNumbers || []).map(to => ({
              to, from: sm.phone, body: r.sms_copy || '', sentAt: new Date().toISOString(),
              outcome: 'sent via Salesmsg',
            })));
          } catch (e) {
            failed.push(`Salesmsg failed: ${String((e && e.message) || e)}`);
          }
        } else if (hookOk(smsHook)) {
          const messages = phones.map(to => ({ from: r.sms_from || undefined, to, text: r.sms_copy || '' }));
          const rr = await fetch(smsHook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbox-secret': webhookSecret }, body: JSON.stringify({ from: r.sms_from || undefined, messages }) });
          // HANDED OFF, NOT DELIVERED — and the wording matters. The n8n webhook answers
          // `responseMode: onReceived`, so this 200 means n8n accepted the payload. It does not
          // mean Telnyx accepted one message, and certainly not that a handset received one. The
          // old string ("SMS 1200") read as a delivery count, and on the strength of it the row
          // was marked sent and the market locked out for 14 days — a blast that Telnyx rejected
          // in full looked identical to one that worked.
          //
          // The true outcome arrives later and out-of-band, as Telnyx delivery receipts
          // (message.finalized -> telnyx_update_status via the inbound workflow). Those receipts
          // were never arriving because the send request did not ask for them; it now carries an
          // explicit webhook_url. Turning those receipts back into a per-blast delivered figure
          // additionally needs telnyx_messages to carry the queue row id, which it does not yet —
          // see GAPS.md. Until that exists, this string is a claim about OUR side only, and says so.
          (rr.ok ? sent : failed).push(rr.ok
            ? `SMS ${messages.length} handed off (delivery unconfirmed)`
            : `SMS failed (HTTP ${rr.status})`);
          // AI-976. Only on a successful handoff — a rejected webhook means nothing was queued to
          // send, and logging it would be recording an interaction that did not happen.
          //
          // The outcome is recorded as "handed off", NOT "delivered", for the same reason the
          // status string above says so: this 200 is n8n accepting the payload, not Telnyx
          // accepting a message. A HubSpot timeline claiming delivery we cannot evidence would
          // spread the very confusion GAPS.md gap 2 is about.
          if (rr.ok) {
            hubspotLog.push(...phones.map(to => ({
              to, from: r.sms_from || undefined, body: r.sms_copy || '',
              sentAt: new Date().toISOString(), outcome: 'handed off to Telnyx',
            })));
          }
        } else {
          failed.push('No SMS route: the row has no Salesmsg sender and BULK_SEND_WEBHOOK_URL is unset');
        }
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
      // PARTLY SENT (migration 058). Reaching here means at least one channel delivered — the
      // all-failed case returned above with the row untouched. But `sent` and `failed` are not
      // exclusive: SMS can go out while CakeMail throws, and until now that was recorded as a
      // plain 'sent' with the failure text discarded into the HTTP response.
      //
      // That only ever worked because sent rows stayed on screen in the Queue. The Queue now
      // hides them, so a half-failed blast would disappear while Market History logged just the
      // channel that worked — the failure would be invisible to everyone.
      //
      // Layered on top of queue_mark_sent rather than folded into it: that function is not
      // defined in this repo (live-DB only) and rewriting it blind would risk dropping whatever
      // else it does. This runs after it and only touches the two fields 058 owns.
      if (failed.length) {
        await rpc('queue_set_failures', {
          p_id: r.id,
          p_failures: failed.join(' | '),
          p_status: 'partial',
        });
      }
      // Write to the notebook so this market goes on cooldown. Per Josh: an email send
      // counts for both channels, so one row (market + day) cools email AND SMS.
      if (r.state_code && (phones.length || emails.length)) {
        await rpc('log_market_blast', {
          p_code: r.state_code, p_name: r.state_name || null,
          p_channel: emails.length ? 'Email' : 'SMS', p_queue_id: r.id,
          // Null for a whole-market row, which cools every segment (migration 049).
          p_segment: r.segment || null,
        });
      }
      // AI-976: log to HubSpot LAST, and never let it change what happened.
      //
      // It runs after queue_mark_sent and log_market_blast deliberately. The messages are already
      // gone; a CRM outage must not turn a delivered blast into a reported failure, delay the
      // next row, or — worst — throw between the send and the mark and leave a row that sent but
      // reads as unsent, which the hourly tick would then send again.
      let hubspot;
      if (hubspotLog.length && hubspotConfigured()) {
        try {
          hubspot = await logOutboundSmsBatch(hubspotLog);
        } catch (e) {
          hubspot = { error: String((e && e.message) || e) };
        }
      }
      results.push({ id: r.id, title: r.title, reason, sent, failed: failed.length ? failed : undefined, recipients: summary, cooldown_overridden: cooling || undefined, hubspot });
    }

    res.status(200).json({ ok: true, manual: !!onlyId, checked: q.length, due: due.length, sent: results, held, errors, webhooks: { sms: hookOk(smsHook), email: hookOk(emailHook), cakemail: CAKEMAIL_ACCOUNTS } });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
