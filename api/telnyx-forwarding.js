// Call forwarding on the sender numbers — read it, and change it (AI-1077).
//
// WHAT THIS IS FOR. A blast goes out from one of our numbers, somebody calls it back, and the
// call reaches nobody: these numbers have no voice route and no voicemail, so a callback from a
// prospect is simply lost. Forwarding points them all at one phone that a human answers.
//
// WHY IT NEEDS A SCREEN AT ALL, rather than the Telnyx console. Two reasons, both learned the
// hard way on 2026-10-05. The account holds 495 numbers and only a handful are ours to touch —
// most belong to the voice-AI work and already have an assistant answering, so "which numbers"
// is not obvious from the console and getting it wrong silently breaks something that works.
// And the destination is going to change: it is Cole's mobile today and a voice agent later
// (AI-713), so this should not be a thing one engineer does by hand each time.
//
// ⚠️ VOICE ONLY. NEVER TOUCHES MESSAGING. These numbers are live 10DLC SMS senders — Ticketblast
// alone carries about 90% of outbound volume — and this route writes to /voice and nothing else.
// The messaging_profile_id is read and displayed so the operator can SEE it is untouched, and is
// never included in a write. If you are extending this, keep it that way: a number that silently
// stops texting looks like a deliverability problem and would take weeks to trace back here.
//
// ⚠️ WHAT IT WILL NOT TOUCH. A number with a voice connection already attached is listed but
// cannot be changed from here (`locked: true`). Those are the AI assistants, and forwarding runs
// BEFORE connection routing on Telnyx, so switching it on would take the call away from the
// assistant without any warning. Unlocking that is a decision for whoever owns the voice work,
// not a checkbox on this page.
//
// Env: TELNYX_API_KEY (server-side only), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { requireCaller } from '../lib/auth.js';
import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';

export const config = { maxDuration: 60 };

const TELNYX = 'https://api.telnyx.com/v2';

// E.164, loosely: a plus and 8-15 digits. Deliberately not stricter — the destination is an
// ordinary mobile that could be in any country, and a regex that knows better than the operator
// about their own phone number is a support ticket waiting to happen.
const E164 = /^\+[1-9]\d{7,14}$/;

// TELNYX ATTACHES ITS OWN CONNECTION WHEN FORWARDING IS TURNED ON, named "Forward Only". It is
// not a voice app anybody built - it is the plumbing that makes forwarding work, and it appears
// as a side effect of the very thing this page does.
//
// That matters because "has a connection" is otherwise exactly how we identify a number an AI
// assistant answers, which must never be touched. Counting Telnyx's own artefact as such locked
// every number the moment it was forwarded, so the off switch stopped working on the only rows
// that had anything to switch off. Found on 2026-10-06, after forwarding the first ten.
const FORWARDING_CONNECTION = 'Forward Only';
const answeredBySomethingElse = n =>
  !!n.connection_id && String(n.connection_name || '').trim() !== FORWARDING_CONNECTION;

