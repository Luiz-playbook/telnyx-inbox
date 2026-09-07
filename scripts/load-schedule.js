// AI-830: schedule refresh pipeline. Pulls a league's released games into events_master
// and records a change-log row (events_master_schedule_runs) with the ids added.
//
// Idempotent — upsert_events_master() skips games already present, so re-running (or an
// overlapping weekly cron run) only ever ADDS newly released games. Never re-scrapes.
//
//   node --env-file=.env scripts/load-schedule.js --league mlb                 # StatsAPI, full remaining season
//   node --env-file=.env scripts/load-schedule.js --league nhl --start 2026-10-01 --end 2027-04-30
//   node --env-file=.env scripts/load-schedule.js --league nba --dry
//
//   node --env-file=.env scripts/load-schedule.js --league cfb --year 2026     # CFBD, FBS home games
//
// Sources: MLB -> MLB StatsAPI, NHL -> official api-web.nhle.com, NFL -> nflverse,
// CFB -> CollegeFootballData (needs CFBD_API_KEY)
// community CSV (no official NFL API; widely-public data, per AI-844). NBA/college ->
// ESPN's hidden scoreboard API, walked day by day. All map to the same row shape and go
// through upsert_events_master (dedup + market resolution).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// SERVICE ROLE, NOT ANON: migration 052 revoked upsert_events_master from `anon`, so the anon key
// this script used to carry can no longer write and every run fails on the first batch. This is a
// server-side script run by hand or by cron — it is never shipped to a browser — so the service
// role is the correct credential rather than a privilege escalation. The anon key is still
// accepted for --dry, which reads nothing and writes nothing.

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const DRY_ARG = process.argv.includes('--dry');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || (DRY_ARG ? process.env.SUPABASE_ANON_KEY : '');
if (!SUPA_URL || !SUPA_KEY) {
  console.error(process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY
    ? 'Missing SUPABASE_SERVICE_ROLE_KEY. The anon key cannot write to events_master since migration 052 — a run with it would fail on the first batch.'
    : 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

import { makeLoaders } from '../lib/schedules.js';

const args = process.argv.slice(2);
const flag = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const LEAGUE = (flag('--league', 'mlb')).toLowerCase();
const YEAR = Number(flag('--year', '2026'));
const today = new Date().toISOString().slice(0, 10);
const START = flag('--start', today);
const END = flag('--end', `${YEAR}-12-31`);
const SEASON = `${YEAR}-${LEAGUE}`;

// ESPN sport/league path per league
// The loaders themselves live in lib/schedules.js so the weekly cron can run exactly the same
// code — see the note at the top of that file. This script is the by-hand entry point: it parses
// the flags, hands them over as context, and reports what happened.
const { loaders, loadESPN, patchVenueMarkets } = makeLoaders({
  YEAR, START, END, SEASON, LEAGUE, SUPA_URL, SUPA_KEY,
});

async function rpc(name, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

(async () => {
  console.log(`Schedule refresh: ${LEAGUE} ${START}->${END} (season ${SEASON})${DRY ? ' [DRY]' : ''}`);
  const sourceName = { mlb: 'MLB StatsAPI', nhl: 'NHL api-web', nfl: 'nflverse', cfb: 'CollegeFootballData', march_madness: 'ESPN (NCAA tournament)' }[LEAGUE] || 'ESPN';
  const { rows, source } = await (loaders[LEAGUE] || loadESPN)();
  console.log(`Fetched ${rows.length} games from ${sourceName}.`);
  if (!rows.length) { console.log('Nothing to load (season may not be released yet).'); return; }

  if (DRY) { console.table(rows.slice(0, 8).map(r => ({ date: r.event_date, team: r.team, opp: r.opponent, venue: r.venue }))); console.log(`(dry — ${rows.length} would upsert)`); return; }

  const addedIds = [];
  let fetched = 0;
  // Status changes and reschedules are the whole point of migration 053, and they are invisible in
  // the "added" count (they update existing rows). Collect them so the run says what it did.
  const changes = [];
  // _city/_state are for patchVenueMarkets only; the RPC never reads them.
  const clean = rows.map(r => { const { _city, _state, ...keep } = r; return keep; });
  for (const batch of chunk(clean, 200)) {
    const out = await rpc('upsert_events_master', { p_rows: batch });
    for (const r of out) {
      fetched++;
      if (r.out_inserted && r.out_id) addedIds.push(r.out_id);
      else if (r.out_outcome && r.out_outcome !== 'unchanged') changes.push(r);
    }
  }
  const notes = changes.length
    ? changes.map(c => `${c.out_team} v ${c.out_opponent} ${c.out_date}: ${c.out_outcome}`).join('; ').slice(0, 2000)
    : null;
  // Venue-keyed leagues resolve their market AFTER the upsert: the RPC only knows how to look a
  // market up from the team, and for a neutral-site tournament the team is the wrong key.
  let venuePatched = 0;
  try { venuePatched = await patchVenueMarkets(rows); }
  catch (e) { console.warn(`venue market patch failed: ${e.message}`); }
  if (venuePatched) console.log(`Resolved ${venuePatched} market(s) from the venue.`);

  const runId = await rpc('record_schedule_run', { p: {
    league: LEAGUE, season: SEASON, source_url: source, fetched, added: addedIds.length, added_ids: addedIds,
    notes,
  } });
  console.log(`\nDone. ${fetched} processed, ${addedIds.length} newly added, ${changes.length} status/date changes. Change-log run ${runId}.`);
  for (const c of changes) console.log(`  ${c.out_outcome.padEnd(18)} ${c.out_team} v ${c.out_opponent} ${c.out_date}`);
})().catch(e => { console.error(e); process.exit(1); });
