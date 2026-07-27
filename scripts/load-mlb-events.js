// AI-826 first load: all remaining MLB home games -> public.events_master.
//
// Deterministic. Pulls the schedule from the MLB StatsAPI (public, no key, matches the
// published schedule exactly), NOT from an LLM. Every row carries the exact API URL it
// came from in source_url, so it is spot-checkable against mlb.com.
//
//   node --env-file=.env scripts/load-mlb-events.js            # today -> end of season
//   node --env-file=.env scripts/load-mlb-events.js --dry      # print, write nothing
//   node --env-file=.env scripts/load-mlb-events.js --end 2026-10-05
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY. Writes go through the upsert_events_master rpc
// (SECURITY DEFINER), so no service-role key is needed and re-runs are idempotent.

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY'); process.exit(1); }

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const SEASON_YEAR = 2026;
const SEASON_TAG = `${SEASON_YEAR}-mlb`;
const today = new Date().toISOString().slice(0, 10);
const START = argVal('--start') || today;
const END = argVal('--end') || `${SEASON_YEAR}-12-31`; // safely past the regular season
const BATCH = 200;

function argVal(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

async function getJson(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// id -> nickname (lowercased, matches market_bridge_team.team_lc, e.g. 'cubs')
async function teamNicknames() {
  const url = `https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${SEASON_YEAR}`;
  const data = await getJson(url);
  const map = new Map();
  for (const t of data.teams || []) {
    map.set(t.id, { nick: (t.teamName || t.clubName || t.name || '').toLowerCase().trim(), full: t.name });
  }
  return map;
}

async function schedule() {
  // gameType=R = regular season. One call spans the whole window.
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${START}&endDate=${END}`;
  return { url, data: await getJson(url) };
}

function toRows(sched, teams) {
  const rows = [];
  for (const day of sched.data.dates || []) {
    for (const g of day.games || []) {
      // one row per game, keyed on the HOME team = "all home games for all teams"
      const home = teams.get(g.teams?.home?.team?.id) || {};
      const away = teams.get(g.teams?.away?.team?.id) || {};
      const timeUTC = g.gameDate ? g.gameDate.slice(11, 19) : null; // HH:MM:SS UTC
      rows.push({
        league: 'mlb',
        team: home.nick || (g.teams?.home?.team?.name || '').toLowerCase(),
        team_full: home.full || g.teams?.home?.team?.name,
        opponent: away.nick || g.teams?.away?.team?.name,
        event_date: day.date,          // official local game date
        event_time: timeUTC,           // UTC — see source_note
        venue: g.venue?.name || null,
        home_away: 'home',
        external_id: String(g.gamePk),
        source_url: sched.url,
        source_note: 'MLB StatsAPI schedule; event_time is UTC (gameDate)',
        season: SEASON_TAG,
      });
    }
  }
  return rows;
}

async function upsert(batch) {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/upsert_events_master`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` },
    body: JSON.stringify({ p_rows: batch }),
  });
  if (!res.ok) throw new Error(`upsert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

(async () => {
  console.log(`MLB load ${START} -> ${END}  (season ${SEASON_TAG})${DRY ? '  [DRY]' : ''}`);
  const teams = await teamNicknames();
  const sched = await schedule();
  const rows = toRows(sched, teams);
  console.log(`Fetched ${rows.length} home games across ${new Set(rows.map(r => r.team)).size} teams.`);
  console.log(`Source: ${sched.url}`);

  if (DRY) {
    console.table(rows.slice(0, 10).map(r => ({ date: r.event_date, team: r.team, opp: r.opponent, venue: r.venue })));
    console.log(`(dry run — wrote nothing; ${rows.length} rows would be upserted)`);
    return;
  }

  let inserted = 0, seen = 0;
  const unmatched = new Set();
  for (let i = 0; i < rows.length; i += BATCH) {
    const out = await upsert(rows.slice(i, i + BATCH));
    for (const r of out) {
      seen++;
      if (r.out_inserted) inserted++;
      if (!r.out_market) unmatched.add(r.out_team);
    }
    console.log(`  batch ${i / BATCH + 1}: ${out.length} processed`);
  }
  console.log(`\nDone. ${seen} processed, ${inserted} newly inserted, ${seen - inserted} already present.`);
  if (unmatched.size) console.log(`No market resolved for: ${[...unmatched].sort().join(', ')} (rows kept, market_code = null).`);
})().catch(e => { console.error(e); process.exit(1); });
