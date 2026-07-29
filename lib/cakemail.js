// Shared CakeMail send path — called directly from our own API, no n8n hop. ONE
// implementation used by both the cron auto-send (api/queue-tick.js) and the on-demand
// endpoint (api/cakemail-send.js), so the two can never drift.
//
// CakeMail is LIST-based, not per-recipient: a market blast is one campaign against one
// list. The sequence below is the one verified against the live API (campaign 15388188,
// delivered): create list → accept policy → import contacts → create campaign → schedule.
// Five calls total regardless of recipient count, so a 1,800-address market finishes well
// inside the function timeout — do NOT rewrite this as a per-recipient loop.
//
// Env: PBSPORTS_CAKEMAIL_AUTHORIZATION (the real sender account), falling back to
// PBTESTACCOUNT_CAKEMAIL_AUTHORIZATION then CAKEMAIL_PAT. All are parent-level PATs on
// account 1594688 "Playbook Mail", so any of them can address any sub-account — which
// sub-account is used comes from the account_id in the row's email_from, not from the key.
// SERVER-SIDE ONLY — never add to scripts/gen-config.js, because ui/config.js is served
// to every visitor.
//
// Deliverability note: callplaybook.com is deliberately left unauthenticated (Cole,
// permanent) so CakeMail signs with its own domain. Sending requires a CONFIRMED sender,
// not DKIM. Two brand-new empty sub-accounts were refused at schedule time with "Action
// blocked due to a low account score" — most likely account maturity, not the missing DKIM.
// That error is surfaced verbatim rather than swallowed: it is a config/account problem,
// not a transient one, and retrying will not help.

const BASE = 'https://api.cakemail.dev';

export function cakemailKey() {
  return (process.env.PBSPORTS_CAKEMAIL_AUTHORIZATION
       || process.env.PBTESTACCOUNT_CAKEMAIL_AUTHORIZATION
       || process.env.CAKEMAIL_PAT
       || '').trim();
}

// Every CakeMail call is scoped by ?account_id= — senders and lists live in a sub-account,
// and the PAT is a parent token that can address several.
async function call(path, { method = 'GET', accountId, key, body } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${BASE}${path}${sep}account_id=${encodeURIComponent(accountId)}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const d = json && json.detail;
    const msg = Array.isArray(d) ? d.map(x => x.msg || JSON.stringify(x)).join('; ')
              : (typeof d === 'string' ? d : (text || `HTTP ${r.status}`));
    const err = new Error(`CakeMail ${method} ${path} → ${r.status}: ${msg}`);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

// Runs the full sequence and returns { listId, campaignId, recipients }.
// Throws with the CakeMail message intact on any step — a half-built campaign is left in
// place deliberately so the failure can be inspected in the CakeMail UI.
export async function sendCampaign({
  accountId, senderId, emails, subject, html,
  replyTo = null, name = null, tags = [], key = cakemailKey(),
}) {
  if (!key) throw new Error('CAKEMAIL_PAT is not set on the server');
  if (!accountId) throw new Error('cakemail: accountId is required');
  if (!senderId) throw new Error('cakemail: senderId is required');
  if (!subject) throw new Error('cakemail: subject is required');

  const to = [...new Set((emails || []).map(e => (e || '').trim().toLowerCase()).filter(validEmail))];
  if (!to.length) throw new Error('cakemail: no valid recipient addresses');

  const label = name || subject;
  const opts = { accountId, key };

  // 1. List. default_sender is what the UI shows; the campaign still sets sender explicitly.
  const list = await call('/lists', {
    ...opts, method: 'POST',
    body: { name: label, default_sender: { id: senderId }, language: 'en_US' },
  });
  const listId = list && list.id;
  if (!listId) throw new Error('cakemail: list create returned no id');

  // 2. Policy. Lists are created policy_accepted:false and will NOT send until accepted.
  await call(`/lists/${listId}/accept-policy`, { ...opts, method: 'POST' });

  // 3. Contacts — one call for the whole market.
  //
  // resubscribe/remove_tags/remove_interests are deliberately NOT set. The old Space Agent
  // workflow sent resubscribe:true, which force-resubscribes addresses that previously
  // opted out — the exact pattern anti-abuse scoring penalises, and a compliance problem
  // in its own right. Someone who unsubscribed must stay unsubscribed.
  await call(`/lists/${listId}/import-contacts`, {
    ...opts, method: 'POST',
    body: { contacts: to.map(email => ({ email })), import_to: 'active' },
  });

  // 4. Campaign. default_unsubscribe_link is required for CAN-SPAM/CASL on marketing sends.
  const campaign = await call('/campaigns', {
    ...opts, method: 'POST',
    body: {
      audience: { list_id: listId },
      sender: { id: senderId },
      content: { type: 'html', subject, html, default_unsubscribe_link: true },
      name: label,
      ...(replyTo ? { reply_to_email: replyTo } : {}),
      ...(tags.length ? { tags } : {}),
    },
  });
  const campaignId = campaign && campaign.id;
  if (!campaignId) throw new Error('cakemail: campaign create returned no id');

  // 5. Schedule — this is the call that actually mails.
  await call(`/campaigns/${campaignId}/schedule`, { ...opts, method: 'POST' });

  return { listId, campaignId, recipients: to.length };
}

// 'cakemail:<account_id>:<sender_id>' → { accountId, senderId }; anything else → null.
// Mirrors cakemailSender in ui/index.html — keep both in sync.
export const parseCakemailFrom = v => {
  const m = /^cakemail:([^:]+):(.+)$/.exec(String(v || ''));
  return m ? { accountId: m[1], senderId: m[2] } : null;
};
