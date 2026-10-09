// AI-1098: name the zone a listing's section sits in — center court, sideline, corner, behind
// the basket — using the NBA_Arena_Section_Map.
//
// WHY THIS EXISTS. "Cheapest 100 level seat" is not a premium offer. Josh, on the Oct 7 call:
// random sampling of SeatGeek's best-value list isn't great, the cheapest lower-bowl seat is
// often a bad one — it is behind the basket. The offer wants to say "center court from $X", and
// that needs every listing's section turned into a zone first.
//
// THE HARD PART IS NOT THE LOOKUP, IT IS THE SPELLING. The map keys on a bare section as an
// arena prints it ('108', '101L', 'M103', 'F9', 'J'). A marketplace prints whatever it likes:
//
//   Gametime   section '108', sectionGroup 'Field Box'      — clean, already separated
//   Vivid      sectionName 'Lower Level 134 GA - Dirty Bird's Nest'  — the number is in prose
//   TickPick   per-seat listings carry a section once the wall is cleared
//
// So a match is a CASCADE of named rules, and every result records which rule fired in
// `matched_as`. That is what makes the "under 5% of lower-bowl listings unmapped" acceptance
// criterion auditable: an unmapped rate is only meaningful if you can see what the misses were.
//
// NOTHING IS EVER GUESSED. A section the cascade cannot place comes back zone: null with a
// reason. The ticket is explicit about this and it is the right default anyway — a listing
// mislabelled 'center court' is a wrong price in a customer's inbox, while an unmapped one is a
// row someone can look at.
//
// ARENA QUIRKS, each one called out in the ticket and each a real row in the map:
//   Lakers    courtside is the bowl's number plus 'CT' (106CT). The map has no CT rows, so the
//             suffix is stripped to borrow 106's zone, but the tier becomes floor, not bowl —
//             courtside is not a lower-bowl price and must not set the bowl's floor.
//   Hawks     '101L' lower-lower rows exist in the map verbatim; they only need normalising.
//   Cavs      mezzanine repeats the bowl's numbers with an M (M101-M126). Matching the M row
//             matters precisely BECAUSE stripping the M would hand a mezzanine seat the bowl's
//             zone and undercut every lower-bowl quote.
//   Clippers  Intuit Dome numbers 1-32 around the clock and repeats that ring on Floor (F),
//             Club (C), Mezz (M) and Terrace (T). The zone comes from the bare number; the
//             letter decides the ring.
//   Pacers    courtside is lettered A-L, with J at midcourt; those are sections in their own
//             right and match exactly.

// Ring letters that prefix an otherwise shared section number. Clippers is the arena this was
// written for, but the mapping is the same wherever a letter names a ring.
const RING_LETTER = { F: 'floor', C: 'club', M: 'mezzanine', T: 'upper' };

const ZONE_RANK = { 'center court': 1, sideline: 2, corner: 3, 'behind basket': 4 };

// WHEN THE LISTING NAMES ITS OWN RING, THE NAME WINS OVER THE NUMBER.
//
// Gametime hands over a bare section. Vivid hands over prose — 'Lower Level 118', 'Upper Bowl
// 305', 'Loge Suites 106' — and sectionTokens reduces all three to a number. That is fine for
// the first two and actively dangerous for the third: '106' is a real lower-bowl section at
// Crypto.com Arena, so a suite would be mapped into the bowl and become the cheapest
// "center court" price on the game. Same failure mode as the Cavs' M103 mezzanine, arriving
// through prose instead of a prefix.
//
// So an explicitly named ring overrides the tier the map inferred. Order matters: 'Loge Suites'
// contains both 'loge' (a bowl word at TD Garden) and 'suite', and the suite has to win, so the
// premium rings are tested before the bowl words.
const RING_WORDS = [
  [/\bmezzanin|\bmiddle\b/i, 'mezzanine'],
  [/\bsuite|\blounge\b|\bbox\b|\bclub\b|premium|\bvip\b|signature/i, 'club'],
  [/\bcourtside\b|\bfloor\b/i, 'floor'],
  [/\bupper\b|\bbalcony\b|\bterrace\b/i, 'upper'],
  [/\blower\b|\bplaza\b|\bloge\b|100\s*level/i, 'lower_bowl'],
];

