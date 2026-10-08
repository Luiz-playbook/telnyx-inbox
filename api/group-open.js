// Open a group text thread with the agent in it (AI-1095).
//
// POST { members: ["+1…", "+1…"], text: "…", label?: "…" }
//   → { ok, group_id, conversation_id, members, telnyx_message_id }
//
// Creates the thread in public.mms_groups, sends the opening message from the relay number
// to every member as one group_mms, and logs it. From then on, any member's reply reaches
// api/group-relay.js and the assistant answers into the group.
//
// A SIGNED-IN PERSON, NOT A SCRIPT. requireCaller, same as "Send now" and the DNC upload.
// Opening a thread puts a message on real phones and starts a conversation the agent will
// carry on by itself, so it is an operator action. The CLI in scripts/ exists for the POC
// test and uses the cron secret, which is server-side only.
//
// Env: see lib/mms-groups.js.

import { requireCaller } from '../lib/auth.js';
import { ourNumber, norm, createGroup, logMessage, sendGroupMms } from '../lib/mms-groups.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const caller = await requireCaller(req);
  if (!caller) { res.status(401).json({ error: 'Sign in to open a group thread.' }); return; }

  const b = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const our = ourNumber();
  const members = [...new Set((Array.isArray(b.members) ? b.members : []).map(norm).filter(Boolean))].filter(n => n !== our);
  const text = String(b.text || '').trim();

  if (!members.length) { res.status(400).json({ error: 'members[] must hold at least one phone number other than ours' }); return; }
  if (!text) { res.status(400).json({ error: 'text is required' }); return; }
  // Three parties is the ticket; this cap stops a typo turning one thread into a broadcast
  // billed as MMS to every member. Raise it deliberately, not by accident.
  if (members.length > 9) { res.status(400).json({ error: `too many members (${members.length}); a thread is capped at 9 besides us` }); return; }

  try {
    const group = await createGroup({ our, members, label: b.label || null });
    const sent = await sendGroupMms({ from: our, to: members, text, webhookUrl: process.env.GROUP_RELAY_WEBHOOK_URL || undefined });
    await logMessage({ groupId: group.id, direction: 'outbound', from: our, to: members, body: text, telnyxId: sent.id, author: 'operator' });
    res.status(200).json({ ok: true, group_id: group.id, conversation_id: group.conversation_id, members, telnyx_message_id: sent.id });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
