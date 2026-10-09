// SendBlaster -> the HubSpot <-> Telnyx bulk sender (AI-965, option A: "stage for approval").
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
// THE THREE CALLS (AI-965, as built 2026-10-09):
//   GET  /api/routes                 which numbers may we send from, and are they inbox-ready
//   POST /api/campaigns/external     stage a DRAFT: validate, match to HubSpot, return a census
//   GET  /api/campaigns?key=…        status, sender, pending/sent/failed/skipped
//
// NOBODY HERE ARMS. A staged campaign waits in the Operator App until a person reads its census
// and approves it, typing the key. The confirm click in SendBlaster happens BEFORE the census
// exists, so it cannot be the confirmation the 2026-09-01 rule asks for (242 strangers texted
// after an automated caller armed a campaign). The pipeline's arm route refuses these campaigns.
//
// THE KEY is `<title> #<first 6 hex of the row id>` (campaignKeyFor): the same on every retry of a
// row, so a tick that staged and died gets a 409 on retry rather than a second campaign — and
// readable, because the approver types it. ASCII only, at most 80 characters, and never `<`, `>`
// or a backtick (the pipeline refuses them: the key is posted into a chat).
//
// WHO GETS TEXTED. Only numbers held by a HubSpot contact with sms_opt_in = true. A number with
// no contact is counted as not_in_hubspot and never texted. The pipeline matches each number to
// its contacts; it does not take our word for a contact id or a name.
//
// Env: BULK_SMS_API_URL (e.g. https://<charles-app>.vercel.app), BULK_SMS_API_SECRET.
// Both unset = feature off; queue-tick falls back to the n8n webhook untouched.

const url = () => (process.env.BULK_SMS_API_URL || '').trim().replace(/\/+$/, '');
const secret = () => (process.env.BULK_SMS_API_SECRET || '').trim();

// PRODUCTION ONLY, by default. The brief's env-stamping guard exists because "there is no
// local database — this is the production one — so a laptop staging a campaign must not be
// able to send it." Their guard protects their drain. This is ours: a preview deployment or a
// developer's dev-server with the two vars copied in would otherwise stage real
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
// `nobodyEligible: true` (a 422) means nothing was created on the other side; `census` carries
// { considered, eligible: 0, blocked, byReason } for the caller to record, and `campaignId` is null.
export async function stageCampaign({ key, name, body, fromNumber, phones }) {
  // Phones only. The pipeline finds each number's HubSpot contacts itself and ignores any id or
  // name we send. A number is eligible only if a contact holding it has sms_opt_in = true;
  // numbers not in HubSpot come back counted as not_in_hubspot and are never texted.
  const recipients = [...new Set((phones || []).filter(Boolean))].map(phone => ({ phone }));
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
    // 409: this key was staged already (a retried tick). Look it up, don't fail.
    if (e && e.status === 409) return { duplicate: true, campaignId: null, raw: e.body };
    // 422: nobody eligible. Nothing was created on the other side; the census says why.
    if (e && e.status === 422) {
      const b = e.body || {};
      return { duplicate: false, nobodyEligible: true, campaignId: null,
               census: { considered: b.considered, eligible: 0, blocked: b.blocked, byReason: b.byReason || {} },
               raw: b };
    }
    throw e;
  }
}

// SendBlaster's own campaigns (the pipeline filters), latest 50. Used by reconcile to pull status
// and sent/failed/skipped back onto the queue row. A duplicate-key lookup uses findCampaignByKey.
export async function listCampaigns() {
  const out = await call('/api/campaigns');
  return Array.isArray(out) ? out : (out && out.campaigns) || (out && out.data) || [];
}

// One key, asked for directly. The pipeline shows SendBlaster its own campaigns only, so a key
// that collides with someone else's campaign comes back empty — and the caller fails loudly
// rather than adopting a campaign it did not stage. An empty key is never sent: it would ask
// for the whole list and match nothing useful.
export async function findCampaignByKey(key) {
  if (!key) return null;
  const out = await call(`/api/campaigns?key=${encodeURIComponent(key)}`);
  const list = Array.isArray(out) ? out : (out && out.campaigns) || [];
  return list.find(c => c && c.key === key) || null;
}