export function ringFromText(raw) {
  const s = String(raw || '');
  for (const [re, ring] of RING_WORDS) if (re.test(s)) return ring;
  return null;
}

// Zone vocabulary per league. A ballpark has no "center court", so the words are per sport and
// zone_rank (1 = most premium) is what callers rank on when they do not know the sport.
// Adding a league is a line here plus its rows in venue_section_zones.
export const LEAGUE_ZONES = {
  nba: ['center court', 'sideline', 'corner', 'behind basket'],
};

export const zonesForLeague = lg => LEAGUE_ZONES[String(lg || '').toLowerCase()] || null;

// Kept for the NBA-only callers that predate the league split.
export const ZONES = LEAGUE_ZONES.nba;

// Same normalisation the loader applies, and it has to stay in step with it: uppercase, and
// everything that is not a letter or a digit removed.
// TWO SITES LABEL THEIR SECTIONS WITH THE WORD ON. SeatGeek returns "Section 311" and Vivid
// returns "Section 420", while a zone map is built from "311" and "420". normSection below
// strips punctuation but KEEPS letters, so an unstripped label normalises to SECTION311 and
// matches nothing — and a whole site comes back unmapped while looking like an arena with no
// lower bowl. Lives here rather than in either site's parser because it is a property of
// section names, and both parsers need it.
//
// Only the literal word is removed. "Courtside A" keeps its name, because guessing at the rest
// is how a real section gets mangled into a wrong match.
export const stripSectionWord = s => String(s == null ? '' : s)
  .replace(/^\s*(?:section|sec\.?)\s+/i, '')
  .trim();

// Same problem one field over: SeatGeek rows arrive as "Row 7". Left alone, an offer would read
// "section 311, row Row 7".
export const stripRowWord = s => {
  const v = String(s == null ? '' : s).replace(/^\s*row\s+/i, '').trim();
  return v === '' ? null : v;
};

export const normSection = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

const teamKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// events_master and the marketplaces do not agree with the sheet on every team name. Keyed on
// the sheet's spelling; the value is what else the same team gets called.
const TEAM_ALIASES = {
  'la clippers': ['los angeles clippers', 'clippers', 'lac'],
  'los angeles lakers': ['la lakers', 'lakers', 'lal'],
  'golden state warriors': ['warriors', 'gsw'],
  'new york knicks': ['knicks', 'ny knicks'],
  'brooklyn nets': ['nets'],
  'philadelphia 76ers': ['76ers', 'sixers', 'philadelphia sixers'],
  'oklahoma city thunder': ['thunder', 'okc thunder'],
  'portland trail blazers': ['trail blazers', 'blazers'],
  'san antonio spurs': ['spurs'],
  'washington wizards': ['wizards'],
};

// ---------------------------------------------------------------------------------------------
// Loading the map at runtime
// ---------------------------------------------------------------------------------------------
//
// Read once per process and cached: 903 rows that change when someone edits a sheet and re-runs
// the loader, not between games of a refresh.
//
// BEST EFFORT, ALWAYS. A database that has not run migration 106 has no venue_section_zones table,
// and a refresh must never fail over a table it only wants for an extra column — the same rule
// the price-history write already follows. No table, no zones, prices still written.

let _index = null;
let _loaded = false;

export async function loadZoneIndex(supaUrl, supaKey) {
  if (_loaded) return _index;
  _loaded = true;
  if (!supaUrl || !supaKey) return null;
  try {
    const qs = 'select=league,team,arena,tier,section,zone,zone_rank,tier_class,confidence&limit=20000';
    const r = await fetch(`${String(supaUrl).replace(/\/$/, '')}/rest/v1/venue_section_zones?${qs}`,
      { headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey } });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    _index = buildZoneIndex(rows);
    return _index;
  } catch {
    return null;
  }
}

// Tests and the one-off scripts build an index from a file instead.
export function setZoneIndex(ix) { _index = ix; _loaded = true; return ix; }
export function getZoneIndex() { return _index; }

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------
//
// `rows` is whatever scripts/load-section-zones.js produced — straight from Supabase, or from the
// JSON snapshot it can write. Deliberately source-agnostic: the matcher is pure, so it can be
// tested and run against a file without a database.

