// Mailhook — the inbound half of email. Mints ONE return address per blast, so a reply lands
// in a mailbox this app can read instead of in the CakeMail sender's own inbox.
//
// WHY THIS EXISTS AT ALL. CakeMail is an outbound ESP and cannot give us replies: a recipient
// hitting Reply mails the From/Reply-To header, which is a real mailbox somewhere, and CakeMail
// never sees it. There is no endpoint to poll. Something has to OWN an address and hand us what
// arrives — that is Mailhook, and api/email-reply.js is where it hands it over.
//
// HOW A REPLY KNOWS ITS BLAST. Not by parsing subject lines, which collide the moment two
// markets share one. Mailhook has no plus-addressing, but metadata attached when the address is
// CREATED comes back on the inbound webhook. So one address per blast carrying
// { queue_id, market_key, segment } makes attribution exact and parser-free. That metadata is
// the entire mechanism; api/email-reply.js reads it straight off `data.metadata`.
//
// FAILING SOFT IS DELIBERATE. Every function here returns null rather than throwing. A blast
// going out with replies landing in the old mailbox is a degraded send; a blast that does not
// go out because an address-minting service was down is a lost one. The caller logs the miss
// and sends anyway — see api/queue-tick.js.
//
// Env: MAILHOOK_AGENT_ID, MAILHOOK_API_KEY (app.mailhook.co → API keys),
//      MAILHOOK_DOMAIN_ID (optional — a shared domain is found or created on first use).
//
// SERVER-SIDE ONLY — never add these to scripts/gen-config.js, because ui/config.js is served
// to every visitor.

const MH = 'https://app.mailhook.co/api/v1';

export const mailhookConfigured = () =>
  Boolean((process.env.MAILHOOK_AGENT_ID || '').trim() && (process.env.MAILHOOK_API_KEY || '').trim());

async function mh(path, { method = 'GET', body } = {}) {
  const agent = (process.env.MAILHOOK_AGENT_ID || '').trim();
  const key = (process.env.MAILHOOK_API_KEY || '').trim();
  if (!agent || !key) throw new Error('MAILHOOK_AGENT_ID / MAILHOOK_API_KEY not set');
  const r = await fetch(MH + path, {
    method,
    headers: { 'X-Agent-ID': agent, 'X-API-Key': key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep the text for the message */ }
  if (!r.ok) throw new Error(`Mailhook ${method} ${path} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return json ?? text;
}

// MAILHOOK SPEAKS JSON:API, and that is the one thing about this client worth reading twice.
// Every response is { data: { id, type, attributes: {...} } } — or an ARRAY of those for a list.
// The interesting fields live under `attributes`, NOT on the object:
//
//   { "data": { "id": "ea_113d…", "type": "email_address",
//               "attributes": { "email": "xpczyowox5@…tail.me", "metadata": {…} } } }
//
// Reading `data.email` gives undefined, and because this module fails soft that surfaced as a
// silent null and a blast sent with no return address — the exact failure it is meant to prevent.
// Verified live 2026-09-29. `flat()` is what keeps that from happening again: it folds id and
// attributes into one object, and tolerates a flat payload in case the shape ever changes.
const flat = (o) => {
  const d = (o && o.data !== undefined) ? o.data : o;
  if (Array.isArray(d)) return d.map(x => ({ id: x && x.id, ...(x && x.attributes ? x.attributes : x) }));
  if (!d || typeof d !== 'object') return d;
  return { id: d.id, ...(d.attributes ? d.attributes : d) };
};

// Cached for the life of the lambda instance. A send run does several markets in one
// invocation, and re-resolving the domain for each is a round trip that buys nothing.
let domainCache = null;

// A SHARED domain is what this returns by default, and that is a real, visible trade-off: the
// return address reads like a random string at Mailhook's own domain, not at callplaybook.com.
// A custom domain is nicer and needs MX records on a DEDICATED SUBDOMAIN — never the apex,
// which would take company mail down with it. Set MAILHOOK_DOMAIN_ID once that exists and
// nothing here changes.
async function ensureDomain() {
  if (domainCache) return domainCache;
  const declared = (process.env.MAILHOOK_DOMAIN_ID || '').trim();
  if (declared) { domainCache = declared; return domainCache; }

  // REUSING an existing shared domain matters beyond tidiness: the free tier caps domains at 3,
  // so a client that created one per cold start would wedge itself after three sends.
  const list = flat(await mh('/domains'));
  const shared = (Array.isArray(list) ? list : []).find(d => d && d.domain_type === 'shared');
  if (shared && shared.id) { domainCache = String(shared.id); return domainCache; }

  const made = flat(await mh('/domains', {
    method: 'POST',
    body: { domain_type: 'shared', tailme_slug: `sendblaster-${Date.now().toString(36)}` },
  }));
  if (!made || !made.id) throw new Error('Mailhook created no domain id');
  domainCache = String(made.id);
  return domainCache;
}

// One address per blast. Returns { email, addressId } or null — never throws.
//
// `provider` is carried in the metadata and comes back on the webhook, where it is written to
// email_replies.provider. It names the service the blast went OUT through ('cakemail'), not
// Mailhook, which is only the catcher: recording 'mailhook' there would leave the Replies tab's
// CakeMail filter permanently empty while replies to CakeMail blasts piled up under a provider
// nobody filters for.
export async function createReplyAddress({ queueId, marketKey, segment, provider = 'cakemail' } = {}) {
  if (!mailhookConfigured()) return null;
  try {
    const domainId = await ensureDomain();
    const made = await mh('/email_addresses/random', {
      method: 'POST',
      body: {
        domain_id: domainId,
        metadata: {
          // Named queue_id, not queueId: api/email-reply.js reads snake_case off the webhook,
          // and this object is passed through by Mailhook verbatim.
          queue_id: queueId != null ? String(queueId) : undefined,
          market_key: marketKey || undefined,
          segment: segment || undefined,
          provider,
        },
      },
    });
    // `email` is what this endpoint returns; `email_address` is the field name on the INBOUND
    // webhook payload. Both are accepted so a rename on either side does not go silent.
    const d = flat(made) || {};
    const email = d.email || d.email_address || null;
    if (!email) return null;
    return { email, addressId: d.id || null };
  } catch (e) {
    // Swallowed on purpose — see the header. The caller reports it alongside the send.
    console.error('[mailhook] could not mint a reply address:', String((e && e.message) || e));
    return null;
  }
}
