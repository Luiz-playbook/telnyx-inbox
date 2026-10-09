// Venue list per league, derived from events_master — one CSV per league, ready for someone to
// collect a seat map against each row (AI-1098).
//
//   node --env-file=.env scripts/export-venue-lists.js --out data/venues
//
// DERIVED, NOT WRITTEN FROM MEMORY. The team and venue names here are the ones the pipeline
// already matches on, straight out of events_master. A hand-typed list would spell an arena
// differently from the scraper and the seat map would never be found — the NBA map only works
// because its 30 arena names happen to match events_master exactly, and that is worth
// reproducing on purpose rather than by luck.
//
// events_master stores team and opponent LOWERCASED (they are join keys, not display strings),
// so team_full is preferred and the bare team is title-cased as a fallback — the same rule the
// Ticket Prices tab applies.
//
// The image filename column is the point of the exercise: save a chart under exactly that name
// in ui/assets/venue/<league>-arena/ and the price panel will find it with no code change.
//
// ONE VENUE CAN SERVE SEVERAL TEAMS and one team can play in several venues over a season, so
// the key is the PAIR. Rows are counted by how many games we have for them, because a venue
// with two games is probably a neutral site and a venue with eighty is a home ground.

import { writeFileSync, mkdirSync } from 'node:fs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const OUT = arg('out', 'data/venues');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPA_URL || !SUPA_KEY) throw new Error('SUPABASE_URL and a Supabase key are required');
const H = { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY };

const initcap = v => String(v || '').replace(/[0-9A-Za-z]+/g,
  w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

// PostgREST caps a response at 1000 rows, so this pages. Asking for everything in one request
// silently returns the first thousand and looks like a complete answer — the NFL came back with
// 11 of its 32 venues that way.
async function all(table, select, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?select=${select}&order=id.asc&limit=${pageSize}&offset=${from}`, { headers: H });
    if (!r.ok) throw new Error(`${table} ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

const rows = await all('events_master', 'id,league,team,team_full,venue,market_code,state_code,event_date');
console.log(`read ${rows.length} events\n`);

// league -> "team|venue" -> record
const byLeague = new Map();
for (const r of rows) {
  const league = String(r.league || '').toLowerCase();
  const venue = (r.venue || '').trim();
  const team = (r.team_full || '').trim() || initcap(r.team);
  if (!league || league === 'test' || !venue || !team) continue;
  if (!byLeague.has(league)) byLeague.set(league, new Map());
  const m = byLeague.get(league);
  const key = team + '|' + venue;
  const cur = m.get(key) || { team, venue, state: r.state_code || '', market: r.market_code || '', games: 0, first: r.event_date, last: r.event_date };
  cur.games++;
  if (r.event_date < cur.first) cur.first = r.event_date;
  if (r.event_date > cur.last) cur.last = r.event_date;
  m.set(key, cur);
}

mkdirSync(OUT, { recursive: true });
const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
let grand = 0;

for (const [league, m] of [...byLeague].sort((a, b) => b[1].size - a[1].size)) {
  const list = [...m.values()].sort((a, b) => b.games - a.games || a.team.localeCompare(b.team));
  const head = ['league', 'team', 'venue', 'state', 'market', 'games_in_table',
    'first_game', 'last_game', 'likely_home_ground', 'image_filename', 'image_saved', 'notes'];
  const lines = [head.join(',')];
  for (const v of list) {
    lines.push([
      league, esc(v.team), esc(v.venue), v.state, v.market, v.games, v.first, v.last,
      // A venue a team plays once is a neutral site or a one-off; its own ground shows up
      // repeatedly. Flagged rather than filtered, because the one-offs are real games.
      v.games >= 5 ? 'yes' : 'check',
      // Save the chart under exactly this name and the price panel finds it with no code change.
      esc(`${v.venue}.png`),
      'no', '',
    ].join(','));
  }
  const f = `${OUT}/${league}-venues.csv`;
  writeFileSync(f, lines.join('\n'));
  const homes = list.filter(v => v.games >= 5).length;
  console.log(`  ${league.toUpperCase().padEnd(16)} ${String(list.length).padStart(4)} team/venue pairs  (${homes} look like home grounds)  -> ${f}`);
  grand += list.length;
}
console.log(`\n${grand} rows across ${byLeague.size} leagues.`);
console.log(`Save each chart as ui/assets/venue/<league>-arena/<venue>.png (or .jpg) — the name must match the venue column exactly.`);