export function buildZoneIndex(rows) {
  const byTeam = new Map();     // teamKey -> Map(section -> best record)
  for (const r of rows || []) {
    if (!r || !r.team || !r.section || !r.zone) continue;
    const keys = [teamKey(r.team), ...(TEAM_ALIASES[teamKey(r.team)] || []).map(teamKey)];
    const rec = {
      team: r.team,
      arena: r.arena || null,
      tier: r.tier || '',
      section: normSection(r.section),
      zone: r.zone,
      zone_rank: r.zone_rank || ZONE_RANK[r.zone] || 4,
      tier_class: r.tier_class || 'lower_bowl',
      confidence: r.confidence === 'High' ? 'High' : 'Medium',
    };
    for (const k of keys) {
      if (!byTeam.has(k)) byTeam.set(k, new Map());
      const m = byTeam.get(k);
      const prev = m.get(rec.section);
      // One section can appear in several tiers (Cavs 103 and M103 are distinct, but a bowl row
      // and an 'all rings' pattern row can collide). Prefer the lower bowl, then the better zone:
      // the bowl is what the offer quotes, so it should win a tie.
      if (!prev
        || (prev.tier_class !== 'lower_bowl' && rec.tier_class === 'lower_bowl')
        || (prev.tier_class === rec.tier_class && rec.zone_rank < prev.zone_rank)) {
        m.set(rec.section, rec);
      }
    }
  }
  return { byTeam, size: (rows || []).length };
}

// ---------------------------------------------------------------------------------------------
// Pulling a section token out of whatever the site printed
// ---------------------------------------------------------------------------------------------
//
// Returns candidate tokens in the order they should be tried. Row numbers are the trap: 'Section
// 12 Row 5' must not resolve to 5, so anything from a row/seat word onwards is cut off first.

export function sectionTokens(raw) {
  let s = String(raw || '').toUpperCase();
  if (!s.trim()) return [];
  s = s.split(/\bROW\b|\bSEAT\b|\bSEATS\b/)[0];

  const out = [];
  const push = t => { const n = normSection(t); if (n && !out.includes(n)) out.push(n); };

  // The whole string, for the clean case where it already IS the section ('108', 'M103', 'J').
  push(s);

  // Number with an optional letter tail ('134', '101L', '106CT'), and letter-led forms
  // ('M103', 'F9'). Longest first so '106CT' is tried before '106'.
  const toks = s.match(/\b[A-Z]{0,2}\d{1,3}[A-Z]{0,2}\b/g) || [];
  for (const t of toks.slice().sort((a, b) => b.length - a.length)) push(t);

  // A bare courtside letter, but only when the string is essentially just that letter —
  // otherwise every word in a section name becomes a candidate.
  const bare = s.trim();
  if (/^[A-Z]{1,2}$/.test(bare)) push(bare);

  return out;
}

// ---------------------------------------------------------------------------------------------
// matchZone
// ---------------------------------------------------------------------------------------------
//
// `{ team, section, section_group }` off a listing -> a zone or an explicit miss. Pass
// section_group too where a site has one: Gametime's 'Standing Room Only' / 'Field Box' is often
// the only place the words appear.

