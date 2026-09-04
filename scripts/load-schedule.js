// AI-830: schedule refresh pipeline. Pulls a league's released games into events_master
// and records a change-log row (events_master_schedule_runs) with the ids added.
//
// Idempotent — upsert_events_master() skips games already present, so re-running (or an
// overlapping monthly run) only ever ADDS newly released games. Never re-scrapes.
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
const ESPN = {
  nba: 'basketball/nba', nfl: 'football/nfl', nhl: 'hockey/nhl',
  // WNBA is its own league, not a variant of the NBA — different teams, different arenas, and a
  // May-to-October season, so it is loaded and filtered separately. It shares the SPORT
  // 'Basketball' the way CFB shares 'Football' with the NFL.
  wnba: 'basketball/wnba',
  ncaaf: 'football/college-football', ncaab: 'basketball/mens-college-basketball',
};

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Game status (migration 053). Every loader maps its source's own status field onto
// scheduled | postponed | cancelled; anything unrecognised stays 'scheduled'.
//
// The rule is: only an EXPLICIT upstream status takes a game out of circulation. A game simply
// missing from a response is not a cancellation — feeds truncate, windows shift, and some sources
// drop games once they're played. Guessing from absence would silently kill live blasts.

// MLB StatsAPI: status.detailedState is the human string ('Postponed', 'Cancelled'), and
// codedGameState 'D'/'C' the machine one. Read both — detailedState carries qualifiers
// ('Postponed - Rain') that an equality check would miss.
function mlbStatus(g) {
  const s = `${g.status?.detailedState || ''} ${g.status?.codedGameState || ''}`.toLowerCase();
  if (/cancel/.test(s)) return 'cancelled';
  if (/postpon|suspend/.test(s)) return 'postponed';
  return 'scheduled';
}

// ---- MLB: StatsAPI, one call for the whole range ----
async function loadMLB() {
  const teamsUrl = `https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${YEAR}`;
  const teams = new Map();
  for (const t of (await getJson(teamsUrl)).teams || [])
    teams.set(t.id, { nick: (t.teamName || t.name || '').toLowerCase().trim(), full: t.name });
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${START}&endDate=${END}`;
  const sched = await getJson(url);
  const rows = [];
  for (const day of sched.dates || []) for (const g of day.games || []) {
    const home = teams.get(g.teams?.home?.team?.id) || {}, away = teams.get(g.teams?.away?.team?.id) || {};
    rows.push({
      league: 'mlb', team: home.nick || (g.teams?.home?.team?.name || '').toLowerCase(),
      team_full: home.full, opponent: away.nick || g.teams?.away?.team?.name,
      event_date: day.date, event_time: g.gameDate ? g.gameDate.slice(11, 19) : null,
      venue: g.venue?.name || null, home_away: 'home', external_id: String(g.gamePk),
      status: mlbStatus(g), source_url: url, source_note: 'MLB StatsAPI; event_time UTC', season: SEASON,
    });
  }
  return { rows, source: url };
}

// ---- NHL: official api-web.nhle.com. One call per team returns the whole season;
// iterating all teams and keeping home games only yields each game exactly once. ----
async function loadNHL() {
  const seasonId = `${YEAR}${YEAR + 1}`;                 // e.g. 20262027
  const st = await getJson('https://api-web.nhle.com/v1/standings/now');
  const tricodes = [...new Set((st.standings || []).map(s => s.teamAbbrev?.default).filter(Boolean))];
  const rows = [];
  let firstUrl = null;
  for (const tri of tricodes) {
    const url = `https://api-web.nhle.com/v1/club-schedule-season/${tri}/${seasonId}`;
    if (!firstUrl) firstUrl = url;
    let data;
    try { data = await getJson(url); } catch { continue; }
    for (const g of data.games || []) {
      if (g.gameType !== 2) continue;                    // 2 = regular season
      if (g.homeTeam?.abbrev !== tri) continue;          // home games only -> game counted once
      const home = g.homeTeam, away = g.awayTeam;
      rows.push({
        league: 'nhl',
        team: (home.commonName?.default || home.abbrev || '').toLowerCase(),
        team_full: [home.placeName?.default, home.commonName?.default].filter(Boolean).join(' ') || home.abbrev,
        opponent: (away.commonName?.default || away.abbrev || '').toLowerCase(),
        event_date: g.gameDate,
        event_time: g.startTimeUTC ? g.startTimeUTC.slice(11, 19) : null,
        venue: g.venue?.default || null,
        home_away: 'home', external_id: String(g.id),
        // NHL keeps schedule state separate from play state: gameScheduleState is OK | PPD
        // (postponed) | CNCL (cancelled) | SUSP (suspended). gameState is about the puck.
        status: ({ PPD: 'postponed', SUSP: 'postponed', CNCL: 'cancelled' })[g.gameScheduleState] || 'scheduled',
        source_url: url, source_note: 'NHL api-web; event_time UTC', season: SEASON,
      });
    }
  }
  return { rows, source: firstUrl || 'https://api-web.nhle.com' };
}

