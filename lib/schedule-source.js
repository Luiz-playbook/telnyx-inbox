// Re-read ONE game from the source it originally came from.
//
// scripts/load-schedule.js pulls whole seasons; this asks about a single fixture by its
// external_id. That difference is the point. A bulk diff has to interpret absence — and a
// failed or partial fetch then looks exactly like "every game was cancelled". Asking about one
// named game cannot make that mistake: either the source answers about that game or it does
// not answer at all, and those two are returned as different outcomes here.
//
// Every function returns the same shape:
//   { outcome, event_date, event_time, venue, state, source_url, detail }
//
//   outcome 'found'       — the source knows this game. Fields describe it NOW.
//   outcome 'missing'     — the source responded, and this game is not in it. Suggestive of a
//                           cancellation, NOT proof: ids change, feeds get rebuilt. The caller
//                           must present it as "not found at source", never as "cancelled".
//   outcome 'unreachable' — could not ask. Never to be read as a change of any kind.
//   outcome 'unsupported' — no per-game lookup exists for this league (see ESPN below).
//
// `state` is the source's own word where it has one: 'scheduled', 'postponed', 'cancelled',
// 'suspended'. Only MLB and NHL publish it. Where a source has no such field the value is null,
// which means "this source cannot tell us", and must not be shown as "scheduled".

const UA = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };

async function getJson(url, ms = 15000) {
  const ctl = AbortController ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    const r = await fetch(url, { headers: UA, signal: ctl?.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { if (t) clearTimeout(t); }
}

const res = (outcome, o = {}) => ({
  outcome, event_date: null, event_time: null, venue: null, state: null,
  source_url: null, detail: null, ...o,
});

// ---- MLB: StatsAPI takes the gamePk directly. The richest of the three — it publishes
// status.detailedState ("Scheduled" / "Postponed" / "Cancelled" / "Suspended") and, when a
// game has been moved, rescheduleDate. Verified against gamePk 822699. ----
async function mlb(externalId) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks=${encodeURIComponent(externalId)}`;
  let d;
  try { d = await getJson(url); }
  catch (e) { return res('unreachable', { source_url: url, detail: String(e.message || e) }); }

  const game = (d.dates || []).flatMap(x => x.games || [])[0];
  if (!game) return res('missing', { source_url: url, detail: 'StatsAPI returned no game for this gamePk' });

  const detailed = String(game.status?.detailedState || '');
  const state = /cancel/i.test(detailed) ? 'cancelled'
    : /postpon/i.test(detailed) ? 'postponed'
    : /suspend/i.test(detailed) ? 'suspended'
    : /scheduled|pre-game|warmup|in progress|final|completed/i.test(detailed) ? 'scheduled'
    : null;

  return res('found', {
    // gameDate is the true UTC start instant. event_date must stay the game's LOCAL date, so it
    // is taken from the schedule's own `date` grouping — see the dates/times note in
    // docs/events-pipeline.md, which is explicit that event_date + event_time is not a real
    // timestamp and the two must not be recombined.
    event_date: (d.dates || []).find(x => (x.games || []).some(g => g === game))?.date || null,
    event_time: game.gameDate ? String(game.gameDate).slice(11, 19) : null,
    venue: game.venue?.name || null,
    state, source_url: url,
    detail: [detailed || null, game.rescheduleDate ? `rescheduled to ${game.rescheduleDate}` : null]
      .filter(Boolean).join(' · ') || null,
  });
}

// ---- NHL: /v1/gamecenter/{id}/landing. gameScheduleState carries the lifecycle
// (OK / PPD / CNCL / SUSP). Verified against game 2026020001. ----
async function nhl(externalId) {
  const url = `https://api-web.nhle.com/v1/gamecenter/${encodeURIComponent(externalId)}/landing`;
  let g;
  try { g = await getJson(url); }
  catch (e) {
    // The NHL feed 404s an unknown id, which is the "missing" signal rather than an outage.
    if (/HTTP 404/.test(String(e.message || e))) return res('missing', { source_url: url, detail: 'not found in NHL feed' });
    return res('unreachable', { source_url: url, detail: String(e.message || e) });
  }

  const sched = String(g.gameScheduleState || '').toUpperCase();
  const state = sched === 'CNCL' ? 'cancelled' : sched === 'PPD' ? 'postponed'
    : sched === 'SUSP' ? 'suspended' : sched === 'OK' ? 'scheduled' : null;

  return res('found', {
    event_date: g.gameDate || null,
    event_time: g.startTimeUTC ? String(g.startTimeUTC).slice(11, 19) : null,
    venue: g.venue?.default || null,
    state, source_url: url, detail: sched || null,
  });
}

// ---- NFL: nflverse publishes one CSV for every season and has no per-game endpoint, so the
// whole file is pulled and filtered locally (~2MB, 7.5k rows). No status column exists — a
// cancelled game simply stops appearing, which is why `state` stays null here: absence is
// reported as 'missing' and left for a human to interpret. Verified against 2026_01_NE_SEA. ----
async function nfl(externalId) {
  const url = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
  let text;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    text = await r.text();
  } catch (e) { return res('unreachable', { source_url: url, detail: String(e.message || e) }); }

  const lines = text.split('\n');
  const head = (lines[0] || '').replace(/\r$/, '').split(',');
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  if (ix.game_id == null) return res('unreachable', { source_url: url, detail: 'games.csv has no game_id column — format changed' });

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].replace(/\r$/, '').split(',');
    if (c[ix.game_id] !== externalId) continue;
    return res('found', {
      event_date: c[ix.gameday] || null,
      event_time: c[ix.gametime] ? `${c[ix.gametime]}:00` : null,
      venue: c[ix.stadium] || null,
      state: null,                       // this source has no lifecycle field
      source_url: url,
      detail: c[ix.location] && c[ix.location] !== 'Home' ? `location: ${c[ix.location]}` : null,
    });
  }
  return res('missing', { source_url: url, detail: 'game_id absent from games.csv' });
}