export function matchZone(index, listing) {
  const team = teamKey(listing && (listing.team_full || listing.team));
  const raw = (listing && (listing.section != null ? listing.section : listing.section_group)) || '';
  // Section tokens come from the section alone, but the RING can be stated in either field.
  // Gametime's API puts it in section_group ('Lower' / 'Middle' / 'Upper'), which is the site
  // telling us the ring outright — better than anything the map can infer from a number.
  const ringText = `${(listing && listing.section) || ''} ${(listing && listing.section_group) || ''}`;

  const sections = index && index.byTeam.get(team);
  if (!sections) {
    return miss(raw, team ? `no section map for team "${listing.team_full || listing.team}"` : 'no team on the listing');
  }
  const tokens = sectionTokens(raw);
  if (!tokens.length) return miss(raw, 'no section on the listing');

  // 1. Exact, as printed. Covers Gametime's bare numbers, the Hawks' 101L, the Cavs' M103 and
  //    the Pacers' lettered courtside in one rule.
  for (const t of tokens) {
    const hit = sections.get(t);
    if (hit) return found(hit, raw, t, 'exact', ringText);
  }

  // 2. Courtside suffix. '106CT' is Crypto.com Arena's courtside in front of 106: take 106's
  //    zone, but call the ring floor — a courtside price is not a lower-bowl price.
  for (const t of tokens) {
    const m = t.match(/^(\d{1,3})(CT|C)$/);
    if (!m) continue;
    const hit = sections.get(m[1]);
    if (hit) return { ...found(hit, raw, t, 'courtside-suffix', ringText), tier_class: 'floor' };
  }

  // 3. Ring letter in front of a shared number (Intuit Dome's F/C/M/T over 1-32). The zone is
  //    the bare number's; the letter sets the ring. Only applied when the letter is a known ring
  //    AND the lettered form itself did not match above, so the Cavs' real M rows keep priority.
  for (const t of tokens) {
    const m = t.match(/^([FCMT])(\d{1,3})$/);
    if (!m) continue;
    const hit = sections.get(m[2]);
    if (hit) return { ...found(hit, raw, t, 'ring-letter', ringText), tier_class: RING_LETTER[m[1]] };
  }

  return miss(raw, `section "${raw}" is not in the map for ${listing.team_full || listing.team}`);
}

function found(hit, raw, token, rule, ringText) {
  // A ring named in the listing text beats the one the map inferred from the number. The zone
  // itself still comes from the map: 'Upper Bowl 305' is still at whichever end 305 sits, it is
  // simply not a lower-bowl seat, and only the ring decides whether it can be quoted as one.
  const stated = ringFromText(ringText || raw);
  const tier_class = stated && stated !== hit.tier_class ? stated : hit.tier_class;
  return {
    zone: hit.zone,
    zone_rank: hit.zone_rank,
    tier: hit.tier,
    tier_class,
    ring_from_text: stated && stated !== hit.tier_class ? stated : null,
    confidence: hit.confidence,
    unmapped: false,
    matched_as: rule,
    matched_section: token,
    raw_section: String(raw),
    reason: null,
  };
}

function miss(raw, reason) {
  return {
    zone: null,
    zone_rank: null,
    tier: null,
    tier_class: null,
    ring_from_text: null,
    confidence: null,
    unmapped: true,
    matched_as: null,
    matched_section: null,
    raw_section: String(raw || ''),
    reason,
  };
}

// ---------------------------------------------------------------------------------------------
// cheapestByZone
// ---------------------------------------------------------------------------------------------
//
// "center court from $X" for one game. Lower bowl only, by default: that is the question the
// ticket asks and the ring filter is what stops a mezzanine seat carrying a bowl section number
// from undercutting the quote.
//
// Listings must already be zone-tagged (`zone`) and already have standing room removed — see
// isStandingRoom in lib/scrape-price.js. Ranked on all_in where it exists, because that is what
// the buyer pays and it is how price_candidates is ranked everywhere else.

export function cheapestByZone(listings, opts = {}) {
  const { rings = ['lower_bowl'], requireHighConfidence = false } = opts;
  const out = {};
  let considered = 0, unmapped = 0;

  for (const l of listings || []) {
    if (l.unmapped || !l.zone) { unmapped++; continue; }
    if (rings.length && !rings.includes(l.tier_class)) continue;
    if (requireHighConfidence && l.confidence !== 'High') continue;
    const price = Number(l.all_in != null ? l.all_in : l.price);
    if (!(price > 0)) continue;
    considered++;
    const cur = out[l.zone];
    if (!cur || price < cur.all_in) {
      out[l.zone] = {
        all_in: price,
        price: Number(l.price != null ? l.price : price),
        section: l.matched_section || l.section || null,
        row: l.row != null ? l.row : null,
        source: l.source || null,
        url: l.url || null,
        confidence: l.confidence || null,
        quantities: l.quantities || null,
      };
    }
  }

  return {
    zones: out,
    considered,
    unmapped,
    // The acceptance criterion, computed where the data is rather than by hand afterwards.
    unmapped_pct: considered + unmapped ? Math.round((unmapped / (considered + unmapped)) * 1000) / 10 : 0,
  };
}
