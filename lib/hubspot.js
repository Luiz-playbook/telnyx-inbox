// HubSpot logging for outbound blast SMS (AI-976).
//
// WHY THIS EXISTS. Bulk sends have always gone straight to Telnyx and never touched HubSpot, so
// a rep looking at a contact could not see that the blast tool had texted them — which breaks
// reply attribution and makes "did we already contact this person" unanswerable from the record.
//
// WHAT IS LOGGED. One Communication object per recipient, channel SMS, associated to the
// matching contact. Communications is the object HubSpot uses for SMS/WhatsApp/LinkedIn, so a
// logged blast sits in the same timeline as anything else that reached that person, rather than
// as a Note that merely describes one.
//
// EXPLICITLY NOT THREADS. The ticket puts one-way and two-way conversation threads inside
// HubSpot out of scope: this writes interactions on the record, nothing more.
//
// FAILURE IS NEVER FATAL. Every function here resolves rather than throws, and the send path
// treats logging as best-effort. A HubSpot outage must not stop a blast that is already on the
// wire, and it must never turn a delivered message into a reported failure.
//
// Env: HUBSPOT_ACCESS_TOKEN (Private App token, server-side only — never added to
// scripts/gen-config.js, which is served to every visitor).

const BASE = 'https://api.hubapi.com';

// communication -> contact. Read from /crm/v4/associations/communications/contacts/labels rather
// than remembered: HUBSPOT_DEFINED ids are stable but guessing one silently creates an
// unassociated record that appears on nobody's timeline.
const ASSOC_COMMUNICATION_TO_CONTACT = 81;

const token = () => (process.env.HUBSPOT_ACCESS_TOKEN || '').trim();
export const hubspotConfigured = () => !!token();