// ---- NFL: nflverse community dataset (widely-public, no official API needed).
// One CSV holds every season; we filter to REG home games. Neutral-site (international)
// games are excluded — the home team isn't actually hosting in its market. ----
const NFL_TEAMS = {
  ARI: ['cardinals', 'Arizona Cardinals'], ATL: ['falcons', 'Atlanta Falcons'],
  BAL: ['ravens', 'Baltimore Ravens'], BUF: ['bills', 'Buffalo Bills'],
  CAR: ['panthers', 'Carolina Panthers'], CHI: ['bears', 'Chicago Bears'],
  CIN: ['bengals', 'Cincinnati Bengals'], CLE: ['browns', 'Cleveland Browns'],
  DAL: ['cowboys', 'Dallas Cowboys'], DEN: ['broncos', 'Denver Broncos'],
  DET: ['lions', 'Detroit Lions'], GB: ['packers', 'Green Bay Packers'],
  HOU: ['texans', 'Houston Texans'], IND: ['colts', 'Indianapolis Colts'],
  JAX: ['jaguars', 'Jacksonville Jaguars'], KC: ['chiefs', 'Kansas City Chiefs'],
  LA: ['rams', 'Los Angeles Rams'], LAC: ['chargers', 'Los Angeles Chargers'],
  LV: ['raiders', 'Las Vegas Raiders'], MIA: ['dolphins', 'Miami Dolphins'],
  MIN: ['vikings', 'Minnesota Vikings'], NE: ['patriots', 'New England Patriots'],
  NO: ['saints', 'New Orleans Saints'], NYG: ['giants', 'New York Giants'],
  NYJ: ['jets', 'New York Jets'], PHI: ['eagles', 'Philadelphia Eagles'],
  PIT: ['steelers', 'Pittsburgh Steelers'], SEA: ['seahawks', 'Seattle Seahawks'],
  SF: ['49ers', 'San Francisco 49ers'], TB: ['buccaneers', 'Tampa Bay Buccaneers'],
  TEN: ['titans', 'Tennessee Titans'], WAS: ['commanders', 'Washington Commanders'],
};

async function loadNFL() {
  const url = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const text = await res.text();
  const linesRaw = text.split('\n');
  const header = linesRaw[0].replace(/\r$/, '').split(',');
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  for (let i = 1; i < linesRaw.length; i++) {
    const c = linesRaw[i].replace(/\r$/, '').split(',');
    if (Number(c[ix.season]) !== YEAR || c[ix.game_type] !== 'REG' || c[ix.location] !== 'Home') continue;
    const home = NFL_TEAMS[c[ix.home_team]] || [c[ix.home_team]?.toLowerCase(), c[ix.home_team]];
    const away = NFL_TEAMS[c[ix.away_team]] || [c[ix.away_team]?.toLowerCase(), c[ix.away_team]];
    rows.push({
      // No status mapped: the nflverse CSV has no cancellation/postponement column, so every NFL
      // row loads as 'scheduled' and a cancelled NFL game must be flagged by hand until this
      // source is replaced. Leaving `status` off entirely is deliberate — the RPC defaults it —
      // rather than sending a 'scheduled' we cannot actually stand behind.
      league: 'nfl', team: home[0], team_full: home[1], opponent: away[0],
      event_date: c[ix.gameday], event_time: (c[ix.gametime] || '') ? c[ix.gametime] + ':00' : null,
      venue: c[ix.stadium] || null, home_away: 'home', external_id: c[ix.game_id],
      source_url: url, source_note: 'nflverse/nfldata games.csv; gametime local ET', season: SEASON,
    });
  }
  return { rows, source: url };
}

