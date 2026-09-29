// Inbound email replies from Mailhook → public.email_replies → the Replies tab.
//
// THE HALF THAT WAS MISSING. Migration 079 built email_replies and the Replies tab against it,
// and said so plainly: "the UI is being built against this now; the ingestion is not wired yet."
// This is the ingestion. Until it ran, every reply to every email blast went to the CakeMail
// sender's own mailbox and was invisible to this app — the table has stood empty since it was
// created.
//
// WHY AN INBOUND SERVICE AT ALL. CakeMail cannot give us replies and never could. It is an
// outbound ESP: when a recipient hits Reply their mail client sends to the From/Reply-To
// header, which is a real mailbox somewhere. CakeMail never sees the message, so there is no
// CakeMail endpoint to poll. Something has to own an address and hand us what arrives at it.
//
// HOW A REPLY KNOWS WHICH BLAST IT BELONGS TO. Not by parsing the subject line, which breaks
// the moment two markets share one. Mailhook does not support plus-addressing, but it does
// something better: metadata attached when the address is created comes back on the webhook.
// So the send path creates one address per blast carrying { queue_id, market_key, segment },
// and a reply identifies its own campaign with no guessing at all. data.metadata is the whole
// mechanism — see scripts/mailhook-test.js for the address-creation call.
//
// Payload (Mailhook llms.txt, verified 2026-09-29):
//   { event: "inbound_email", timestamp, data: { id, email_address, email_address_id, from,
//     from_name, subject, text_body, html_body, received_at, metadata, has_attachments } }
//
// Auth: X-Webhook-Signature — HMAC-SHA256 over the RAW body, hex, keyed with
// MAILHOOK_WEBHOOK_SECRET. Fails CLOSED: no secret configured means the route refuses every
// request rather than accepting anonymous writes into an operator-facing inbox.
// Env: MAILHOOK_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import crypto from 'node:crypto';
import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';

// The signature is computed over the bytes as they arrived. Vercel parses JSON into req.body by
// default, and re-serialising that object gives DIFFERENT bytes — different key order, different
// whitespace — so the HMAC would never match. This turns the parser off for this route only.
export const config = { api: { bodyParser: false }, maxDuration: 30 };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Constant-time, and length-checked first because timingSafeEqual throws on a length mismatch
// rather than returning false.
function signatureOk(raw, header, secret) {
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = String(header || '').trim().replace(/^sha256=/i, '');
  if (got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex')); }
  catch { return false; }
}

// Quoted-printable and long HTML make for a useless preview, and the column is for scanning a
// list. The full body is kept whole alongside it.
const preview = (text, html) => {
  const src = String(text || '').trim()
    || String(html || '').replace(/<[^>]+>/g, ' ');
  return src.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
};

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const secret = (process.env.MAILHOOK_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    // Deliberately not "open when unset", which is the pattern the cron routes in this directory
    // use and the reason six of them are currently reachable by anyone. An endpoint that writes
    // into an inbox a human reads and acts on does not get that treatment.
    res.status(503).json({ error: 'MAILHOOK_WEBHOOK_SECRET is not set — refusing unauthenticated inbound mail' });
    return;
  }

  let raw;
  try { raw = await readRaw(req); }
  catch { res.status(400).json({ error: 'could not read body' }); return; }

  if (!signatureOk(raw, req.headers['x-webhook-signature'], secret)) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: 'body is not JSON' }); return; }

  // Mailhook may send other event types later. Acknowledge them so it does not retry forever,
  // but write nothing.
  const event = String(body.event || '');
  if (event && event !== 'inbound_email') { res.status(200).json({ ok: true, ignored: event }); return; }

  const d = body.data || {};
  const from = String(d.from || '').trim().toLowerCase();
  if (!from) { res.status(400).json({ error: 'no sender address on the payload' }); return; }

  const meta = (d.metadata && typeof d.metadata === 'object') ? d.metadata : {};

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }

  const row = {
    // UNIQUE in the schema, and this is the point of it: Mailhook retries on a non-2xx, and a
    // retry must reconcile rather than post the same reply into the inbox twice.
    provider_message_id: d.id != null ? String(d.id) : null,
    // NOT 'mailhook'. Migration 083 defines this column as "which service the blast went out
    // through, so the reply can be traced back to it" — Mailhook is the catcher, not the
    // sender, and recording it here would make the Replies tab's cakemail filter permanently
    // empty while replies to CakeMail blasts piled up under a provider nobody looks for.
    // Overridable from metadata for when the Gmail mail-merge path joins the same webhook.
    provider: meta.provider || 'cakemail',
    from_email: from,
    to_email: String(d.email_address || '').trim().toLowerCase() || null,
    subject: d.subject || null,
    body: preview(d.text_body, d.html_body),
    // Straight off the address the blast was sent with — no subject parsing, no heuristics.
    campaign_id: meta.queue_id != null ? String(meta.queue_id) : (meta.campaign_id != null ? String(meta.campaign_id) : null),
    market_key: meta.market_key || meta.market || null,
    segment: meta.segment || null,
    received_at: d.received_at || new Date().toISOString(),
    // Kept whole, per migration 079: "Parsers improve and re-parsing beats re-asking the
    // provider for something it may no longer hold."
    raw: body,
  };

  try {
    const r = await fetch(`${url}/rest/v1/email_replies?on_conflict=provider_message_id`, {
      method: 'POST',
      headers: { ...supabaseHeaders(key), Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([row]),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      // 5xx so Mailhook retries — a reply lost to a transient database error is a lost lead.
      res.status(502).json({ error: `email_replies insert failed (HTTP ${r.status})`, detail: detail.slice(0, 400) });
      return;
    }
    const saved = await r.json().catch(() => null);
    res.status(200).json({
      ok: true,
      id: Array.isArray(saved) && saved[0] ? saved[0].id : null,
      from,
      matched_campaign: row.campaign_id || null,
      // Says out loud when a reply arrived with no metadata — it still lands in the inbox, but
      // it will not be attributed to a blast, and that is worth seeing in the logs.
      unattributed: row.campaign_id ? undefined : true,
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
