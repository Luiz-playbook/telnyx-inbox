// Point the relay number at api/group-relay.js — and point it back (AI-1095).
//
//   node scripts/group-relay-setup.js --webhook https://<deployment>/api/group-relay            # dry run
//   node scripts/group-relay-setup.js --webhook https://<deployment>/api/group-relay --apply
//   node scripts/group-relay-setup.js --revert --apply
//
// WHAT IT CHANGES. Today the demo number (+16176160446) sits on the messaging profile Telnyx
// made for the assistant, which routes every inbound text into the assistant internally with
// no webhook. For a group thread the relay has to see those texts, so the number moves to a
// NEW profile, "group-relay", whose webhook is this app. The assistant keeps working: the
// relay hands it every message through its conversation API, and a plain 1:1 text is
// answered exactly as before (api/group-relay.js creates a 1:1 thread on the spot).
//
// REVERSIBLE IN ONE COMMAND. --revert moves the number back onto the assistant's own profile
// (id recorded below), and Telnyx answers 1:1 internally again. The group-relay profile is
// left in place, empty; deleting it is a separate, deliberate step.
//
// Nothing here buys anything or touches 10DLC: the campaign registration belongs to the
// number and comes with it.

import fs from 'node:fs';
import { telnyx, ourNumber } from '../lib/mms-groups.js';

for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('='); const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  if (!(k in process.env)) process.env[k] = v;
}

// The profile Telnyx created for the assistant when it was made. Where --revert sends the
// number back to.
const ASSISTANT_PROFILE_ID = '4001a111-13d4-4dd4-8814-f522c552b67a';
const RELAY_PROFILE_NAME = 'group-relay';

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const REVERT = args.includes('--revert');
const WEBHOOK = val('--webhook');

const number = ourNumber();

// Where the number is now.
const [num] = await telnyx(`/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(number)}`);
if (!num) { console.error('number not on this account:', number); process.exit(1); }
console.log(`number        : ${number}`);
console.log(`profile now   : ${num.messaging_profile_name || '(none)'}  (${num.messaging_profile_id || '-'})`);

if (REVERT) {
  console.log(`\nrevert        : move onto the assistant's profile ${ASSISTANT_PROFILE_ID}`);
  if (!APPLY) { console.log('--dry-run (add --apply to do it)'); process.exit(0); }
  await telnyx(`/phone_numbers/${num.id}/messaging`, { method: 'PATCH', body: { messaging_profile_id: ASSISTANT_PROFILE_ID } });
  const [after] = await telnyx(`/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(number)}`);
  console.log(`profile after : ${after.messaging_profile_name}  (${after.messaging_profile_id})`);
  process.exit(0);
}

if (!WEBHOOK || !/^https:\/\//.test(WEBHOOK)) { console.error('--webhook https://… is required (or --revert)'); process.exit(1); }

// Find or plan the relay profile.
const profiles = await telnyx('/messaging_profiles?page%5Bsize%5D=100');
const existing = (profiles || []).find(p => p.name === RELAY_PROFILE_NAME);
console.log(`relay profile : ${existing ? `exists (${existing.id}), webhook=${existing.webhook_url || '(none)'}` : 'will be created'}`);
console.log(`webhook       : ${WEBHOOK}`);
console.log(`\nplan          : ${existing ? 'update' : 'create'} profile "${RELAY_PROFILE_NAME}" with that webhook, then move ${number} onto it`);
if (!APPLY) { console.log('--dry-run (add --apply to do it)'); process.exit(0); }

let profile = existing;
if (!profile) {
  profile = await telnyx('/messaging_profiles', { method: 'POST', body: { name: RELAY_PROFILE_NAME, enabled: true, webhook_url: WEBHOOK, webhook_api_version: '2' } });
} else if (profile.webhook_url !== WEBHOOK) {
  profile = await telnyx(`/messaging_profiles/${profile.id}`, { method: 'PATCH', body: { webhook_url: WEBHOOK } });
}
await telnyx(`/phone_numbers/${num.id}/messaging`, { method: 'PATCH', body: { messaging_profile_id: profile.id } });

const [after] = await telnyx(`/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(number)}`);
console.log(`\nprofile after : ${after.messaging_profile_name}  (${after.messaging_profile_id})`);
console.log(`webhook after : ${profile.webhook_url}`);
console.log('\nDone. Set TELNYX_PUBLIC_KEY on the deployment or the relay refuses every webhook. Undo with --revert --apply.');
