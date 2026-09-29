#!/usr/bin/env node
//
// Send a real CakeMail campaign to a throwaway Mailhook inbox and report what arrived.
//
// WHY THIS EXISTS. "Does CakeMail actually deliver?" has been unanswerable. The queue marks a
// row sent the moment CakeMail accepts the schedule call, and nothing after that point reports
// back — no delivery receipt, no bounce, nothing. Four blasts have ever gone out and we have
// never once seen what landed in a recipient's mailbox.
//
// This closes that loop without touching a real contact: Mailhook hands out a disposable
// address, we send one genuine campaign to it through the same lib/cakemail.js the queue uses,
// and then we read back the message CakeMail actually produced — subject, sender, HTML, and how
// long it took to arrive.
//
// IT SENDS A REAL EMAIL. Through the real account, from the real verified sender, counting
// against the real send quota. The only thing that is fake is the recipient.
//
// Usage:
//   node scripts/mailhook-test.js
//   node scripts/mailhook-test.js --account 1679456 --sender VRaDAQAVWKX6YzrXb63r
//   node scripts/mailhook-test.js --subject "Deliverability check" --wait 180
//   node scripts/mailhook-test.js --address someone@example.com   (skip Mailhook, send to a real inbox)
//
// Env:
//   MAILHOOK_AGENT_ID, MAILHOOK_API_KEY  — from app.mailhook.co
//   MAILHOOK_DOMAIN_ID                   — optional; a shared domain is created on first run
//   plus whichever CakeMail PAT the chosen account needs. lib/cakemail.js names the exact
//   variable in its error if it is missing, so run it and read the message.

import { sendCampaign, cakemailKey, cakemailKeyEnvName } from '../lib/cakemail.js';

const MH = 'https://app.mailhook.co/api/v1';

