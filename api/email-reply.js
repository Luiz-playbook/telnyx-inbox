// Inbound email replies -> public.email_replies -> the Replies tab.
//
// THE HALF THAT WAS MISSING. Migration 079 built email_replies and the Replies tab against it, and
// said so plainly: "the UI is being built against this now; the ingestion is not wired yet." This
// is the ingestion. Until it ran, every reply to every email blast went to the CakeMail sender's
// own mailbox and was invisible to this app -- the table stood empty from 079 until this shipped.
//
// WHY AN INBOUND PATH AT ALL. CakeMail cannot give us replies and never could. It is an outbound
// ESP: when a recipient hits Reply their mail client sends to the From/Reply-To header, which is a
// real mailbox somewhere. CakeMail never sees the message, so there is no CakeMail endpoint to
// poll. Something has to own an address and hand us what arrives at it.
//
// HOW A REPLY KNOWS WHICH BLAST IT BELONGS TO -- never by parsing the subject line, which breaks
// the moment two markets share one. Two mechanisms, in priority order:
//
//   1. PLUS-ADDRESSING (production). The blast goes out with Reply-To
//      john+q<queue_id>@callplaybook.com, built by lib/reply-address.js. Gmail delivers it to the
//      base mailbox and the tag comes back on the recipient header, so attribution is exact and
//      costs no API call. Checked across To, Delivered-To and Cc, because a reply-all or a relayed
//      copy moves it.
//   2. MAILHOOK ADDRESS METADATA (fallback, and the testing path). Mailhook has no plus-addressing
//      but returns metadata attached at address creation -- see lib/mailhook.js.
//
// THE REPLY MAILBOX IS READ-ONLY. Nothing here, or anywhere in this codebase, may send from it.
// It is deliberately not the CakeMail sender's mailbox, which belongs to a real person.
//
// TWO WIRE SHAPES, one internal shape (normalise): Mailhook nests everything under `data`; the n8n
// Gmail trigger posts a flatter object using Gmail's field names. Gmail also needs its dates and
// its "Name <addr>" headers normalised -- see normaliseDate and bareAddress, both of which guard
// bugs this repo has already been bitten by once.
//
// AUTH -- two callers, two schemes, BOTH FAILING CLOSED:
//   x-webhook-signature : HMAC-SHA256 over the RAW body, hex, keyed with MAILHOOK_WEBHOOK_SECRET
//   x-reply-secret      : shared secret, compared constant-time against EMAIL_REPLY_SECRET (n8n,
//                         which cannot practically HMAC the exact bytes it is about to send)
// With neither secret configured the route refuses every request rather than accepting anonymous
// writes into an inbox a human reads and acts on. That is deliberately NOT the "open when unset"
// pattern the cron routes in this directory use.
//
// Env: EMAIL_REPLY_SECRET and/or MAILHOOK_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      optional REPLY_MAILBOX (lib/reply-address.js).

import crypto from 'node:crypto';
import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';
import { queueIdFromHeaders } from '../lib/reply-address.js';

