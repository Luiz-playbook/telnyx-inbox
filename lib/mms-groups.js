// Group MMS threads with the Telnyx assistant in them (AI-1095). Shared by the relay webhook
// (api/group-relay.js), the opener (api/group-open.js) and the CLI (scripts/open-group-thread.js).
//
// THE DESIGN, AND WHY IT IS NOT "PUT THE ASSISTANT'S NUMBER IN THE GROUP".
//
// A Telnyx AI assistant with the messaging feature answers texts that reach its messaging
// profile — internally, with no webhook and no hook for us. It is documented as 1:1 and
// nothing in its docs mentions group threads. Dropping its number into a group would mean
// trusting undocumented behaviour with a real lead on the line, and if it replied 1:1 to the
// lead instead of to the group, the lead would see two parallel conversations.
//
// So the assistant is the BRAIN, not a participant. Our relay number is the participant. An
// inbound group message reaches the relay webhook; we hand the text to the assistant through
// its conversation API (the same call used to verify it 1:1), take its answer, and send that
// to every other member with group_mms. The assistant never knows it is in a group; the relay
// is what makes it one. Everything about the group is in public.mms_groups, because Telnyx
// has no group object and its inbound webhook carries a single `to` — the only record of who
// is in a thread is ours.
//
// Env: TELNYX_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      GROUP_RELAY_NUMBER (default +16176160446, the AI-1095 demo number),
//      GROUP_RELAY_ASSISTANT_ID (default the Fernway demo assistant).

import { supabaseKey, supabaseHeaders } from './supabase.js';

const TELNYX = 'https://api.telnyx.com/v2';

export const ourNumber   = () => (process.env.GROUP_RELAY_NUMBER || '+16176160446').trim();
export const assistantId = () => (process.env.GROUP_RELAY_ASSISTANT_ID || 'assistant-81df6551-e27d-48ac-99b4-eaa398ed1afb').trim();

const key = () => {
  const k = (process.env.TELNYX_API_KEY || '').trim();
  if (!k) throw new Error('TELNYX_API_KEY is not set');
  return k;
};

export async function telnyx(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${TELNYX}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const detail = json && json.errors && json.errors[0] ? `${json.errors[0].title}: ${json.errors[0].detail}` : text.slice(0, 200);
    const err = new Error(`telnyx ${method} ${path} -> ${res.status} ${detail}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json && json.data !== undefined ? json.data : json;
}

// ── Supabase, through PostgREST with the service role ───────────────────────────────────
const supa = () => {
  const url = (process.env.SUPABASE_URL || '').trim(), k = supabaseKey();
  if (!url || !k) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return { url, h: supabaseHeaders(k) };
};

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const { url, h } = supa();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { ...h, ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return null; }
}

// E.164, loosely. The relay compares numbers for membership, so they have to be in one form.
export const norm = (v) => {
  const s = String(v || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.length === 10) return `+1${s}`;
  if (s.length === 11 && s.startsWith('1')) return `+${s}`;
  return `+${s}`;
};

// The thread a message from `sender` to `our` belongs to. Membership is the key: Telnyx's
// inbound webhook cannot tell us, so the sender being in a group's members IS the lookup.
// Newest open thread wins when a lead is in more than one — the most recent is the live one.
export async function findGroup(our, sender) {
  const rows = await rest(`mms_groups?our_number=eq.${encodeURIComponent(our)}&status=eq.open`
    + `&members=cs.${encodeURIComponent('{' + sender + '}')}&order=created_at.desc&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export async function getGroup(id) {
  const rows = await rest(`mms_groups?id=eq.${encodeURIComponent(id)}&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// A new thread. One Telnyx AI conversation per thread, so the assistant's memory of this
// lead never bleeds into another thread with the same lead.
export async function createGroup({ our, members, label }) {
  const conv = await telnyx('/ai/conversations', { method: 'POST', body: { assistant_id: assistantId(), name: label || `group ${members.join(', ')}` } });
  const rows = await rest('mms_groups', {
    method: 'POST', prefer: 'return=representation',
    body: { our_number: our, members, conversation_id: conv && conv.id, label: label || null },
  });
  return rows[0];
}

export async function logMessage({ groupId, direction, from, to, body, telnyxId, author }) {
  await rest('mms_group_messages', {
    method: 'POST', prefer: 'return=minimal',
    body: { group_id: groupId, direction, from_number: from, to_numbers: to, body: body || null, telnyx_message_id: telnyxId || null, author: author || null },
  });
  await rest(`mms_groups?id=eq.${encodeURIComponent(groupId)}`, { method: 'PATCH', prefer: 'return=minimal', body: { last_message_at: new Date().toISOString() } });
}

// Telnyx retries a webhook it did not get a 2xx for, and a group message is delivered to us
// once per member we share a thread with. Both arrive with the same message id. Answering
// twice would send the lead two replies, so the id is the idempotency key.
export async function alreadyHandled(telnyxId) {
  if (!telnyxId) return false;
  const rows = await rest(`mms_group_messages?telnyx_message_id=eq.${encodeURIComponent(telnyxId)}&select=id&limit=1`);
  return Array.isArray(rows) && rows.length > 0;
}

// The assistant's answer, through its conversation API — the same call that verified it 1:1.
// The sender is named in the content because in a group the assistant needs to know WHO
// said it; the conversation history alone cannot tell two members apart.
export async function askAssistant({ conversationId, sender, text }) {
  const out = await telnyx(`/ai/assistants/${assistantId()}/chat`, {
    method: 'POST',
    body: { conversation_id: conversationId, content: `[From ${sender}] ${text}` },
  });
  return (out && out.content) || (out && out.data && out.data.content) || '';
}

// One group message, delivered to every member. Telnyx bills each delivery (see the AI-1095
// cost outline); a three-party thread is two deliveries per send.
export async function sendGroupMms({ from, to, text, webhookUrl }) {
  const out = await telnyx('/messages/group_mms', {
    method: 'POST',
    body: { from, to, text, ...(webhookUrl ? { webhook_url: webhookUrl } : {}) },
  });
  return { id: out && out.id, raw: out };
}
