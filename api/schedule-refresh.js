// AI-830: weekly schedule-refresh cron, one league per run. Pulls newly released games into events_master
// (idempotent) and records a change-log row.
//
// USED TO BE MLB-ONLY, WHICH MEANT EVERY OTHER LEAGUE WENT STALE. The loaders for NFL, NHL, NBA,
// college football, the WNBA and the NCAA tournament lived in scripts/load-schedule.js — a
// command-line tool wired to no route and no cron — so those leagues were only ever in the table
// because somebody ran the command by hand. Nothing would have noticed a new season being
// published. The loaders now live in lib/schedules.js and both callers share them.
//
// ?league=<code> picks the league; omitted, it does MLB, so the existing cron entry keeps
// behaving exactly as it did. ?year, ?start, ?end override the window, which otherwise comes from
// SEASONS below.
//
// ONE LEAGUE PER REQUEST, ON PURPOSE. maxDuration is 60s and ESPN's scoreboard is addressed by
// date, so a full NBA season is ~270 requests — 5s now that they are batched (see loadESPN), but
// running every league in one invocation would stack those and eventually blow the ceiling. Each
// league gets its own cron entry in vercel.json instead: independent, and one league failing
// cannot take the others down with it.
//
// Auth: PRICE_CRON_SECRET via ?token= or Bearer; unset => open.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CFBD_API_KEY (college football only).

import { supabaseKey } from '../lib/supabase.js';
import { makeLoaders } from '../lib/schedules.js';

export const config = { maxDuration: 60 };

// When each league's fixtures actually exist. Loading NBA in July returns nothing and looks like
// a broken job; loading it across the turn of the year needs an END in the following year, which
// a naive `${YEAR}-12-31` would cut in half. Offsets are months from January of the given year;
// endYearOffset moves the end date into the next calendar year where a season crosses it.
const SEASONS = {
  mlb:           { startMonth: 3,  endMonth: 11, endYearOffset: 0 },
  nfl:           { startMonth: 9,  endMonth: 2,  endYearOffset: 1 },
  nhl:           { startMonth: 10, endMonth: 6,  endYearOffset: 1 },
  nba:           { startMonth: 10, endMonth: 6,  endYearOffset: 1 },
  cfb:           { startMonth: 8,  endMonth: 1,  endYearOffset: 1 },
  wnba:          { startMonth: 5,  endMonth: 10, endYearOffset: 0 },
  march_madness: { startMonth: 3,  endMonth: 4,  endYearOffset: 0 },
};

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export default async function handler(req, res) {
  // Dedicated price/schedule cron secret, isolated from the shared CRON_SECRET (see
  // price-refresh.js). Accepted via ?token= or Bearer; unset => open.
  const priceSecret = process.env.PRICE_CRON_SECRET;
  const tokenOk = priceSecret && (req.query?.token === priceSecret || req.headers.authorization === `Bearer ${priceSecret}`);
  if (priceSecret && !tokenOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const supaUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), supaKey = supabaseKey();
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };
  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  const LEAGUE = String(req.query?.league || 'mlb').toLowerCase();
  const YEAR = Number(req.query?.year) || new Date().getUTCFullYear();
  const win = SEASONS[LEAGUE];
  if (!win) { res.status(400).json({ error: `unknown league "${LEAGUE}"`, known: Object.keys(SEASONS) }); return; }

  // ROLL FORWARD ONCE THIS YEAR'S SEASON IS OVER. Anchoring blindly to the current calendar year
  // asks March Madness in September for the tournament that finished in April — a window whose end
  // precedes its start, and a loader that re-reads games already in the table. Every window here is
  // at most twelve months and anchored to a calendar year, so a single +1 always lands on the next
  // edition; no loop is needed.
  const today = new Date().toISOString().slice(0, 10);
  let year = YEAR;
  if (ymd(year + win.endYearOffset, win.endMonth, 28) < today) year += 1;

  // The window never starts before today: this job adds newly released games, and re-reading
  // months of finished fixtures costs time and adds nothing — upsert_events_master skips them.
  const seasonStart = ymd(year, win.startMonth, 1);
  const START = String(req.query?.start || (seasonStart > today ? seasonStart : today));
  const END = String(req.query?.end || ymd(year + win.endYearOffset, win.endMonth, 28));
  const SEASON = `${year}-${LEAGUE}`;

  const { loaders, loadESPN, patchVenueMarkets } = makeLoaders({
    YEAR: year, START, END, SEASON, LEAGUE, SUPA_URL: supaUrl, SUPA_KEY: supaKey,
  });

  try {
    const { rows, source } = await (loaders[LEAGUE] || loadESPN)();
    if (dry) { res.status(200).json({ ok: true, dry: true, league: LEAGUE, season: SEASON, start: START, end: END, fetched: rows.length }); return; }
    if (!rows.length) {
      // Not an error: out of season, or the fixtures are not published yet. Logged as a real run
      // so "did the job even fire?" is answerable from the change log rather than guessed at.
      await fetch(`${supaUrl}/rest/v1/rpc/record_schedule_run`, { method: 'POST', headers: sh,
        body: JSON.stringify({ p: { league: LEAGUE, season: SEASON, source_url: source, fetched: 0, added: 0, added_ids: [], notes: 'no fixtures returned — out of season or not yet released' } }) }).catch(() => {});
      res.status(200).json({ ok: true, league: LEAGUE, season: SEASON, start: START, end: END, fetched: 0, added: 0, note: 'no fixtures returned' });
      return;
    }

    // _city/_state are hints for patchVenueMarkets and are not columns; the RPC ignores unknown
    // keys, but sending fields it will never read invites someone to think it uses them.
    const clean = rows.map(r => { const { _city, _state, ...keep } = r; return keep; });

    const addedIds = [];
    let fetched = 0;
    const changes = [];
    for (const batch of chunk(clean, 200)) {
      const out = await fetch(`${supaUrl}/rest/v1/rpc/upsert_events_master`, { method: 'POST', headers: sh, body: JSON.stringify({ p_rows: batch }) }).then(r => r.json());
      for (const r of (out || [])) {
        fetched++;
        if (r.out_inserted && r.out_id) addedIds.push(r.out_id);
        else if (r.out_outcome && r.out_outcome !== 'unchanged') changes.push(r);
      }
    }

    // Venue-keyed leagues resolve their market after the upsert: the RPC only knows how to look a
    // market up from the team, and for a neutral-site tournament the team is the wrong key.
    let venuePatched = 0;
    try { venuePatched = await patchVenueMarkets(rows); } catch { /* market stays null; still visible */ }

    const notes = [
      changes.length ? changes.map(c => `${c.out_team} v ${c.out_opponent} ${c.out_date}: ${c.out_outcome}`).join('; ') : '',
      venuePatched ? `${venuePatched} market(s) resolved from venue` : '',
    ].filter(Boolean).join(' | ').slice(0, 2000) || null;

    const runId = await fetch(`${supaUrl}/rest/v1/rpc/record_schedule_run`, { method: 'POST', headers: sh,
      body: JSON.stringify({ p: { league: LEAGUE, season: SEASON, source_url: source, fetched, added: addedIds.length, added_ids: addedIds, notes } }) }).then(r => r.json());

    res.status(200).json({
      ok: true, league: LEAGUE, season: SEASON, start: START, end: END,
      fetched, added: addedIds.length, changed: changes.length, venue_markets: venuePatched, run_id: runId,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e), league: LEAGUE });
  }
}