const KEY_MAX = 80;

// Fold a title to what a keyboard types: smart quotes to straight, dashes and dots to '-',
// accents dropped, whitespace collapsed to one space BEFORE anything non-ASCII is removed (so
// "Red\tSox" stays two words), anything else non-ASCII removed, spaces collapsed again. `<`,
// `>` and backtick are removed too: the pipeline refuses them in a key because the key is
// posted into a chat, where `<!channel>` would ping everyone.
function asciiTitle(s) {
  return String(s || '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—·•]/g, '-')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '').replace(/[<>`]/g, '').replace(/\s+/g, ' ').trim();
}

// The pipeline requires a key to end in ' #' + exactly 6 lowercase hex characters.
export function campaignKeyFor(row) {
  const hex = String(row.id).replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, 6);
  if (hex.length < 6) throw new Error('campaignKeyFor: row id has fewer than 6 hex characters');
  const suffix = ` #${hex}`;
  const title = asciiTitle(row.title) || 'SendBlaster blast';
  return title.slice(0, KEY_MAX - suffix.length).trimEnd() + suffix;
}

// When the market's 14-day cooldown starts: once a person approved the campaign and it is
// sending or has sent. A draft nobody approved, or one discarded before approval, texted no one
// and must not cool a market.
export function startsCooldown(c) {
  if (!c) return false;
  if (['running', 'paused', 'done'].includes(c.status)) return true;
  return c.status === 'cancelled' && Number(c.sent) > 0;
}

// ▲ 2026-10-09 (AI-965 review). A DRAFT AWAITING APPROVAL HOLDS ITS MARKET.
//
// The market cools only when something was delivered (startsCooldown), so while an SMS draft
// waits in the Operator App — days, possibly — market_cooldowns() says the market is open. A
// second confirmed row for the same market|segment then stages a second draft over the same
// audience, and a person approving both texts the same people twice. The bulk sender does not
// de-duplicate across campaigns; it shares the opt-out list and nothing else.
//
// So queue-tick treats a market|segment as cooling while some OTHER row's draft is still waiting:
// bulk_census.cooldown = 'deferred' (reconcileBulk flips it to 'logged' once the draft is
// approved and sending, and market_cooldowns() takes over from there), handed off within the
// cooldown window, and not discarded before anyone was texted. A draft stopped mid-send reached
// people, so it still holds.
//
// The window is 14 days from the handoff (sent_at). reconcileBulk reads only the last 7, so a
// draft discarded after day 7 is never seen as discarded and holds its market until day 14 —
// the same two weeks it would have held had it been approved.
export const DRAFT_HOLD_DAYS = 14;

const discarded = p => !!p && p.status === 'cancelled' && !(Number(p.sent) > 0);

// campaign_queue rows (id, state_code, segment, sent_at, bulk_census) -> the holds they place,
// as { id, code, segment }. segment null = the whole market. Anything that is not an array is
// no holds: the caller logs the failed read and carries on with market_cooldowns() alone.
export function draftHolds(rows, { now = Date.now(), days = DRAFT_HOLD_DAYS } = {}) {
  if (!Array.isArray(rows)) return [];
  const since = now - days * 24 * 3600 * 1000;
  return rows
    .filter(r => r && r.bulk_census && r.bulk_census.cooldown === 'deferred'
      && !discarded(r.bulk_census.pipeline)
      && (Date.parse(r.sent_at || '') || 0) >= since
      && String(r.state_code || '').trim())
    .map(r => ({ id: r.id, code: String(r.state_code).trim().toUpperCase(), segment: r.segment || null }));
}

// The hold, if any, that keeps this due row from staging. The same rule as market_cooldowns()
// (migration 049) and queue-tick's isCooled: a whole-market draft holds every segment, and a
// whole-market row is held by a draft on any segment. A row is never held by its own draft.
export function heldByDraft(holds, row) {
  const code = String((row && row.state_code) || '').trim().toUpperCase();
  if (!code || !Array.isArray(holds)) return null;
  const seg = row.segment || null;
  return holds.find(h => h.id !== row.id && h.code === code
    && (!h.segment || !seg || h.segment === seg)) || null;
}