// The signature is computed over the bytes as they arrived. Vercel parses JSON into req.body by
// default, and re-serialising that object gives DIFFERENT bytes — different key order, different
// whitespace — so the HMAC would never match. This turns the parser off for this route only.
export const config = { api: { bodyParser: false }, maxDuration: 30 };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Constant-time, and length-checked first because timingSafeEqual throws on a length mismatch
// rather than returning false.
function signatureOk(raw, header, secret) {
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = String(header || '').trim().replace(/^sha256=/i, '');
  if (got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex')); }
  catch { return false; }
}

// Quoted-printable and long HTML make for a useless preview, and the column is for scanning a
// list. The full body is kept whole alongside it.
const preview = (text, html) => {
  const src = String(text || '').trim()
    || String(html || '').replace(/<[^>]+>/g, ' ');
  return src.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
};

// "Coach Reynolds <coach@example.com>" → "coach@example.com". Lowercased, because an address is
// compared and grouped by downstream and Gmail preserves whatever case the sender typed.
const bareAddress = (v) => {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const inner = (raw.match(/<([^>]+)>/) || [null, raw])[1];
  const addr = inner.trim().toLowerCase();
  return addr.includes('@') ? addr : null;
};

// THREE DATE FORMATS REACH THIS ROUTE and only one of them is safe to store directly:
//   Mailhook  → ISO 8601                       ("2026-09-29T12:27:22.872Z")
//   Gmail     → internalDate, epoch MILLIS     ("1790684828000", often as a STRING)
//   Gmail     → the Date header, RFC 2822      ("Mon, 29 Sep 2026 12:27:22 +0000")
//
// Handing epoch millis to a timestamptz column stores a date tens of thousands of years from now —
// the same bug lib/cakemail.js records hitting with CakeMail's epoch SECONDS. A wrong received_at
// is worse than a missing one here, because the Replies tab sorts on it: one bad row pins itself to
// the top of the inbox forever. Anything unparseable falls back to now, which is at most seconds
// out for a webhook delivered in real time.
function normaliseDate(v) {
  if (v == null || v === '') return new Date().toISOString();
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();   // epoch seconds
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();          // epoch millis
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const iso = new Date(t).toISOString();
    // A parsed date far outside any plausible range means the format was misread, not that mail
    // arrived in 2153. Better to record arrival time than to corrupt the sort order.
    const year = new Date(t).getUTCFullYear();
    return (year >= 2000 && year <= 2100) ? iso : new Date().toISOString();
  }
  return new Date().toISOString();
}

// Gmail hands headers back as an array of { name, value } on the raw payload, and n8n may pass
// either that or its own flattened `headers` object. Case-insensitive because header names are.
function headerValue(src, name) {
  const want = name.toLowerCase();
  const h = src && (src.headers || src.payload && src.payload.headers);
  if (Array.isArray(h)) {
    const hit = h.find(x => x && String(x.name || '').toLowerCase() === want);
    return hit ? hit.value : null;
  }
  if (h && typeof h === 'object') {
    const k = Object.keys(h).find(x => x.toLowerCase() === want);
    return k ? h[k] : null;
  }
  return null;
}

