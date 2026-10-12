// The three tokens a queued blast fills in, and nothing else.
//
// Extracted from api/queue-draft.js when api/cakemail-templates.js needed the SAME fill. A
// CakeMail template is written with the same [GAME] / [DATE] / [SPORT] placeholders Cole's copy
// uses, and attaching one to a row has to resolve them exactly as the drafter would — a second
// implementation that formatted a date differently, or named a fixture the other way round,
// would put two different wordings of the same game in front of the same market.
//
// This is also why LEFTOVER lives in queue-draft and not here: the validator's job is to reject
// anything this function did NOT fill, so it has to be read against this list.

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// event_date is a PLAIN date and already local to the venue (see the note in
// docs/documentation/events-pipeline.md). Parsing it through Date() would shift it a day for half of
// every UTC day, so it is formatted from its own digits and never becomes a Date.
export function prettyDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

// "<opponent> at <team>" — team is the HOME side, so the visitor is named first. Same
// convention as blastTitle() in ui/index.html; a row that has neither falls back to its
// stored title with the [TEST] marker stripped, because that marker is queue bookkeeping
// and must not appear in outreach.
export function gameLabel(r) {
  if (r.team) return r.opponent ? `${r.opponent} at ${r.team}` : r.team;
  return String(r.title || '').replace(/^\s*\[TEST\]\s*/i, '').trim();
}

export function fillTokens(body, r) {
  return String(body || '')
    .replace(/\[GAME\]/g, gameLabel(r))
    .replace(/\[DATE\]/g, prettyDate(r.event_date))
    .replace(/\[SPORT\]/g, r.sport || 'sports');
}

// [BODY] — where a CakeMail design wants this blast's own words.
//
// A design is a wrapper: logo, colours, footer, unsubscribe. Without somewhere to put the copy
// it REPLACES it, so attaching one threw away the drafted body and sent a generic email with no
// fixture, no date and no price.
//
// TWO WAYS TO PLACE IT, in order of how much they can be trusted:
//
//   1. [BODY] in the template. Unambiguous — a person pointed at the spot. Always preferred.
//   2. The first non-empty paragraph, when there is no [BODY]. A FALLBACK, requested so that a
//      design works without having to be edited in CakeMail first, and it is a guess. What the
//      first paragraph actually is varies completely between designs: in CakeMail's starter
//      template it is the headline "Let's build an email!" followed by twenty-three paragraphs
//      of builder boilerplate, and in Cole's Ticketblast it is "Good morning," followed by the
//      whole pitch hardcoded to a Warriors @ Clippers game. The fallback puts the copy in the
//      right place in NEITHER. It is still better than discarding the copy entirely, but callers
//      must say which mode was used, which is what bodyPlan() is for.
//
// SUBSTITUTED AT SEND AND PREVIEW TIME, NOT AT ATTACH TIME, and that is the opposite of how
// [GAME]/[DATE]/[SPORT] work. Those resolve from the event, which does not change. The copy very
// much does — it is edited in the Queue, redrafted, tailored — and baking it into the snapshot
// would mean every edit silently did nothing until someone thought to press Refresh.

// Text of an HTML fragment, for deciding whether a paragraph is really empty. Spacer paragraphs
// holding one &nbsp; are extremely common in email HTML and are not where copy belongs.
const stripTags = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

// WHERE THE COPY WOULD GO, without doing it. The UI says which mode is in play, because
// "design attached" means three quite different things and only one of them is exact.
//   token           - the design has [BODY]
//   first-paragraph - no [BODY]; the copy will land in the first non-empty <p>
//   none            - no [BODY] and no paragraph to use; the design is sent as-is
export function bodyPlan(html) {
  const s = String(html || '');
  if (s.includes('[BODY]')) return { mode: 'token', paragraphs: 0 };
  const ps = [...s.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  const used = ps.findIndex(m => stripTags(m[1]) !== '');
  if (used < 0) return { mode: 'none', paragraphs: ps.length };
  // `others` is how much of the design is NOT being replaced — the number that says whether
  // boilerplate will ship alongside the copy.
  return { mode: 'first-paragraph', paragraphs: ps.length, others: ps.filter(m => stripTags(m[1]) !== '').length - 1 };
}

// ESCAPED, then line-broken. email_copy is plain text that a person typed; a stray '<' in it
// must not become markup inside a 30 KB design.
const asHtml = row => String((row && row.email_copy) || '')
  .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  .replace(/\n/g, '<br>');

export function injectBody(html, row) {
  const s = String(html || '');
  const copy = asHtml(row);
  if (s.includes('[BODY]')) return s.split('[BODY]').join(copy);

  // Fallback: the first NON-EMPTY paragraph. Its opening and closing tags are kept, so the
  // design's own styling for that block still applies to the copy that replaces it.
  const re = /(<p\b[^>]*>)([\s\S]*?)(<\/p>)/gi;
  let m, done = false;
  return s.replace(re, (full, open, inner, close) => {
    if (done || stripTags(inner) === '') return full;
    done = true;
    return open + copy + close;
  });
}

// Kept for callers that only need the yes/no. bodyPlan() is the fuller answer.
export const wantsBody = html => String(html || '').includes('[BODY]');
