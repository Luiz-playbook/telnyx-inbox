// SendBlaster -> the HubSpot <-> Telnyx bulk sender (AI-965, option A: "stage & arm").
//
// WHAT THIS REPLACES. Until now a Telnyx blast left this app as one POST to an n8n webhook and
// was marked "handed off (delivery unconfirmed)" — because that is all a 200 from n8n meant.
// Nothing recorded who was sent to, no delivery receipt came back, and the workflow itself
// turned out to hardcode a sender that had been dormant since August. There was no evidence a
// single SendBlaster SMS ever reached a handset.
//
// WHAT THIS JOINS. Charles's bulk sender already runs essentially all blast volume (35,129 of
// 35,852 messages in the eight days to 2026-09-22) through a Postgres queue that carries, per
// recipient: one shared opt-out list, TCPA quiet hours by area code, duplicate protection
// across two contacts on one handset, an outbox row that makes a crashed retry collide rather
// than double-send, carrier halts, and per-message delivery receipts. Every one of those was
// written after a production incident. This module does not re-implement any of it — it hands
// the audience over and lets that queue do the sending.
//
// THE FOUR CALLS, from the AI-965 brief:
//   GET  /api/routes                 which numbers may we send from, and are they inbox-ready
//   POST /api/campaigns/external     stage: validate, dedupe, return a census. Sends nothing.
//   POST /api/campaigns/:id/arm      the point of no return, with the campaign key typed out
//   GET  /api/campaigns              status, sender, pending/sent/failed/skipped per campaign
//
// THE CAMPAIGN KEY IS THE QUEUE ROW ID, and that is the whole crash-safety story on our side.
// Staging the same key twice is a 400 (duplicate campaign key) over there. So a tick that
// staged a row and died before recording it does not create a second campaign on retry — it
// gets the 400, which stageCampaign() reports as `duplicate: true`, and the caller carries on
// to arm the one that exists. Idempotent by construction, no state needed here.
//
// ARMING. The brief is explicit that the confirmation must be a person clicking in
// SendBlaster's UI, not a constant in code, because an automated caller once armed a campaign
// and 242 strangers were texted. That person-click already exists in SendBlaster: a queue row
// is only ever sent after an operator confirms it (confirmed_at), and queue-tick refuses
// anything unconfirmed. So this arms on the strength of that click — callers MUST only arm
// rows a human confirmed. Do not add a path that arms anything else.
//
// Env: BULK_SMS_API_URL (e.g. https://<charles-app>.vercel.app), BULK_SMS_API_SECRET.
// Both unset = feature off; queue-tick falls back to the n8n webhook untouched.

const url = () => (process.env.BULK_SMS_API_URL || '').trim().replace(/\/+$/, '');
const secret = () => (process.env.BULK_SMS_API_SECRET || '').trim();

// PRODUCTION ONLY, by default. The brief's env-stamping guard exists because "there is no
// local database — this is the production one — so a laptop staging a campaign must not be
// able to send it." Their guard protects their drain. This is ours: a preview deployment or a
// developer's dev-server with the two vars copied in would otherwise stage AND ARM real
// campaigns, because the manual "Send now" path reaches queue-tick from any deployment.
// Cron does not run on previews, but a click does.
//
// VERCEL_ENV is unset on a laptop, which is the case this most needs to catch, so "unset"
// means off. BULK_SMS_ALLOW_NONPROD=1 is the explicit, named override for a deliberate test
// against a sandbox of the bulk sender — a constant someone has to type, not a default.
const inProduction = () =>
  (process.env.VERCEL_ENV || '') === 'production' || process.env.BULK_SMS_ALLOW_NONPROD === '1';

// The feature flag. ALL of: both vars present, the URL not a placeholder, and production (or
// the named override). Half a config is the same as off, and the status payload says which.
export const bulkSmsConfigured = () => !!(url() && secret() && !url().startsWith('<<') && inProduction());