// The production sender — the same pair 84 of the 88 queued rows carry, so a pass here is
// evidence about the path the queue actually uses rather than about some test account.
const DEFAULT_ACCOUNT = '1761047';
const DEFAULT_SENDER = 'l4vuKoFJ5s9eJryDK0sV';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function mh(path, { method = 'GET', body } = {}) {
  const agent = (process.env.MAILHOOK_AGENT_ID || '').trim();
  const key = (process.env.MAILHOOK_API_KEY || '').trim();
  if (!agent || !key) die('set MAILHOOK_AGENT_ID and MAILHOOK_API_KEY (app.mailhook.co → API keys)');
  const r = await fetch(MH + path, {
    method,
    headers: { 'X-Agent-ID': agent, 'X-API-Key': key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep the text */ }
  if (!r.ok) die(`Mailhook ${method} ${path} → HTTP ${r.status}\n  ${text.slice(0, 400)}`);
  return json ?? text;
}

// A shared domain is enough for testing. A CUSTOM domain is what production replies need, and
// that is a DNS change on a dedicated subdomain — never the apex, which would take company mail
// down with it. See docs/mailhook.md.
async function ensureDomain() {
  const declared = (process.env.MAILHOOK_DOMAIN_ID || '').trim();
  if (declared) return declared;
  const existing = await mh('/domains').catch(() => null);
  const list = Array.isArray(existing) ? existing : (existing && existing.data) || [];
  const shared = list.find(d => d.domain_type === 'shared');
  if (shared) return String(shared.id);
  const made = await mh('/domains', {
    method: 'POST',
    body: { domain_type: 'shared', tailme_slug: `sendblaster-${Date.now().toString(36)}` },
  });
  return String((made && (made.id || (made.data && made.data.id))) || die('could not create a Mailhook domain'));
}

async function main() {
  const account = arg('account', DEFAULT_ACCOUNT);
  const sender = arg('sender', DEFAULT_SENDER);
  const waitSec = Number(arg('wait', '120'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const subject = arg('subject', `SendBlaster deliverability check ${stamp}`);

  if (!cakemailKey(account)) {
    die(`no CakeMail key for account ${account} — set ${cakemailKeyEnvName(account)}`);
  }

  // A fixed marker in the body. If this string comes back intact, the whole path preserved the
  // content; if it is mangled or missing, the template pipeline did something to it.
  const marker = `MH-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const html = `<html><body style="font-family:system-ui,sans-serif">
    <p>SendBlaster → CakeMail → Mailhook deliverability check.</p>
    <p>Marker: <b>${marker}</b></p>
    <p>Sent ${new Date().toISOString()} from account ${account}, sender ${sender}.</p>
    <p>If you are a person reading this, it is a test and needs no reply.</p>
  </body></html>`;

  let to = arg('address', null);
  let addressId = null;

  if (to) {
    console.log(`\nSending to the address given on the command line: ${to}`);
    console.log('Mailhook is skipped, so nothing here can confirm arrival — check that mailbox yourself.\n');
  } else {
    const domainId = await ensureDomain();
    // metadata is the whole trick for the production design too: whatever is attached here
    // comes back on the inbound webhook, so a reply identifies its own blast with no parsing.
    const made = await mh('/email_addresses/random', {
      method: 'POST',
      body: { domain_id: domainId, metadata: { purpose: 'cakemail-deliverability-test', marker, account, sender } },
    });
    const d = made.data || made;
    to = d.email_address || d.email || die(`Mailhook returned no address: ${JSON.stringify(made).slice(0, 300)}`);
    addressId = d.id;
    console.log(`\nMailhook inbox : ${to}`);
    console.log(`  address id   : ${addressId}`);
  }

  console.log(`CakeMail       : account ${account}, sender ${sender}`);
  console.log(`Subject        : ${subject}`);
  console.log(`Marker         : ${marker}\n`);

  const t0 = Date.now();
  let res;
  try {
    res = await sendCampaign({ accountId: account, senderId: sender, emails: [to], subject, html,
                               name: `deliverability-check ${stamp}` });
  } catch (e) {
    die(`CakeMail refused the send: ${(e && e.message) || e}`);
  }
  console.log(`✓ CakeMail accepted it in ${Date.now() - t0}ms`);
  console.log(`  list ${res.listId} · campaign ${res.campaignId} · ${res.recipients} recipient\n`);
  console.log('  NOTE: "accepted" is CakeMail agreeing to send, not proof of delivery. That is');
  console.log('  exactly the gap this script exists to close.\n');

  if (!addressId) { console.log('No Mailhook inbox to poll. Done.\n'); return; }

  process.stdout.write(`Waiting up to ${waitSec}s for it to land`);
  const deadline = Date.now() + waitSec * 1000;
  let got = null;
  while (Date.now() < deadline && !got) {
    await sleep(5000);
    process.stdout.write('.');
    const inbox = await mh(`/email_addresses/${addressId}/inbound_emails`).catch(() => null);
    const rows = Array.isArray(inbox) ? inbox : (inbox && inbox.data) || [];
    got = rows.find(m => String(m.subject || '').includes(stamp))
       || rows.find(m => `${m.text_body || ''}${m.html_body || ''}`.includes(marker))
       || rows[0] || null;
  }
  console.log('');

  if (!got) {
    console.log(`\n✗ Nothing arrived within ${waitSec}s.`);
    console.log('  CakeMail accepted the campaign, so the failure is after that point: still queued');
    console.log('  on their side, filtered, or bounced. Check the campaign in the CakeMail UI —');
    console.log(`  campaign id ${res.campaignId}. Re-run with --wait 300 before concluding.\n`);
    process.exit(2);
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  const htmlBody = got.html_body || '', textBody = got.text_body || '';
  console.log(`\n✓ DELIVERED in ~${secs}s\n`);
  console.log(`  from         : ${got.from_name ? got.from_name + ' ' : ''}<${got.from}>`);
  console.log(`  to           : ${got.email_address || to}`);
  console.log(`  subject      : ${got.subject}`);
  console.log(`  received_at  : ${got.received_at}`);
  console.log(`  html         : ${htmlBody.length} bytes`);
  console.log(`  text         : ${textBody.length} bytes`);
  console.log(`  attachments  : ${got.has_attachments ? 'yes' : 'no'}`);
  console.log(`  marker intact: ${(htmlBody + textBody).includes(marker) ? 'YES' : 'NO — the body was altered in transit'}`);
  // The From is what a recipient hits Reply on today, and therefore where every reply to every
  // blast has been going. Worth printing, because it is the answer to "where are our replies".
  console.log(`\n  Replies to this message would go to: ${got.from}`);
  console.log('');
}

main().catch(e => die((e && e.stack) || String(e)));
