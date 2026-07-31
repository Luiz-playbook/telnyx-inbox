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
// Env: ONE PAT PER SUB-ACCOUNT, resolved from the account_id being addressed —
// PBTESTACCOUNT_CAKEMAIL_AUTHORIZATION for 1679456 (pbtest@playbookemail.com),
// PBSPORTS_CAKEMAIL_AUTHORIZATION      for 1761047 (josh.marcus@callplaybook.com, production),
// PBSPORTS_COLE_CAKEMAIL_AUTHORIZATION for 1679383 (cole@ and the retired Josh sender).
//
// These are NOT interchangeable parent-level tokens, whatever this comment used to claim.
// The old code took PBSPORTS_* whenever it was set, so a send from the pbtest sender went
// out under PB Sports' token and CakeMail answered `POST /lists → 400: Forbidden` — a token
// may only build lists in the account that owns it. There is deliberately NO cross-account
// fallback now: a missing key fails with the name of the variable to set, because silently
// reaching for another account's token is exactly the bug being fixed.
//
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

// Sub-account id → env var prefix.
//
// Built from the environment first: every <PREFIX>_CAKEMAIL_ACCOUNT_ID var declares which
// account its sibling <PREFIX>_CAKEMAIL_AUTHORIZATION can address, so adding an account is a
// deployment change and not a code change. The literals below are the known ids, used only
// when no *_ACCOUNT_ID var is present.
// Updated 2026-07-31: the production Josh sender moved to a new sub-account, so
// PBSPORTS_CAKEMAIL now means 1761047, NOT 1679383. The old mapping is left corrected
// rather than deleted because it is the fallback — with the *_ACCOUNT_ID vars present the
// environment overrides all of this, but if they are ever missing, a stale literal would
// send under the wrong account's token and CakeMail answers `POST /lists → 400: Forbidden`.
const FALLBACK_ACCOUNT_ENV = {
  '1679456': 'PBTESTACCOUNT_CAKEMAIL',   // pbtest@playbookemail.com — the proven test sender
  '1761047': 'PBSPORTS_CAKEMAIL',        // josh.marcus@callplaybook.com — production
  '1679383': 'PBSPORTS_COLE_CAKEMAIL',   // cole@ / the retired Josh sender; no longer offered
};

function accountEnvMap() {
  const map = { ...FALLBACK_ACCOUNT_ENV };
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^(.+)_CAKEMAIL_ACCOUNT_ID$/.exec(k);
    const id = (v || '').trim();
    if (m && id) map[id] = `${m[1]}_CAKEMAIL`;    // declared wins over the literals
  }
  return map;
}

const readEnv = (...names) => {
  for (const n of names) { const v = (process.env[n] || '').trim(); if (v) return v; }
  return '';
};

// The variable to set when a key is missing — used verbatim in the error, so the fix is
// obvious from the message alone.
export function cakemailKeyEnvName(accountId) {
  const prefix = accountEnvMap()[String(accountId || '')];
  return prefix ? `${prefix}_AUTHORIZATION` : `CAKEMAIL_PAT_${accountId || '<account_id>'}`;
}

// The PAT for ONE account. CAKEMAIL_PAT stays supported as a single-account fallback; a
// token belonging to a *different* sub-account is never substituted.
export function cakemailKey(accountId) {
  const id = String(accountId || '');
  const prefix = accountEnvMap()[id];
  const raw = readEnv(
    ...(id ? [`CAKEMAIL_PAT_${id}`] : []),
    ...(prefix ? [`${prefix}_AUTHORIZATION`, `${prefix}_PAT`] : []),
    'CAKEMAIL_PAT',
  );
  // These vars are named *_AUTHORIZATION, so the whole header value ("Bearer eyJ…") may well
  // have been pasted in. call() adds its own "Bearer ", and the doubled prefix fails every
  // request. Accept either form.
  return raw.replace(/^Bearer\s+/i, '');
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
  replyTo = null, name = null, tags = [], key = null,
}) {
  if (!accountId) throw new Error('cakemail: accountId is required');
  key = key || cakemailKey(accountId);
  if (!key) throw new Error(`cakemail: no API key for account ${accountId} — set ${cakemailKeyEnvName(accountId)} on the server`);
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
