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