// ESPN spells it CANCELED (one L). Match on the stem so both spellings land.
function espnStatus(name) {
  const s = (name || '').toLowerCase();
  if (/cancel/.test(s)) return 'cancelled';
  if (/postpon|suspend/.test(s)) return 'postponed';
  return 'scheduled';
}

// ---- ESPN: scoreboard walked day by day across [START, END] ----
async function loadESPN() {
  const path = ESPN[LEAGUE];
  if (!path) throw new Error(`no ESPN mapping for league "${LEAGUE}"`);
  const rows = [];
  const d = new Date(START + 'T00:00:00Z'), end = new Date(END + 'T00:00:00Z');
  let firstUrl = null;
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ymd}&limit=400`;
    if (!firstUrl) firstUrl = url;
    let data;
    try { data = await getJson(url); } catch { continue; }
    for (const ev of data.events || []) {
      const comp = ev.competitions?.[0]; if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      // NEUTRAL SITE IS NOT A HOME GAME. loadNFL and loadCFB both drop these; this path did not,
      // and it is the one every ESPN-sourced league uses. The row still names a "home" team, so
      // the game would be credited to that team's market while being played somewhere else
      // entirely — an NBA season carries a handful (Las Vegas, Mexico City, a college arena),
      // and a blast for a Mavericks home game that is actually in Las Vegas is worse than no
      // blast. The market is what the audience resolves from, so this has to match reality.
      if (comp.neutralSite) continue;
      // TBD placeholders. The NBA Cup knockout rounds appear on the schedule before the teams
      // are known, as "TBD at TBD" with no venue — three of them loaded on the first run. They
      // can never resolve a market, so they would sit in Ticket Prices as permanently
      // unpriceable rows describing a game nobody can be sold a ticket to.
      const hn = (home.team?.name || home.team?.shortDisplayName || '').toLowerCase();
      const an = (away.team?.name || away.team?.shortDisplayName || '').toLowerCase();
      if (!hn || !an || hn === 'tbd' || an === 'tbd') continue;
      rows.push({
        league: LEAGUE, team: (home.team?.name || home.team?.shortDisplayName || '').toLowerCase(),
        team_full: home.team?.displayName, opponent: (away.team?.name || away.team?.shortDisplayName || '').toLowerCase(),
        event_date: (ev.date || '').slice(0, 10), event_time: (ev.date || '').slice(11, 19) || null,
        venue: comp.venue?.fullName || null, home_away: 'home', external_id: String(ev.id),
        // ESPN: status.type.name is STATUS_SCHEDULED / STATUS_POSTPONED / STATUS_CANCELED.
        status: espnStatus(comp.status?.type?.name || ev.status?.type?.name),
        source_url: url, source_note: 'ESPN scoreboard; event_time UTC', season: SEASON,
      });
    }
  }
  return { rows, source: firstUrl };
}

// ---- CFB: CollegeFootballData (CFBD). One call returns the whole regular season.
//
// Why not ESPN, which is what the espn.com/college-football/schedule page shows: that page is
// rendered from a public JSON scoreboard endpoint, so no scraping is needed either way — but it
// is queried a DAY AT A TIME (~100 requests for a season) and has no division field. CFBD gives
// the season in one 1.4s call and carries homeClassification, which is the only practical way to
// keep FBS and leave 2,757 D-II/D-III games out.
//
// FBS home games, non-neutral — the same shape loadNFL() uses. Neutral-site games are excluded
// because the home team is not actually hosting in its market, which is what the audience is
// resolved from.
async function loadCFB() {
  const key = (process.env.CFBD_API_KEY || '').trim();
  if (!key) throw new Error('CFBD_API_KEY is not set — required for --league cfb');
  const gamesUrl = `https://api.collegefootballdata.com/games?year=${YEAR}&seasonType=regular`;
  const venuesUrl = 'https://api.collegefootballdata.com/venues';
  const teamsUrl = `https://api.collegefootballdata.com/teams/fbs?year=${YEAR}`;
  const auth = { headers: { Authorization: `Bearer ${key}` } };

  const [games, venues, teams] = await Promise.all([
    fetch(gamesUrl, auth).then(r => { if (!r.ok) throw new Error(`${r.status} for ${gamesUrl}`); return r.json(); }),
    fetch(venuesUrl, auth).then(r => r.ok ? r.json() : []),
    fetch(teamsUrl, auth).then(r => r.ok ? r.json() : []),
  ]);
  const vById = new Map((venues || []).map(v => [v.id, v]));
  // team_full is the marketing-facing name ("Michigan Wolverines"). CFBD's /games only carries
  // the school, so the mascot comes from /teams — and team_full drives the SeatGeek slug the
  // price lookup falls back to, so a bare school name would break those links.
  const mascotBySchool = new Map((teams || []).map(t => [t.school, t.mascot]));

  const rows = [];
  for (const gm of games) {
    if (gm.homeClassification !== 'fbs' || gm.neutralSite) continue;
    if (!gm.startDate || !gm.homeTeam || !gm.awayTeam) continue;
    const v = vById.get(gm.venueId) || {};
    const d = new Date(gm.startDate);
    if (isNaN(d)) continue;
    const mascot = mascotBySchool.get(gm.homeTeam);
    rows.push({
      league: 'cfb',
      // Lowercased school, matching how market_bridge_team.team_lc is keyed for every other
      // league. Checked against the existing bridge before loading: zero CFB school names
      // collide with a pro team already in there.
      team: gm.homeTeam.toLowerCase().trim(),
      team_full: mascot ? `${gm.homeTeam} ${mascot}` : gm.homeTeam,
      opponent: gm.awayTeam.toLowerCase().trim(),
      event_date: gm.startDate.slice(0, 10),
      // startDate is UTC, like the MLB feed — events_master stores UTC and every screen renders ET.
      event_time: gm.startTimeTBD ? null : gm.startDate.slice(11, 19),
      venue: gm.venue || v.name || null,
      home_away: 'home',
      external_id: String(gm.id),
      // CFBD has no cancellation field, so status is left off for the RPC to default — the same
      // call loadNFL() makes, and for the same reason: better an honest default than a
      // 'scheduled' we cannot stand behind.
      source_url: gamesUrl,
      source_note: 'CollegeFootballData /games, FBS home non-neutral; startDate UTC',
      season: `${YEAR}-cfb`,
    });
  }
  return { rows, source: gamesUrl };
}

