// The return address for an email blast — COMPUTED, never registered.
//
// This replaces asking a vendor to mint an address per blast (lib/mailhook.js). Gmail delivers
// anything before the `+` to the base mailbox, so the blast id can simply be written into the
// local part:
//
//   Reply-To: john+q3f1c…@callplaybook.com   →  arrives at john@callplaybook.com
//
// WHY THIS IS BETTER THAN MINTING. It is string concatenation, so there is no API call in the
// send path, nothing to rate-limit, no per-address cap, no retention window, no vendor account,
// and — the one that matters most — NO WAY FOR IT TO FAIL MID-BLAST. The minting version could
// return null while a campaign was going out, sending it with no return address at all.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// THIS MAILBOX IS READ-ONLY. NOTHING IN THIS CODEBASE MAY EVER SEND FROM IT.
//
// The mailbox here exists to RECEIVE replies and nothing else. Being able to read it is not
// permission to send from it. Never wire a Gmail send node, messages.send, a draft-send, or an
// auto-responder to this address or to the CakeMail sender.
//
// It is deliberately NOT josh.marcus@callplaybook.com — the CakeMail production sender and a real
// person's working mailbox. Replies were pointed at john@ specifically to keep Josh's mailbox out
// of the automated path entirely.
// ───────────────────────────────────────────────────────────────────────────────────────────
//
// Set REPLY_MAILBOX to move it. The base address must be a mailbox whose inbox is actually
// watched (the n8n Gmail trigger), or replies arrive and nobody reads them — which is the exact
// condition this whole feature exists to end.

const DEFAULT_MAILBOX = 'john@callplaybook.com';

// 'q' for queue. A one-letter tag keeps the local part short and makes the address recognisable
// as machine-generated, so a human seeing it in a header knows it is not a typo'd person.
const TAG = 'q';

export const replyMailbox = () => (process.env.REPLY_MAILBOX || DEFAULT_MAILBOX).trim().toLowerCase();

// Dashes are legal in a local part, but they are dropped anyway: 32 hex characters instead of 36
// keeps the whole address comfortably inside the 64-character local-part limit even if the base
// mailbox name is long, and leaves no separator for a downstream parser to disagree about.
const compact = (id) => String(id || '').trim().toLowerCase().replace(/-/g, '');

const UUID_RE = /^[0-9a-f]{32}$/;

// Returns the Reply-To to put on a blast, or null when there is nothing to encode — in which case
// the caller should send with no Reply-To rather than invent one.
export function replyAddressFor(queueId) {
  const id = compact(queueId);
  if (!UUID_RE.test(id)) return null;
  const mailbox = replyMailbox();
  const at = mailbox.lastIndexOf('@');
  if (at < 1) return null;
  const local = mailbox.slice(0, at), domain = mailbox.slice(at + 1);
  // A base mailbox that already carries a + would nest tags and break parsing on the way back.
  if (local.includes('+')) return null;
  return `${local}+${TAG}${id}@${domain}`;
}

// The inverse, used by api/email-reply.js to attribute an arriving reply.
//
// Tolerant on purpose, because this string has made a round trip through someone else's mail
// client: it may come back with display-name wrapping ("Coach <john+q3f1c…@…>"), different case,
// or surrounding whitespace. Anything it cannot read returns null, and the reply is still stored —
// unattributed, but readable. A reply in the inbox with no campaign beats a reply dropped.
export function queueIdFromReplyAddress(address) {
  const raw = String(address || '');
  // The angle-bracket form wins when present; otherwise treat the whole string as the address.
  const inner = (raw.match(/<([^>]+)>/) || [null, raw])[1];
  const m = inner.trim().toLowerCase().match(new RegExp(`\\+${TAG}([0-9a-f]{32})(?:@|$)`));
  if (!m) return null;
  const h = m[1];
  // Back to canonical 8-4-4-4-12 so it matches the uuid the queue row is keyed by.
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// A reply's recipient can appear in any of several headers depending on how it was sent and who
// relayed it — To is normal, Delivered-To is what Gmail stamps, and Cc catches a reply-all. The
// first one carrying our tag wins.
export function queueIdFromHeaders(...candidates) {
  for (const c of candidates.flat()) {
    const id = queueIdFromReplyAddress(c);
    if (id) return id;
  }
  return null;
}