async function telnyx(path, key, init) {
  const r = await fetch(`${TELNYX}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init && init.headers) },
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { ok: r.ok, status: r.status, body, text };
}

// The numbers we consider ours: whatever telnyx_senders holds. That table is the one place that
// knows which numbers belong to the blaster, and it is already what the Reports tab reads.
//
// It is NOT a clean list, and this route must not assume it is — it is partly hand-seeded and
// partly auto-discovered from traffic by telnyx-usage-sync, which writes a row for any number it
// sees sending. It contains at least one row whose phone_number is not a phone number at all
// ('Luiz', 2026-09-17). So anything that is not E.164 is dropped here rather than being sent to
// Telnyx as a lookup that cannot succeed.
async function senderNumbers() {
  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) return [];
  const r = await fetch(`${url}/rest/v1/telnyx_senders?select=phone_number,label,active&active=eq.true`, {
    headers: supabaseHeaders(key),
  });
  if (!r.ok) return [];
  const rows = await r.json().catch(() => []);
  return (rows || [])
    .filter(x => x && E164.test(String(x.phone_number || '').trim()))
    .map(x => ({ phone_number: String(x.phone_number).trim(), label: x.label || '' }));
}

export default async function handler(req, res) {
  const caller = await requireCaller(req);
  if (!caller) { res.status(401).json({ error: 'Sign in to view or change call forwarding.' }); return; }

  const key = (process.env.TELNYX_API_KEY || '').trim();
  if (!key) { res.status(500).json({ error: 'TELNYX_API_KEY is not set on the server' }); return; }

  // ── READ ──────────────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const senders = await senderNumbers();
    if (!senders.length) { res.status(200).json({ ok: true, numbers: [], note: 'no sender numbers found' }); return; }

    // One lookup per number. 24 of them, and Telnyx has no bulk filter that takes a list, so
    // this is the honest shape rather than a clever one. maxDuration 60 covers it comfortably.
    const out = [];
    for (const s of senders) {
      const q = await telnyx(`/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(s.phone_number)}`, key);
      const hit = q.ok && q.body && Array.isArray(q.body.data) && q.body.data[0];
      if (!hit) {
        // A sender we cannot see. Three of them live on a DIFFERENT Telnyx account from the one
        // this key belongs to, including the most-used sender of all. Shown rather than hidden:
        // a number missing from this list without explanation reads as a bug in the page.
        out.push({ phone_number: s.phone_number, label: s.label, on_this_account: false });
        continue;
      }
      const v = await telnyx(`/phone_numbers/${hit.id}/voice`, key);
      const cf = (v.ok && v.body && v.body.data && v.body.data.call_forwarding) || {};
      out.push({
        phone_number: s.phone_number,
        label: s.label,
        on_this_account: true,
        id: hit.id,
        forwarding: !!cf.call_forwarding_enabled,
        forwards_to: cf.forwards_to || '',
        // Shown so the operator can see for themselves that changing a call route left texting
        // alone. This is the reassurance the page exists to give.
        messaging_profile: hit.messaging_profile_name || '',
        // A number already answered by something else. Listed, never editable here. The
        // forwarding plumbing does not count - see answeredBySomethingElse.
        locked: answeredBySomethingElse(hit),
        connection_name: hit.connection_name || '',
      });
    }
    res.status(200).json({ ok: true, numbers: out });
    return;
  }

  // ── WRITE ─────────────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const b = req.body && typeof req.body === 'object' ? req.body : (() => {
      try { return JSON.parse(req.body || '{}'); } catch { return {}; }
    })();

    const enable = !!b.enable;
    const to = String(b.forwards_to || '').trim();
    const wanted = Array.isArray(b.numbers) ? b.numbers.map(x => String(x).trim()) : [];

    if (!wanted.length) { res.status(400).json({ error: 'numbers[] is required' }); return; }
    if (enable && !E164.test(to)) {
      res.status(400).json({ error: 'forwards_to must be in +15551234567 form' });
      return;
    }

    // Only numbers this account actually holds, that are senders, and that nothing else answers.
    // Checked HERE and not trusted from the browser: the page is the usual caller, but it is not
    // the only possible one, and the "do not take a call away from a voice assistant" rule has
    // to live where it cannot be skipped.
    const senders = new Set((await senderNumbers()).map(s => s.phone_number));
    const results = [];
    for (const num of wanted) {
      if (!senders.has(num)) { results.push({ phone_number: num, ok: false, error: 'not one of our sender numbers' }); continue; }
      const q = await telnyx(`/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(num)}`, key);
      const hit = q.ok && q.body && Array.isArray(q.body.data) && q.body.data[0];
      if (!hit) { results.push({ phone_number: num, ok: false, error: 'not on this Telnyx account' }); continue; }
      if (answeredBySomethingElse(hit)) {
        results.push({ phone_number: num, ok: false, error: `answered by ${hit.connection_name || 'a voice connection'} — not changed` });
        continue;
      }
      const payload = enable
        ? { call_forwarding: { call_forwarding_enabled: true, forwards_to: to, forwarding_type: 'always' } }
        : { call_forwarding: { call_forwarding_enabled: false, forwards_to: '', forwarding_type: '' } };
      const w = await telnyx(`/phone_numbers/${hit.id}/voice`, key, { method: 'PATCH', body: JSON.stringify(payload) });
      results.push(w.ok
        ? { phone_number: num, ok: true, forwarding: enable, forwards_to: enable ? to : '' }
        : { phone_number: num, ok: false, error: `Telnyx HTTP ${w.status}`, detail: (w.text || '').slice(0, 200) });
    }

    const changed = results.filter(r => r.ok).length;
    res.status(200).json({ ok: true, changed, skipped: results.length - changed, results });
    return;
  }

  res.status(405).json({ error: 'GET or POST only' });
}