// ---- March Madness: the NCAA men's tournament, via ESPN.
//
// NOT A LEAGUE IN THE USUAL SENSE, AND IT BREAKS TWO ASSUMPTIONS THE OTHER LOADERS RELY ON.
//
// 1. EVERY GAME IS NEUTRAL-SITE. loadESPN skips those, and rightly — for a league, a neutral
//    site means the "home" team is not hosting in its market. Here it is the whole format: 63
//    of 87 games across the probed 2026 dates were neutral, and the ones that were not are the
//    NIT. So this cannot go through loadESPN and needs its own pass.
//
// 2. THE MARKET COMES FROM THE VENUE, NOT THE TEAM. The home side is a bracket artifact — Duke
//    played Siena in Greenville, South Carolina. Keyed on the team, that game would market to
//    North Carolina; keyed on the venue it correctly reaches South Carolina. upsert_events_master
//    resolves market from market_bridge_team on the team name and offers no override, so these
//    rows land with market_code null and are corrected in a second pass (patchVenueMarkets
//    below) from the venue city and state.
//
//    That second pass is the honest short-term answer, not the good long-term one: the clean fix
//    is for the RPC to accept an explicit market, which is a migration. Doing it here keeps the
//    change inside this script until that lands.
//
// Selection Sunday is when the bracket appears — ESPN has nothing for the 2027 dates yet, so
// this loads zero rows until roughly mid-March. It is wired into the monthly schedule-refresh
// cron for exactly that reason: the month the bracket is published, it loads itself.
const MM_HEADLINE = /^NCAA Men'?s Basketball Championship/i;