// Fills market_key and segment from the queue row the reply is attributed to.
//
// WHY LOOK IT UP INSTEAD OF CARRYING IT. The plus-addressed return address encodes only the queue
// id — deliberately, because the market and segment are already columns on that row, and a copy
// travelling separately through a mail round trip is a second version of the truth that can
// disagree with the first. The id is the key; everything else is derived from it here.
//
// The Replies tab DISPLAYS market_key, so leaving it null would quietly cost the operator the
// ability to see which market a reply came from — worth two extra reads on a low-volume path.
//
// BEST-EFFORT, ALWAYS. Any failure returns empty and the reply is still written: an attributed
// reply missing its market label is a small loss, a dropped reply is a lost lead. There is no
// foreign key between campaign_queue and events_master, so this cannot be one embedded select.
async function enrichFromQueue(url, key, queueId) {
  if (!queueId) return {};
  try {
    const one = async (path) => {
      const r = await fetch(`${url}/rest/v1/${path}`, { headers: supabaseHeaders(key) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return Array.isArray(j) && j[0] ? j[0] : null;
    };
    const q = await one(`campaign_queue?id=eq.${encodeURIComponent(queueId)}&select=segment,state_code,event_id&limit=1`);
    if (!q) return {};
    // market_key on the queue VIEW is events_master.market_code, not state_code — the two are
    // different fields and reply_inbox surfaces the former. state_code is the fallback so a row
    // with no linked event still says something useful about where it went.
    let marketKey = null;
    if (q.event_id) {
      const em = await one(`events_master?id=eq.${encodeURIComponent(q.event_id)}&select=market_code&limit=1`);
      marketKey = (em && em.market_code) || null;
    }
    return { market_key: marketKey || q.state_code || null, segment: q.segment || null };
  } catch {
    return {};
  }
}

// Flattens either wire shape into the fields the row below needs.
function normalise(body) {
  // Mailhook: everything under data, already named the way this route was first written.
  if (body && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return { ...body.data, _shape: 'mailhook' };
  }
  // n8n / Gmail. The trigger's output varies with its options, so each field is read from the
  // several places it plausibly appears rather than one canonical path.
  const b = body || {};
  return {
    _shape: 'gmail',
    // Gmail's own immutable message id is the natural dedupe key — the same message re-delivered
    // by a retry or a re-run of the workflow carries the same one.
    id: b.id || b.messageId || b.message_id || null,
    threadId: b.threadId || b.thread_id || null,
    from: b.from || b.From || headerValue(b, 'from') || (b.headers && b.headers.from) || null,
    from_name: b.fromName || b.from_name || null,
    // The recipient is where the +q tag lives, so it is the whole attribution mechanism.
    email_address: b.to || b.To || headerValue(b, 'to') || headerValue(b, 'delivered-to') || null,
    subject: b.subject || b.Subject || headerValue(b, 'subject') || null,
    text_body: b.text || b.textPlain || b.text_body || b.snippet || null,
    html_body: b.html || b.textHtml || b.html_body || null,
    // internalDate first: it is Gmail's own arrival stamp and is not affected by a sender's
    // wrong clock. The Date header is the fallback, read from the headers array as well as the
    // top level -- missing that second place silently dated every reply to its ingestion time.
    received_at: b.internalDate || b.date || b.received_at || headerValue(b, 'date') || null,
    // Kept so the plus-tag can be recovered from a reply-all or a relayed copy.
    _cc: b.cc || b.Cc || headerValue(b, 'cc') || null,
    _deliveredTo: headerValue(b, 'delivered-to') || b.deliveredTo || null,
    metadata: b.metadata || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // TWO CALLERS, TWO SCHEMES. n8n's Gmail trigger cannot practically HMAC the exact bytes it is
  // about to send — it would have to serialise the body itself and hope the HTTP node reproduces
  // it byte for byte — so that path presents a shared secret in a header instead. Mailhook keeps
  // the HMAC it already signs with.
  //
  // BOTH FAIL CLOSED. Neither secret configured means the route refuses everything rather than
  // accepting anonymous writes into an inbox a human reads and acts on. That is deliberately not
  // the "open when unset" pattern the cron routes in this directory use — the reason six of them
  // are currently reachable by anyone.
  const hmacSecret = (process.env.MAILHOOK_WEBHOOK_SECRET || '').trim();
  const sharedSecret = (process.env.EMAIL_REPLY_SECRET || '').trim();
  if (!hmacSecret && !sharedSecret) {
    res.status(503).json({ error: 'neither EMAIL_REPLY_SECRET nor MAILHOOK_WEBHOOK_SECRET is set — refusing unauthenticated inbound mail' });
    return;
  }

  let raw;
  try { raw = await readRaw(req); }
  catch { res.status(400).json({ error: 'could not read body' }); return; }

  // Constant-time even here: a plain === on a secret leaks its prefix through timing, and this one
  // is reusable forever by whoever learns it.
  const presented = String(req.headers['x-reply-secret'] || '').trim();
  const sharedOk = Boolean(sharedSecret && presented
    && presented.length === sharedSecret.length
    && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(sharedSecret)));
  const hmacOk = Boolean(hmacSecret && signatureOk(raw, req.headers['x-webhook-signature'], hmacSecret));

  if (!sharedOk && !hmacOk) {
    res.status(401).json({ error: 'bad signature or shared secret' });
    return;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: 'body is not JSON' }); return; }

  // Mailhook may send other event types later. Acknowledge them so it does not retry forever,
  // but write nothing.
  const event = String(body.event || '');
  if (event && event !== 'inbound_email') { res.status(200).json({ ok: true, ignored: event }); return; }

  // ONE INTERNAL SHAPE, TWO WIRE SHAPES. Mailhook nests under `data`; the n8n Gmail trigger posts
  // a flatter object with Gmail's own field names. Normalising once here means everything below —
  // and the row that gets written — cannot drift apart per provider.
  const d = normalise(body);
  // Gmail gives `From` as a display name plus the address — "Coach Reynolds <coach@example.com>".
  // Mailhook gives the bare address. bareAddress() handles both, because storing the display-name
  // form in from_email would break every lookup and comparison downstream.
  const from = bareAddress(d.from);
  if (!from) { res.status(400).json({ error: 'no sender address on the payload' }); return; }

  const meta = (d.metadata && typeof d.metadata === 'object') ? d.metadata : {};

  // ATTRIBUTION. The plus-tag on the address the reply was sent TO is the primary source: it was
  // written into the Reply-To when the blast went out (lib/reply-address.js), so it is exact and
  // needs no subject parsing. Checked across To, Delivered-To and Cc because a reply-all or a
  // relayed copy can move it.
  //
  // Mailhook's address metadata is the fallback, for replies to blasts sent through that path.
  const taggedQueueId = queueIdFromHeaders([d.email_address, d._deliveredTo, d._cc].filter(Boolean));
  const metaQueueId = meta.queue_id != null ? String(meta.queue_id)
                    : (meta.campaign_id != null ? String(meta.campaign_id) : null);

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }

  // Resolved before the write so one insert carries the whole row. Mailhook metadata, when
  // present, still wins -- it was captured at send time and needs no lookup.
  const enriched = await enrichFromQueue(url, key, taggedQueueId || metaQueueId);

  const row = {
    // UNIQUE in the schema, and this is the point of it: Mailhook retries on a non-2xx, and a
    // retry must reconcile rather than post the same reply into the inbox twice.
    provider_message_id: d.id != null ? String(d.id) : null,
    // NOT 'mailhook'. Migration 083 defines this column as "which service the blast went out
    // through, so the reply can be traced back to it" — Mailhook is the catcher, not the
    // sender, and recording it here would make the Replies tab's cakemail filter permanently
    // empty while replies to CakeMail blasts piled up under a provider nobody looks for.
    // Overridable from metadata for when the Gmail mail-merge path joins the same webhook.
    provider: meta.provider || 'cakemail',
    // Gmail groups a conversation for us, and migration 079 has the column; reply_inbox already
    // coalesces to the row id when it is null, so filling it makes a back-and-forth with one
    // prospect collapse into one thread instead of appearing as unrelated replies.
    thread_id: d.threadId != null ? String(d.threadId) : null,
    from_email: from,
    to_email: bareAddress(d.email_address),
    subject: d.subject || null,
    body: preview(d.text_body, d.html_body),
    // The +q tag off the recipient address wins over Mailhook metadata — no subject parsing, no
    // heuristics either way, but the tag is present on every blast sent since plus-addressing
    // shipped, whereas metadata only exists for the Mailhook-minted path.
    campaign_id: taggedQueueId || metaQueueId,
    // Deliberately NOT carried on the wire for the plus-addressed path: the market and segment are
    // columns on the queue row that campaign_id already identifies, and a copy travelling
    // separately is a second version of the truth that can disagree with the first.
    market_key: meta.market_key || meta.market || enriched.market_key || null,
    segment: meta.segment || enriched.segment || null,
    received_at: normaliseDate(d.received_at),
    // Kept whole, per migration 079: "Parsers improve and re-parsing beats re-asking the
    // provider for something it may no longer hold."
    raw: body,
  };

  try {
    const r = await fetch(`${url}/rest/v1/email_replies?on_conflict=provider_message_id`, {
      method: 'POST',
      headers: { ...supabaseHeaders(key), Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([row]),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      // 5xx so Mailhook retries — a reply lost to a transient database error is a lost lead.
      res.status(502).json({ error: `email_replies insert failed (HTTP ${r.status})`, detail: detail.slice(0, 400) });
      return;
    }
    const saved = await r.json().catch(() => null);
    res.status(200).json({
      ok: true,
      id: Array.isArray(saved) && saved[0] ? saved[0].id : null,
      from,
      matched_campaign: row.campaign_id || null,
      // Says out loud when a reply arrived with no metadata — it still lands in the inbox, but
      // it will not be attributed to a blast, and that is worth seeing in the logs.
      unattributed: row.campaign_id ? undefined : true,
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
