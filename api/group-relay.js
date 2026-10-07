// Telnyx inbound webhook for the group-MMS relay number (AI-1095).
//
// WHAT HAPPENS. A member of a group thread texts. Telnyx delivers a copy to our relay number
// and calls this route. We find which thread the sender is in, hand their words to the
// assistant through its conversation API, and send the assistant's answer to every other
// member with group_mms. The assistant never knows it is in a group; this route is what makes
// it one. See lib/mms-groups.js for why the assistant is the brain and not a participant.
//
// A sender in NO thread gets a 1:1 thread created on the spot, so the demo number keeps
// answering plain texts exactly as it did when the assistant held it directly. Moving the
// number onto this relay therefore costs nothing visible.
//
// SIGNATURE FIRST, ALWAYS. This route sends messages that cost money and reach real phones.
// Every call is verified against Telnyx's Ed25519 public key over `${timestamp}|${rawBody}`
// before anything is read, with a five-minute replay window — the same recipe the n8n inbound
// workflow uses. There is no dev-mode bypass and there must never be one: an unsigned POST to
// this URL would otherwise be a free way to make the agent text anyone.
//
// IDEMPOTENT ON MESSAGE ID. Telnyx retries a webhook it did not get a 2xx for, and a group
// send is delivered to us once per thread member. Same message id each time; it is answered
// once and the rest are acknowledged and dropped.
//
// Env: TELNYX_PUBLIC_KEY (the account's webhook public key, base64, from Mission Control ->
//      Account -> Public Key), plus everything lib/mms-groups.js needs.

import crypto from 'node:crypto';
import {
  ourNumber, norm, findGroup, createGroup, logMessage, alreadyHandled, askAssistant, sendGroupMms,
} from '../lib/mms-groups.js';

// Vercel parses JSON into req.body by default, and re-serialising gives different bytes —
// different key order, different whitespace — so the signature would never match. Parser off.
export const config = { api: { bodyParser: false }, maxDuration: 60 };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Ed25519 over `${timestamp}|${rawBody}`. The key Telnyx publishes is the raw 32-byte public
// key in base64; Node wants it wrapped in a DER SPKI header to build a KeyObject.
export function telnyxSignatureOk({ raw, signatureB64, timestamp, publicKeyB64, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!signatureB64 || !timestamp || !publicKeyB64) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false;
  try {
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]);
    const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    const signed = Buffer.concat([Buffer.from(`${timestamp}|`, 'utf8'), raw]);
    return crypto.verify(null, signed, publicKey, Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const publicKeyB64 = (process.env.TELNYX_PUBLIC_KEY || '').trim();
  if (!publicKeyB64) {
    // Refuse rather than proceed unverified. A 500 here is visible in Telnyx's webhook log;
    // a silently-accepted unsigned payload is not.
    res.status(500).json({ error: 'TELNYX_PUBLIC_KEY is not set; refusing to accept unverified webhooks' });
    return;
  }

  const raw = await readRaw(req);
  const ok = telnyxSignatureOk({
    raw,
    signatureB64: req.headers['telnyx-signature-ed25519'],
    timestamp: req.headers['telnyx-timestamp'],
    publicKeyB64,
  });
  if (!ok) { res.status(401).json({ error: 'bad or stale Telnyx signature' }); return; }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'not JSON' }); return; }

  const data = (event && event.data) || {};
  const type = data.event_type || event.event_type;
  const p = data.payload || {};

  // Delivery receipts and anything else come here too (the same webhook_url serves the
  // profile). Only an inbound message is work; the rest is acknowledged so Telnyx stops
  // retrying it.
  if (type !== 'message.received') { res.status(200).json({ ok: true, ignored: type }); return; }

  const our = ourNumber();
  const to = norm(p.to && p.to[0] && p.to[0].phone_number);
  const from = norm(p.from && p.from.phone_number);
  const text = String(p.text || '').trim();
  const msgId = p.id || data.id || null;

  if (to !== our) { res.status(200).json({ ok: true, ignored: 'not the relay number', to }); return; }
  if (!from) { res.status(200).json({ ok: true, ignored: 'no sender' }); return; }
  if (await alreadyHandled(msgId)) { res.status(200).json({ ok: true, duplicate: msgId }); return; }

  try {
    let group = await findGroup(our, from);
    if (!group) group = await createGroup({ our, members: [from], label: `1:1 ${from}` });

    await logMessage({ groupId: group.id, direction: 'inbound', from, to: [our], body: text, telnyxId: msgId });

    // A media-only MMS has no text. The assistant is told that rather than being asked about
    // an empty string, which it would answer with a confused pleasantry.
    const answer = await askAssistant({
      conversationId: group.conversation_id,
      sender: from,
      text: text || '(sent an attachment with no text)',
    });
    if (!answer) { res.status(200).json({ ok: true, group: group.id, replied: false, reason: 'assistant returned nothing' }); return; }

    // To every member, which in a 1:1 thread is just the sender. group_mms with one recipient
    // is still the right call: it keeps one code path, and Telnyx sends it as a plain message.
    const members = (group.members || []).map(norm).filter(Boolean);
    const sent = await sendGroupMms({ from: our, to: members, text: answer, webhookUrl: process.env.GROUP_RELAY_WEBHOOK_URL || undefined });
    await logMessage({ groupId: group.id, direction: 'outbound', from: our, to: members, body: answer, telnyxId: sent.id, author: 'assistant' });

    res.status(200).json({ ok: true, group: group.id, replied: true, to: members.length });
  } catch (e) {
    // 500 so Telnyx retries, and the retry is safe: the inbound row is only written after the
    // thread is found, and alreadyHandled() sees it on the second attempt.
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