// ---- ESPN-backed leagues (NBA, college). scripts/load-schedule.js can read these, but
// docs/events-pipeline.md (AI-844) records that ESPN does not resolve from the dev or prod
// network here — which is why NHL moved to api-web and NFL to nflverse in the first place.
// Returning 'unsupported' outright is honest; attempting it would hang and then fail anyway.
const ESPN_LEAGUES = new Set(['nba', 'ncaaf', 'ncaab', 'college']);

export async function fetchGame({ league, external_id }) {
  const lg = String(league || '').toLowerCase().trim();
  const id = String(external_id || '').trim();
  if (!id) return res('unsupported', { detail: 'this event has no external_id to look up' });

  if (lg === 'mlb') return mlb(id);
  if (lg === 'nhl') return nhl(id);
  if (lg === 'nfl') return nfl(id);
  if (ESPN_LEAGUES.has(lg)) {
    return res('unsupported', { detail: `${lg.toUpperCase()} comes from ESPN, which is not reachable from this network (AI-844). Rescan is unavailable for this league.` });
  }
  return res('unsupported', { detail: `no schedule source is wired up for league "${lg}"` });
}

// What changed between the stored row and the source. Compared as strings because event_date is
// a plain date and event_time a plain time — turning either into a Date would reintroduce the
// timezone bug this codebase has already been bitten by twice.
export function diffGame(stored, live) {
  const norm = v => (v == null || v === '') ? null : String(v).slice(0, 19);
  const fields = ['event_date', 'event_time', 'venue'];
  const changes = [];
  for (const f of fields) {
    const before = norm(stored?.[f]), after = norm(live?.[f]);
    if (after != null && before !== after) changes.push({ field: f, before, after });
  }
  return changes;
}
