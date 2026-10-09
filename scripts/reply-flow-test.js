// End-to-end test of the REPLY path: CakeMail send -> real Reply-To -> your inbox -> reply ->
// n8n -> /api/email-reply -> email_replies -> the Replies tab.
//
// WHY THIS EXISTS RATHER THAN "press Send now". The queue's own send resolves a whole market's
// audience, and send_allowlist -- the one thing that stops a send reaching real customers -- is
// currently EMPTY, meaning test mode is OFF. Pressing Send now to test the reply path would mail
// thousands of real people. This sends ONE email, to an address you name, through the same
// lib/cakemail.js the queue uses and with the same return address lib/reply-address.js builds,
// so everything downstream of the send is exercised for real.
//
// WHAT IT COVERS:     address building, CakeMail accepting reply_to_email, real delivery, the
//                     Reply-To header arriving intact, and -- once you hit Reply -- the n8n
//                     trigger, the +q guard, the endpoint, attribution and the Replies tab.
// WHAT IT DOES NOT:   api/queue-tick.js choosing rows and resolving audiences. That is covered
//                     separately by calling the tick with the allowlist armed, which resolves
//                     zero recipients and sends nothing -- see docs/documentation/email-replies.md.
//
// Usage:
//   node scripts/reply-flow-test.js --to you@example.com --queue-id <campaign_queue uuid>
//   node scripts/reply-flow-test.js --to you@example.com          (picks a real queue row for you)
//
// Env: the CakeMail key for the account being sent from (see lib/cakemail.js), SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY when --queue-id is omitted.

import { sendCampaign, cakemailKey, cakemailKeyEnvName } from '../lib/cakemail.js';
import { replyAddressFor, replyMailbox } from '../lib/reply-address.js';
import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';

// The production sender pair, so this tests the path real blasts take.
const DEFAULT_ACCOUNT = '1761047';
const DEFAULT_SENDER = 'l4vuKoFJ5s9eJryDK0sV';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

async function pickQueueRow() {
  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) die('set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --queue-id');
  const r = await fetch(
    `${url}/rest/v1/campaign_queue?select=id,title,segment,state_code&order=created_at.desc&limit=1`,
    { headers: supabaseHeaders(key) });
  if (!r.ok) die(`could not read campaign_queue (HTTP ${r.status})`);
  const rows = await r.json();
  if (!rows || !rows[0]) die('campaign_queue is empty — pass --queue-id');
  return rows[0];
}

async function main() {
  const to = arg('to');
  if (!to) die('pass --to <an address you can read and reply from>');

  // NOT the reply mailbox itself. Mail sent from an address to a +tag of the SAME address threads
  // oddly in Gmail and makes a first test hard to read. Use a different mailbox.
  if (to.split('@')[0].split('+')[0].toLowerCase() === replyMailbox().split('@')[0]) {
    console.log(`\n⚠  ${to} looks like the reply mailbox itself (${replyMailbox()}).`);
    console.log('   Sending and replying within one mailbox muddies the test. Prefer another.\n');
  }

  const account = arg('account', DEFAULT_ACCOUNT);
  const sender = arg('sender', DEFAULT_SENDER);
  if (!cakemailKey(account)) die(`no CakeMail key for account ${account} — set ${cakemailKeyEnvName(account)}`);

  let queueId = arg('queue-id');
  let label = 'the row you named';
  if (!queueId) {
    const row = await pickQueueRow();
    queueId = row.id;
    label = `${row.title} (${row.state_code || '—'} · ${row.segment || 'whole market'})`;
  }

  const replyTo = replyAddressFor(queueId);
  if (!replyTo) die(`could not build a return address for ${queueId} — is it a uuid?`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const subject = arg('subject', `Playbook reply-path test ${stamp}`);
  const html = `<html><body style="font-family:system-ui,sans-serif">
    <p>This is a test of the reply path. <b>Please hit Reply and send anything back.</b></p>
    <p>Your reply should appear in the app's Replies tab within a minute or two.</p>
    <p style="color:#888;font-size:12px">Blast: ${label}<br>Sent ${new Date().toISOString()}</p>
  </body></html>`;

  console.log(`\nTo            : ${to}`);
  console.log(`Blast         : ${label}`);
  console.log(`Reply-To      : ${replyTo}`);
  console.log(`CakeMail      : account ${account}, sender ${sender}`);
  console.log(`Subject       : ${subject}\n`);

  let res;
  try {
    res = await sendCampaign({
      accountId: account, senderId: sender, emails: [to], subject, html,
      replyTo,
      name: `reply-path-test ${stamp}`,
      tags: ['telnyx-inbox', 'reply-path-test'],
    });
  } catch (e) {
    die(`CakeMail refused the send: ${(e && e.message) || e}`);
  }

  console.log(`✓ CakeMail accepted it — list ${res.listId}, campaign ${res.campaignId}, ${res.recipients} recipient\n`);
  console.log('  "Accepted" is CakeMail agreeing to send, NOT proof of delivery.\n');
  console.log('NEXT, and the part that actually tests the new path:');
  console.log(`  1. Open the mail in ${to}. Check the Reply-To really is the +q address above —`);
  console.log('     if it is missing, the failure is in the SEND half and no reply can ever work.');
  console.log('  2. Hit Reply. Send anything.');
  console.log('  3. Within ~2 minutes it should appear in the Replies tab, tagged with the');
  console.log("     blast's market and segment — neither of which travels in the email.\n");
}

main().catch(e => die((e && e.stack) || String(e)));