async function loadMarchMadness() {
  const rows = [];
  // The tournament runs from the First Four to the final: mid-March into early April. Widened a
  // little at both ends so a calendar shift cannot silently drop the first or last games.
  const from = new Date(`${YEAR}-03-10T00:00:00Z`);
  const to = new Date(`${YEAR}-04-15T00:00:00Z`);
  let firstUrl = null;
  for (const d = from; d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
    // groups=50 is Division I. limit is generous: the First Four and the round of 64 put a lot
    // of games on one day.
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${ymd}&groups=50&limit=200`;
    if (!firstUrl) firstUrl = url;
    let data;
    try { data = await getJson(url); } catch { continue; }
    for (const ev of data.events || []) {
      const comp = ev.competitions?.[0]; if (!comp) continue;
      // The NIT and the College Basketball Crown run on the same dates and appear in the same
      // feed. Only the NCAA championship is "March Madness"; the others are a different product
      // and would quietly pad the league with games nobody asked for.
      const headline = comp.notes?.[0]?.headline || '';
      if (!MM_HEADLINE.test(headline)) continue;

      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const hn = (home.team?.name || home.team?.shortDisplayName || '').toLowerCase();
      const an = (away.team?.name || away.team?.shortDisplayName || '').toLowerCase();
      if (!hn || !an || hn === 'tbd' || an === 'tbd') continue;   // pre-bracket placeholders

      const addr = comp.venue?.address || {};
      rows.push({
        league: 'march_madness',
        team: hn, team_full: home.team?.displayName, opponent: an,
        event_date: (ev.date || '').slice(0, 10),
        event_time: (ev.date || '').slice(11, 19) || null,
        venue: comp.venue?.fullName || null,
        home_away: 'home', external_id: String(ev.id),
        status: espnStatus(comp.status?.type?.name || ev.status?.type?.name),
        source_url: url,
        // The round is worth keeping: "First Four" and "National Championship" are very
        // different propositions to sell against, and nothing else on the row records it.
        source_note: `ESPN scoreboard; ${headline}; event_time UTC`,
        season: `${YEAR}-march_madness`,
        // Carried for patchVenueMarkets, stripped before the upsert — the RPC ignores unknown
        // keys, but sending fields it will never read invites someone to think it uses them.
        _city: addr.city || null, _state: addr.state || null,
      });
    }
  }
  return { rows, source: firstUrl };
}

// Resolve market from the VENUE for rows that carry one, and patch it in after the upsert.
// Returns how many rows were given a market.
async function patchVenueMarkets(rows) {
  const withVenue = rows.filter(r => r._city || r._state);
  if (!withVenue.length) return 0;
  const q = (p) => fetch(`${SUPA_URL}/rest/v1/${p}`, {
    headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` },
  }).then(r => r.json());
  const [markets, bridge] = await Promise.all([q('market_state?select=market_key,state_code&limit=500'), q('market_bridge_team?select=market_key&limit=2000')]);
  const byState = {};
  for (const m of markets) (byState[m.state_code] = byState[m.state_code] || []).push(m.market_key);
  const keyOf = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');

  let patched = 0;
  for (const r of withVenue) {
    const cands = byState[r._state] || [];
    if (!cands.length) continue;                       // no market in that state — leave null
    const city = keyOf(r._city);
    // A host city that IS one of our markets wins; otherwise the state has one market and that
    // is unambiguous. Several markets and no city match is left alone rather than guessed at —
    // the state is what decides the audience, so a wrong pick here is only a wrong label, but
    // an unmapped row is honest and a wrong one is not.
    const market = cands.includes(city) ? city : (cands.length === 1 ? cands[0] : null);
    if (!market) continue;
    const res = await fetch(`${SUPA_URL}/rest/v1/events_master?league=eq.march_madness&external_id=eq.${encodeURIComponent(r.external_id)}`, {
      method: 'PATCH',
      headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ market_code: market, state_code: r._state }),
    });
    if (res.ok) patched++;
  }
  return patched;
}

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
  const loaders = { mlb: loadMLB, nhl: loadNHL, nfl: loadNFL, cfb: loadCFB, march_madness: loadMarchMadness }; // official/community; rest fall back to ESPN
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
