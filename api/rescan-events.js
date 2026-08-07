// Bulk rescan: re-check a whole league's upcoming fixtures in one pass.
//
// POST { league, apply?: boolean, from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
//
// One request per league, not one per game. These feeds publish whole-season endpoints, so a
// single call answers for all 694 upcoming MLB fixtures; looping the per-game route would be
// 694 requests for the same data.
//
// THE HAZARD THIS ROUTE HAS TO HANDLE
//
// Diffing in bulk means interpreting ABSENCE — a game we hold that the feed no longer lists.
// That is the cancellation signal, and it is also exactly what a failed or partial fetch looks
// like. Get it wrong and one bad afternoon marks a whole season cancelled.
//
// Three guards, none of which may be removed:
//   1. lib/schedule-source.js returns ok:false if ANY part of the pull failed (for NHL that
//      includes a single team's schedule 404ing). ok:false => absence is not evaluated at all.
//   2. A sanity floor: a pull returning implausibly few games is treated as broken, not as
//      evidence that everything vanished.
//   3. Absence is NEVER auto-applied, even with apply:true. It is reported as 'missing' for a
//      human to confirm. Only an explicit lifecycle state from the feed ('cancelled') or a
//      changed date is ever written.
//
// Auth / env as the sibling routes.

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';
import { fetchLeagueGames, diffGame } from '../lib/schedule-source.js';

// NHL walks 32 club schedules; MLB and NFL are single calls.
export const config = { maxDuration: 300 };

// Below this, a "successful" pull is assumed broken rather than believed. Real seasons are
// 264 (NFL) to 1344 (NHL) games; anything under this is a feed having a bad day.
const MIN_PLAUSIBLE_GAMES = 50;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const secret = process.env.CRON_SECRET;
  const authed = !secret || req.query?.token === secret || req.headers.authorization === `Bearer ${secret}`;
  if (!authed) { res.status(401).json({ error: 'unauthorized' }); return; }

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const headers = supabaseHeaders(key);

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const league = String(body.league || '').toLowerCase().trim();
  const apply = body.apply === true;
  if (!league) { res.status(400).json({ error: 'league is required' }); return; }

  // Default window: today (US Eastern, the clock event_date is written in) forward. Past games
  // are not rescanned — nothing useful can come of correcting a fixture already played.
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const from = String(body.from || todayEt);
  const to = body.to ? String(body.to) : null;

  try {
    // Paged. PostgREST caps a plain select at 1000 rows and says nothing about it — NHL holds
    // 1,344 upcoming fixtures, so an unpaged read silently dropped 344 of them and reported a
    // clean bill of health for games it never looked at. Caught in a dry run against production.
    const stored = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const r = await fetch(
        `${url}/rest/v1/events_master?league=eq.${encodeURIComponent(league)}`
        + `&event_date=gte.${from}${to ? `&event_date=lte.${to}` : ''}`
        + `&select=id,league,team,opponent,event_date,event_time,venue,external_id,schedule_state`
        + `&order=event_date,id&limit=${PAGE}&offset=${offset}`,
        { headers },
      );
      if (!r.ok) { res.status(502).json({ error: `could not read events_master (HTTP ${r.status})` }); return; }
      const page = await r.json();
      if (!Array.isArray(page)) { res.status(502).json({ error: 'events_master returned no rows' }); return; }
      stored.push(...page);
      if (page.length < PAGE) break;
      if (offset > 100000) break;                  // runaway guard, not an expected limit
    }

    if (!stored.length) {
      res.status(200).json({ ok: true, league, from, to, checked: 0, results: [], summary: emptySummary(), detail: 'no upcoming events stored for this league' });
      return;
    }

    const live = await fetchLeagueGames(league);

    // Guards 1 and 2. Nothing was learned, so nothing — including absence — is interpreted.
    const tooFew = live.ok && live.games.size < MIN_PLAUSIBLE_GAMES;
    if (!live.ok || tooFew) {
      res.status(200).json({
        ok: true, league, from, to, checked: stored.length,
        outcome: live.unsupported ? 'unsupported' : 'unreachable',
        applied: 0, results: [], summary: emptySummary(),
        detail: tooFew
          ? `source returned only ${live.games.size} games, which is implausibly few — treating the pull as failed rather than as mass cancellation`
          : (live.detail || 'the schedule source could not be read'),
        source_url: live.source_url,
      });
      return;
    }

    const results = [];
    for (const row of stored) {
      const id = String(row.external_id || '').trim();
      const g = id ? live.games.get(id) : null;

      if (!id) { results.push({ ...ref(row), outcome: 'no-external-id' }); continue; }
      // Guard 3: reported, never applied.
      if (!g) { results.push({ ...ref(row), outcome: 'missing' }); continue; }

      const changes = diffGame(row, g);
      const stateChanged = !!g.state && g.state !== row.schedule_state;
      const outcome = g.state === 'cancelled' ? 'cancelled'
        : changes.some(c => c.field === 'event_date') ? 'moved'
        : changes.length ? 'details-changed'
        : 'unchanged';
      results.push({ ...ref(row), outcome, changes, state: g.state, state_changed: stateChanged, source: g });
    }

    // Apply only what the feed positively asserts: a changed date/time/venue, or a lifecycle
    // state it published. 'missing' is excluded by construction — it never carries changes.
    let applied = 0;
    const failures = [];
    if (apply) {
      for (const r of results) {
        if (r.outcome === 'missing' || r.outcome === 'no-external-id' || r.outcome === 'unchanged') continue;
        if (!r.changes?.length && !r.state_changed) continue;
        const rr = await fetch(`${url}/rest/v1/rpc/rescan_apply_event`, {
          method: 'POST', headers,
          body: JSON.stringify({
            p_event_id: r.event_id,
            p_event_date: r.source?.event_date ?? null, p_event_time: r.source?.event_time ?? null,
            p_venue: r.source?.venue ?? null, p_state: r.source?.state ?? null,
          }),
        });
        if (rr.ok) { applied++; r.applied = true; }
        else { failures.push({ event_id: r.event_id, fixture: r.fixture, status: rr.status }); }
      }
    }

    const summary = emptySummary();
    for (const r of results) summary[r.outcome] = (summary[r.outcome] || 0) + 1;

    res.status(200).json({
      ok: true, league, from, to,
      checked: stored.length, source_games: live.games.size,
      applied, failures: failures.length ? failures : undefined,
      summary,
      // Only the rows that need a human. Returning 694 "unchanged" entries would bury them.
      results: results.filter(r => r.outcome !== 'unchanged'),
      source_url: live.source_url,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}

const ref = row => ({
  event_id: row.id,
  fixture: `${row.opponent || '?'} at ${row.team || '?'}`,
  stored_date: row.event_date,
});
const emptySummary = () => ({ unchanged: 0, moved: 0, cancelled: 0, 'details-changed': 0, missing: 0, 'no-external-id': 0 });
