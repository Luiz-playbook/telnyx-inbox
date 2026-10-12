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
// A design is a wrapper: logo, colours, footer, unsubscribe. Without this it REPLACES the copy
// entirely, so attaching one threw away the drafted body and sent a generic email with no
// fixture, no date and no price. Put [BODY] in the template where the words belong and the
// row's email_copy is dropped in.
//
// SUBSTITUTED AT SEND AND PREVIEW TIME, NOT AT ATTACH TIME, and that is the opposite of how
// [GAME]/[DATE]/[SPORT] work. Those resolve from the event, which does not change. The copy very
// much does — it is edited in the Queue, redrafted, tailored — and baking it into the snapshot
// would mean every edit silently did nothing until someone thought to press Refresh. So the
// snapshot keeps [BODY] intact and it is filled on the way out.
//
// ESCAPED, then line-broken. email_copy is plain text that a person typed; a stray '<' in it
// must not become markup inside a 30 KB design.
export function injectBody(html, row) {
  const s = String(html || '');
  if (!s.includes('[BODY]')) return s;
  const copy = String((row && row.email_copy) || '')
    .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/\n/g, '<br>');
  return s.split('[BODY]').join(copy);
}

// Does this design ask for the copy, or does it stand alone? The UI says which, because
// "attached a design" means two quite different things depending on the answer.
export const wantsBody = html => String(html || '').includes('[BODY]');
