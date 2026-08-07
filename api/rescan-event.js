// Rescan ONE event against the source it came from (Marx, 2026-08-07).
//
// POST { event_id, apply?: boolean }
//
// Two-step by design. The default call only LOOKS and reports; `apply: true` writes. A schedule
// change is not a detail to fix silently — the blast copy has the game date typed into it
// ("early access tickets to the Blue Jays at New York Yankees on Aug 21"), so correcting
// events_master leaves the message still saying the old date while the row goes back to looking
// perfectly healthy. Quieter than the bug it fixes. So the operator sees the change first, and
// the response says how many queued blasts carry the stale wording.
//
// This route NEVER touches campaign_queue. It reports the count and stops. Auto-rejecting is
// specifically wrong: queue_reject feeds the decider's 21-day suppression for that market and
// segment, and a postponed game says nothing bad about the market — it would teach the decider
// to avoid a good market for three weeks over a rain delay.
//
// Auth: same shape as the other routes — Bearer CRON_SECRET / ?token=, unset => open.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.js).

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';
import { fetchGame, diffGame } from '../lib/schedule-source.js';

// The NFL path pulls a ~2MB CSV; MLB and NHL are single small calls.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const secret = process.env.CRON_SECRET;
  const authed = !secret || req.query?.token === secret || req.headers.authorization === `Bearer ${secret}`;
  if (!authed) { res.status(401).json({ error: 'unauthorized' }); return; }

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const headers = supabaseHeaders(key);

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const eventId = String(body.event_id || '').trim();
  const apply = body.apply === true;
  if (!eventId) { res.status(400).json({ error: 'event_id is required' }); return; }

  try {
    const rows = await fetch(
      `${url}/rest/v1/events_master?id=eq.${encodeURIComponent(eventId)}&select=id,league,team,opponent,event_date,event_time,venue,external_id,season,schedule_state,schedule_checked_at`,
      { headers },
    ).then(r => r.ok ? r.json() : null);
    const stored = Array.isArray(rows) ? rows[0] : null;
    if (!stored) { res.status(404).json({ error: 'no event with that id' }); return; }

    const live = await fetchGame(stored);
    const fixture = `${stored.opponent || '?'} at ${stored.team || '?'}`;

    // Nothing was learned — say exactly that. "Could not reach the source" and "the game is
    // gone" must never collapse into one state, which is the whole reason a per-game rescan is
    // safer than a bulk diff.
    if (live.outcome === 'unreachable' || live.outcome === 'unsupported') {
      res.status(200).json({
        ok: true, outcome: live.outcome, applied: false, fixture,
        league: stored.league, detail: live.detail, source_url: live.source_url,
      });
      return;
    }

    // The source answered and does not have this game. Suggestive, not conclusive: ids get
    // reissued and feeds get rebuilt. Reported as its own outcome, never as 'cancelled'.
    if (live.outcome === 'missing') {
      res.status(200).json({
        ok: true, outcome: 'missing', applied: false, fixture, league: stored.league,
        detail: live.detail, source_url: live.source_url,
        stored: { event_date: stored.event_date, event_time: stored.event_time, venue: stored.venue },
      });
      return;
    }

    const changes = live.state === 'cancelled' || live.state === 'postponed'
      ? diffGame(stored, live)                  // still report a date move alongside the state
      : diffGame(stored, live);
    const stateChanged = !!live.state && live.state !== stored.schedule_state;
    const outcome = live.state === 'cancelled' ? 'cancelled'
      : changes.some(c => c.field === 'event_date') ? 'moved'
      : changes.length ? 'details-changed'
      : 'unchanged';

    let applied = null;
    if (apply && (changes.length || stateChanged)) {
      const r = await fetch(`${url}/rest/v1/rpc/rescan_apply_event`, {
        method: 'POST', headers,
        body: JSON.stringify({
          p_event_id: eventId,
          p_event_date: live.event_date, p_event_time: live.event_time,
          p_venue: live.venue, p_state: live.state,
        }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        res.status(502).json({ error: `rescan_apply_event failed (HTTP ${r.status})`, detail: detail.slice(0, 400) });
        return;
      }
      applied = (await r.json().catch(() => null))?.[0] || null;
    }

    res.status(200).json({
      ok: true, outcome, fixture, league: stored.league,
      applied: !!applied,
      // How many live blasts point at this game. When the date moved, this is also the number
      // whose copy now names the wrong day — the count the operator actually needs.
      affected_queue_rows: applied ? applied.affected_queue_rows : undefined,
      changes,
      state: live.state, state_changed: stateChanged,
      stored: { event_date: stored.event_date, event_time: stored.event_time, venue: stored.venue },
      source: { event_date: live.event_date, event_time: live.event_time, venue: live.venue },
      detail: live.detail, source_url: live.source_url,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
