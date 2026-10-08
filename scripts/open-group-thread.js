// Open a group text thread from the command line, for the AI-1095 test.
//
//   node scripts/open-group-thread.js --to +15551234567 --to +15557654321 --text "Hi both — this is Fernway Bicycle Co. Who's picking up the rental on Saturday?"
//   node scripts/open-group-thread.js --to +15551234567 --text "…" --dry-run
//
// Talks to Telnyx and Supabase directly with the keys in .env — no deploy needed to OPEN a
// thread. Replies, though, only get answered once api/group-relay.js is deployed and the relay
// number's messaging profile points its webhook at it (scripts/group-relay-setup.js). Opening
// a thread before that is fine: the lead's reply will simply sit unanswered until the relay
// is live, and then the next one is answered.
//
// Sends a real message to real phones. --dry-run shows exactly what it would send and sends
// nothing; use it first.

import fs from 'node:fs';
import { ourNumber, norm, createGroup, logMessage, sendGroupMms } from '../lib/mms-groups.js';

for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('='); const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  if (!(k in process.env)) process.env[k] = v;
}

const args = process.argv.slice(2);
const to = [];
let text = '', label = null, dry = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--to' && args[i + 1]) to.push(args[++i]);
  else if (args[i] === '--text' && args[i + 1]) text = args[++i];
  else if (args[i] === '--label' && args[i + 1]) label = args[++i];
  else if (args[i] === '--dry-run') dry = true;
}

const our = ourNumber();
const members = [...new Set(to.map(norm).filter(Boolean))].filter(n => n !== our);
if (!members.length || !text) {
  console.error('usage: --to +1… [--to +1…] --text "…" [--label "…"] [--dry-run]');
  process.exit(1);
}

console.log(`from    : ${our}`);
console.log(`to      : ${members.join(', ')}  (${members.length} deliveries, billed as MMS each)`);
console.log(`text    : ${text}`);
if (dry) { console.log('\n--dry-run: nothing sent, nothing recorded.'); process.exit(0); }

const group = await createGroup({ our, members, label });
console.log(`group   : ${group.id}`);
console.log(`convo   : ${group.conversation_id}`);
const sent = await sendGroupMms({ from: our, to: members, text, webhookUrl: process.env.GROUP_RELAY_WEBHOOK_URL || undefined });
await logMessage({ groupId: group.id, direction: 'outbound', from: our, to: members, body: text, telnyxId: sent.id, author: 'operator' });
console.log(`telnyx  : ${sent.id}`);
console.log('\nSent. Reply from one of the member phones; the relay answers the whole thread once it is live.');