async function hs(path, { method = 'GET', body } = {}) {
  const key = token();
  if (!key) throw new Error('HUBSPOT_ACCESS_TOKEN is not set');
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const msg = (json && (json.message || json.error)) || text || `HTTP ${r.status}`;
    const err = new Error(`hubspot ${method} ${path} → ${r.status}: ${String(msg).slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

// E.164 in, the shapes HubSpot might hold out.
//
// Numbers are stored by whoever typed them: "+1 615 805 0766", "(615) 805-0766", "6158050766".
// An exact-string search on the E.164 form would miss all three, so the search is run against
// several renderings of the same number and the first hit wins. Matching on the last 10 digits
// alone was rejected: it collides across country codes, and a wrong match writes a real person's
// timeline with someone else's message.
function phoneVariants(e164) {
  const d = String(e164 || '').replace(/[^0-9]/g, '');
  if (!d) return [];
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  const out = new Set([String(e164 || '').trim()]);
  if (ten.length === 10) {
    out.add(`+1${ten}`);
    out.add(`1${ten}`);
    out.add(ten);
    out.add(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
    out.add(`${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`);
  }
  return [...out].filter(Boolean);
}

// Search phone AND mobilephone: a mobile-only contact is exactly the kind this tool texts, and
// searching `phone` alone would miss it and then create a duplicate beside it.
export async function findContactByPhone(e164) {
  const variants = phoneVariants(e164);
  if (!variants.length) return null;
  for (const prop of ['phone', 'mobilephone']) {
    const res = await hs('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: {
        filterGroups: variants.map(v => ({ filters: [{ propertyName: prop, operator: 'EQ', value: v }] })),
        properties: ['phone', 'mobilephone', 'firstname', 'lastname'],
        limit: 1,
      },
    });
    const hit = (res && res.results && res.results[0]) || null;
    if (hit) return hit;
  }
  return null;
}

// Create the minimum that makes the record usable and identifiable as ours, per the ticket:
// the number, and a source marking it blast-created. Deliberately no invented name — a contact
// called "Unknown" is worse than one with only a phone number, because it looks filled in.
export async function createContactForPhone(e164) {
  return hs('/crm/v3/objects/contacts', {
    method: 'POST',
    body: {
      properties: {
        phone: e164,
        hs_lead_status: 'NEW',
        // Free-text, so it survives without a custom property having to exist first. Anything
        // stricter would fail closed on a portal that has not been prepared.
        hs_content_membership_notes: 'Created by SendBlaster blast — no contact matched this number.',
      },
    },
  });
}

// One Communication per recipient, associated to the contact.
//
// hs_communication_logged_from must be 'CRM' — it is an enumeration, and a value outside it is
// rejected for the whole object, losing the log for a message that really was sent.
export async function logSmsToContact({ contactId, body, sentAt, outcome, from, to }) {
  const when = sentAt ? new Date(sentAt).getTime() : Date.now();
  const header = [
    'Sent by SendBlaster',
    from ? `from ${from}` : '',
    to ? `to ${to}` : '',
    outcome ? `· ${outcome}` : '',
  ].filter(Boolean).join(' ');
  return hs('/crm/v3/objects/communications', {
    method: 'POST',
    body: {
      properties: {
        hs_communication_channel_type: 'SMS',
        hs_communication_logged_from: 'CRM',
        hs_communication_body: `${header}\n\n${body || ''}`.trim(),
        hs_timestamp: new Date(when).toISOString(),
      },
      associations: [{
        to: { id: String(contactId) },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC_COMMUNICATION_TO_CONTACT }],
      }],
    },
  });
}

// The whole job for one recipient: find or create, then log.
//
// Returns a per-number result rather than throwing, so a batch reports exactly which numbers
// logged, which created a contact, and which failed and why — the same shape lib/salesmsg.js
// uses for sending, and for the same reason: a partial failure that reads as total success is
// the bug this codebase keeps finding.
export async function logOutboundSms({ to, body, sentAt, outcome, from }) {
  try {
    let contact = await findContactByPhone(to);
    let created = false;
    if (!contact) {
      try {
        contact = await createContactForPhone(to);
        created = true;
      } catch (e) {
        // A MISSING SCOPE IS NOT THE SAME AS A BROKEN INTEGRATION, and the two must not report
        // the same way. As of 2026-09-14 the Private App has crm.objects.contacts.READ and
        // communications write, but NOT crm.objects.contacts.write — so logging against contacts
        // that already exist works, and only the create-for-unmatched half is refused.
        //
        // Surfaced as its own reason so the batch summary can name the fix instead of reporting
        // a generic failure that reads like the whole feature is down.
        if (e && e.status === 403) {
          return { to, ok: false, reason: 'contacts-write-scope',
                   error: 'No HubSpot contact matches this number and the app cannot create one — grant crm.objects.contacts.write to the Private App.' };
        }
        throw e;
      }
    }
    await logSmsToContact({ contactId: contact.id, body, sentAt, outcome, from, to });
    return { to, ok: true, contactId: contact.id, created };
  } catch (e) {
    return { to, ok: false, error: String((e && e.message) || e) };
  }
}

// Batch, paced.
//
// concurrency 5 is deliberate: HubSpot rate-limits per app (burst limits on the search endpoint
// in particular), and this runs AFTER a blast has already gone out, so there is nothing to be
// gained by rushing it and a 429 storm would lose logs for messages that really were delivered.
export async function logOutboundSmsBatch(messages = [], { concurrency = 5 } = {}) {
  const results = [];
  for (let i = 0; i < messages.length; i += concurrency) {
    const batch = messages.slice(i, i + concurrency);
    const out = await Promise.all(batch.map(m => logOutboundSms(m)));
    results.push(...out);
  }
  const failed = results.filter(r => !r.ok);
  const needScope = failed.filter(r => r.reason === 'contacts-write-scope');
  return {
    logged: results.filter(r => r.ok).length,
    createdContacts: results.filter(r => r.ok && r.created).length,
    // Counted separately: these are numbers with no HubSpot contact, which is a permissions gap
    // to close once, not a per-message error to investigate.
    unmatchedNoScope: needScope.length,
    failed: failed.filter(r => r.reason !== 'contacts-write-scope'),
    total: results.length,
  };
}
