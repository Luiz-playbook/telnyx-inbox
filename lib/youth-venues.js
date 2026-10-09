// The rules a youth-event venue has to satisfy, in one place (AI-1086).
//
// WHY THIS FILE EXISTS. The sports list is derived from the venue type rather than stored per
// row, and scripts/load-greenfield-venues.js says why: "keeping it in code means a venue cannot
// drift out of step with it". Adding a second copy of that mapping inside an API route would
// defeat the sentence it is quoting. So the loader and api/venues.js both import from here, and
// a venue typed in by hand gets exactly the sports a loaded one would.
//
// Josh's reason for the rule at all, from the Oct 1 call: "there's no point of inviting a
// football program to play at a basketball venue".

// basketball venues support basketball and volleyball; football venues support football, soccer,
// lacrosse and field hockey; baseball venues support baseball and softball.
export const SPORTS_BY_VENUE_TYPE = {
  basketball: ['basketball', 'volleyball'],
  football: ['football', 'soccer', 'lacrosse', 'field hockey'],
  baseball: ['baseball', 'softball'],
};

export const VENUE_TYPES = Object.keys(SPORTS_BY_VENUE_TYPE);
// The table's own check constraints. Listed here so a form can render them as dropdowns and a
// route can reject a bad value with a readable message instead of surfacing a constraint name.
export const LEVELS = ['pro', 'minor', 'd1'];
export const CONFIDENCE = ['High', 'Medium'];

// The eighteen Josh named. Vermont was said twice on the call; it is one state.
export const GREENFIELD = ['AL', 'AK', 'AR', 'CT', 'DE', 'HI', 'ID', 'ME', 'MS',
  'MT', 'NH', 'NM', 'ND', 'RI', 'SD', 'VT', 'WV', 'WY'];

// Never trust a caller's sports array — derive it. A form that could set sports directly is a
// form that can produce a basketball venue hosting softball.
export const sportsFor = venueType => {
  const list = SPORTS_BY_VENUE_TYPE[String(venueType || '').toLowerCase()];
  return list ? [...list] : null;
};

const trim = v => (v == null ? null : String(v).trim());
const blankToNull = v => { const s = trim(v); return s === '' ? null : s; };

// Validates and normalises one venue, for both create and update.
//
// Returns { row, error }. A string error rather than a thrown exception because both callers
// want to report it to a person: the route as a 400 body, the loader as a line it skipped.
//
// `partial` is for an edit, where only the fields being changed are present. The required-field
// checks only apply on create; on an edit a field that IS present still cannot be blanked, since
// the columns are NOT NULL and PostgREST would answer with a constraint name nobody can act on.
export function cleanVenue(body, { partial = false } = {}) {
  const row = {};
  const req = (k, label) => {
    const v = blankToNull(body[k]);
    if (k in body || !partial) {
      if (!v) return `${label} is required`;
      row[k] = v;
    }
    return null;
  };

  for (const [k, label] of [['state_code', 'state'], ['state_name', 'state name'],
    ['venue_city', 'city'], ['org', 'organisation'], ['venue', 'venue name']]) {
    const e = req(k, label);
    if (e) return { error: e };
  }

  if (row.state_code) {
    if (!/^[A-Za-z]{2}$/.test(row.state_code)) return { error: 'state must be a two-letter code, like AL' };
    row.state_code = row.state_code.toUpperCase();
  }

  // The three constrained columns. Checked here so the message names the field and lists the
  // choices, rather than letting Postgres answer with youth_event_venues_level_check.
  for (const [k, allowed, label] of [['venue_type', VENUE_TYPES, 'venue type'],
    ['level', LEVELS, 'level'], ['confidence', CONFIDENCE, 'source confidence']]) {
    if (!(k in body) && partial) continue;
    const v = blankToNull(body[k]);
    if (!v) {
      if (k === 'confidence') { row[k] = 'Medium'; continue; }   // the table's own default
      return { error: `${label} is required` };
    }
    const hit = allowed.find(a => a.toLowerCase() === v.toLowerCase());
    if (!hit) return { error: `${label} must be one of: ${allowed.join(', ')}` };
    row[k] = hit;
  }

  // DERIVED, NEVER ACCEPTED. Recomputed whenever the venue type is set, so changing a venue from
  // football to basketball cannot leave soccer and lacrosse behind on the row.
  if (row.venue_type) {
    const s = sportsFor(row.venue_type);
    if (!s) return { error: `no sports rule for venue type ${row.venue_type}` };
    row.sports = s;
  }

  if ('notes' in body) row.notes = blankToNull(body.notes);
  return { row };
}
