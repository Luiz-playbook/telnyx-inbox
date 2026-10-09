// AI-1086: load the approved venue list and the per-market knowledge base.
//
//   node --env-file=.env scripts/load-greenfield-venues.js --dry
//   node --env-file=.env scripts/load-greenfield-venues.js
//
// Reads data/greenfield-venues.csv and data/greenfield-market-knowledge.csv into the two tables
// from migration 114, so the AI-1076 seasonal cron has something to read.
//
// THE SPORTS LIST IS APPLIED HERE, NOT STORED IN THE CSV. Josh's rule from the Oct 1 call is one
// mapping from venue type, and keeping it in code means a venue cannot drift out of step with
// it. His reason for the rule at all: "there's no point of inviting a football program to play
// at a basketball venue".
//
// --dry prints what would be written, including the coverage checks that actually matter: all
// eighteen greenfield states present, and how much of the knowledge base is still blank.

import { readFileSync } from 'node:fs';
// The sports rule and the greenfield list live in lib/youth-venues.js so api/venues.js applies
// the SAME mapping to a venue typed in by hand. A second copy here would defeat the sentence at
// the top of this file about a venue not drifting out of step with the rule.
import { SPORTS_BY_VENUE_TYPE, GREENFIELD } from '../lib/youth-venues.js';

const DRY = process.argv.includes('--dry');
const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DRY && (!SUPA_URL || !SUPA_KEY)) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
const H = { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'content-type': 'application/json' };

// Josh, Oct 1: basketball venues support basketball and volleyball; football venues support
// football, soccer, lacrosse and field hockey; baseball venues support baseball and softball.


// The eighteen Josh named. Vermont was said twice on the call; it is one state.


// Minimal CSV reader: quoted fields, doubled quotes, commas inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(v => v.trim()))
    .map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

const venues = parseCsv(readFileSync('data/greenfield-venues.csv', 'utf8')).map(v => {
  const sports = SPORTS_BY_VENUE_TYPE[v.venue_type];
  if (!sports) throw new Error(`unknown venue_type "${v.venue_type}" for ${v.venue}`);
  return {
    // venue_city, not market_city: this is the city the VENUE is in (Tuscaloosa), which is a
    // different thing from the market's city (Huntsville for all of Alabama). They shared a
    // name until migration 115 and the join between the two tables was wrong the whole time.
    state_code: v.state_code, state_name: v.state_name, venue_city: v.venue_city,
    org: v.org, level: v.level, venue: v.venue, venue_type: v.venue_type,
    sports,
    confidence: v.confidence === 'High' ? 'High' : 'Medium',
    notes: v.notes || null,
  };
});

const knowledge = parseCsv(readFileSync('data/greenfield-market-knowledge.csv', 'utf8')).map(k => ({
  state_code: k.state_code, state_name: k.state_name, market_city: k.market_city,
  school_district: k.school_district || null, athletics_body: k.athletics_body || null,
  school_first_day: k.school_first_day || null, school_last_day: k.school_last_day || null,
  fall_sports_start: k.fall_sports_start || null, winter_sports_start: k.winter_sports_start || null,
  spring_sports_start: k.spring_sports_start || null, summer_sports_start: k.summer_sports_start || null,
  source_url: k.source_url || null, notes: k.notes || null,
}));

// --- coverage, which is the thing the acceptance criteria actually ask about -------------------

const byState = {};
for (const v of venues) byState[v.state_code] = (byState[v.state_code] || 0) + 1;
const missingVenues = GREENFIELD.filter(s => !byState[s]);
const missingKnowledge = GREENFIELD.filter(s => !knowledge.some(k => k.state_code === s));
const byType = {};
for (const v of venues) byType[v.venue_type] = (byType[v.venue_type] || 0) + 1;
const byLevel = {};
for (const v of venues) byLevel[v.level] = (byLevel[v.level] || 0) + 1;

const DATE_COLS = ['school_first_day', 'school_last_day', 'fall_sports_start',
  'winter_sports_start', 'spring_sports_start', 'summer_sports_start'];
const filled = knowledge.reduce((n, k) => n + DATE_COLS.filter(c => k[c]).length, 0);
const total = knowledge.length * DATE_COLS.length;

console.log(`venues     : ${venues.length} across ${Object.keys(byState).length}/18 greenfield states`);
console.log(`  by type  : ${Object.entries(byType).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`  by level : ${Object.entries(byLevel).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`  High confidence: ${venues.filter(v => v.confidence === 'High').length}`);
console.log(`knowledge  : ${knowledge.length}/18 states`);
console.log(`  dates filled: ${filled}/${total}  <- these must be researched before the cron can time sends`);
if (missingVenues.length) console.log(`!! no venues for: ${missingVenues.join(', ')}`);
if (missingKnowledge.length) console.log(`!! no knowledge row for: ${missingKnowledge.join(', ')}`);

if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }

// --- write -------------------------------------------------------------------------------------

// Rows a person has corrected through the UI, as "org||venue" keys. The loader must not delete
// or overwrite these — see migration 116. Best effort: a database without 116 has no such
// column, and the loader still has to work there, so a 400 means "no protected rows" rather
// than a crash. It says so, because silently reverting someone's work is the failure here.
async function protectedKeys(table) {
  if (table !== 'youth_event_venues') return new Set();
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?select=org,venue&edited_by_hand=is.true`, { headers: H });
  if (!r.ok) {
    console.log('  (no edited_by_hand column — migration 116 not applied, nothing is protected)');
    return new Set();
  }
  const rows = await r.json();
  if (rows.length) console.log(`  protecting ${rows.length} hand-edited row(s) from this load`);
  return new Set(rows.map(x => `${x.org}||${x.venue}`));
}

async function replace(table, rows, conflict) {
  const keep = await protectedKeys(table);
  // Two halves of the same promise. Deleting everything and re-inserting would wipe the edit;
  // skipping the delete but still inserting would upsert over it, because the insert carries
  // resolution=merge-duplicates. So the edited rows are excluded from BOTH.
  const del = await fetch(`${SUPA_URL}/rest/v1/${table}?state_code=in.(${GREENFIELD.join(',')})`
      + (keep.size ? '&edited_by_hand=is.false' : ''),
    { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
  if (!del.ok) throw new Error(`${table} clear: ${(await del.text()).slice(0, 200)}`);
  if (keep.size) {
    const before = rows.length;
    rows = rows.filter(x => !keep.has(`${x.org}||${x.venue}`));
    if (before !== rows.length) console.log(`  skipped ${before - rows.length} CSV row(s) that have been edited by hand`);
  }
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...H, Prefer: `return=minimal,resolution=merge-duplicates${conflict ? '' : ''}` },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!r.ok) throw new Error(`${table} insert: ${(await r.text()).slice(0, 300)}`);
  }
  console.log(`wrote ${rows.length} -> ${table}`);
}

await replace('youth_event_venues', venues);
await replace('market_season_calendar', knowledge);
console.log('done.');