// For the status payload: why the flag reads off, so a missing env var and a preview deploy
// are told apart without anyone having to guess.
export const bulkSmsStatus = () => ({
  configured: bulkSmsConfigured(),
  has_url: !!url() && !url().startsWith('<<'),
  has_secret: !!secret(),
  in_production: inProduction(),
});

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${url()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error(`bulk-sms ${method} ${path} -> ${res.status}: ${(json && (json.error || json.message)) || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Which numbers the pipeline will send from, with the two flags the picker needs. A route
// that is sendable but not inbox_attached sends perfectly and the thread never appears in the
// HubSpot inbox — that is the confusion AI-965 AC5 exists to stop, so both are surfaced.
export async function listRoutes() {
  const out = await call('/api/routes');
  const routes = Array.isArray(out) ? out : (out && out.routes) || (out && out.data) || [];
  return routes.map(r => ({
    from_number: r.from_number,
    inbox: r.inbox || null,
    sendable: !!r.sendable,
    inbox_attached: !!r.inbox_attached,
    tcr_registered: !!r.tcr_registered,
    max_segments: r.max_segments == null ? null : Number(r.max_segments),
  }));
}

// Stage a blast. Returns the census — what the gate would let through and why the rest would
// not — and sends nothing. `duplicate: true` means this key was already staged (see the note
// on keys above) and the caller should look the campaign up rather than treat it as a failure.
export async function stageCampaign({ key, name, body, fromNumber, phones }) {
  // The documented recipient shape is { hubspot_contact_id, phone, firstname }. SendBlaster
  // resolves an audience to E.164 numbers and has neither a contact id nor a first name for
  // them, so those two are sent as EXPLICIT nulls rather than left off: the shape matches the
  // contract exactly, and if the pipeline treats them as required it says so in its own 400 —
  // which is the answer we want, in writing, rather than a guess about optionality here.
  // The pipeline applies consent "across every record on the handset", so the number alone is
  // enough for the gate, and the segment cap substitutes a 20-character name either way.
  const recipients = [...new Set((phones || []).filter(Boolean))]
    .map(phone => ({ hubspot_contact_id: null, phone, firstname: null }));
  try {
    const out = await call('/api/campaigns/external', {
      method: 'POST',
      body: { key, name, body, from_inbox: fromNumber, recipients },
    });
    return {
      duplicate: false,
      campaignId: out && out.campaign && out.campaign.id,
      status: out && out.campaign && out.campaign.status,
      fromInbox: out && out.from_inbox,
      eligible: Number((out && out.eligible) || 0),
      blocked: Number((out && out.blocked) || 0),
      byReason: (out && out.byReason) || {},
      collapsedDuplicates: Number((out && out.collapsedDuplicates) || 0),
      raw: out,
    };
  } catch (e) {
    // The three documented pre-flight 400s: no route for the from-number, body over the
    // route's segment cap, duplicate campaign key. Only the last one is "fine, carry on".
    const msg = String((e && e.message) || '').toLowerCase();
    if (e && e.status === 400 && /duplicate/.test(msg) && /key/.test(msg)) {
      return { duplicate: true, campaignId: null, raw: e.body };
    }
    throw e;
  }
}

// The point of no return. See ARMING above — only ever call this for a row a person confirmed.
export async function armCampaign({ campaignId, key }) {
  return call(`/api/campaigns/${encodeURIComponent(campaignId)}/arm`, {
    method: 'POST',
    body: { confirm: key },
  });
}

// Everything the pipeline knows about our campaigns. Used to find a campaign by key after a
// duplicate-key stage, and to pull sent/failed/skipped back onto the queue row later.
export async function listCampaigns() {
  const out = await call('/api/campaigns');
  return Array.isArray(out) ? out : (out && out.campaigns) || (out && out.data) || [];
}

export async function findCampaignByKey(key) {
  const all = await listCampaigns();
  return all.find(c => c && c.key === key) || null;
}
