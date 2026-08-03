// AI-830: monthly schedule-refresh cron (MLB). Pulls newly released games into
// events_master (idempotent) and records a change-log row. On-demand multi-league
// refreshes use scripts/load-schedule.js; this cron keeps MLB current unattended.
//
// Auth: Bearer CRON_SECRET (Vercel Cron) or x-inbox-secret: REPLY_SECRET (UI).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.js), optional CRON_SECRET/REPLY_SECRET.

import { supabaseKey } from '../lib/supabase.js';

export const config = { maxDuration: 60 };

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r.json();
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export default async function handler(req, res) {
  // dedicated price/schedule cron secret, isolated from the shared CRON_SECRET (see
  // price-refresh.js). Accepted via ?token= or Bearer; unset => open.
  const priceSecret = process.env.PRICE_CRON_SECRET;
  const tokenOk = priceSecret && (req.query?.token === priceSecret || req.headers.authorization === `Bearer ${priceSecret}`);
  if (priceSecret && !tokenOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const supaUrl = process.env.SUPABASE_URL, supaKey = supabaseKey();
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };
  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  const YEAR = Number(req.query?.year) || new Date().getUTCFullYear();
  const START = new Date().toISOString().slice(0, 10);
  const END = `${YEAR}-12-31`;
  const SEASON = `${YEAR}-mlb`;

  try {
    const teams = new Map();
    for (const t of (await getJson(`https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${YEAR}`)).teams || [])
      teams.set(t.id, { nick: (t.teamName || t.name || '').toLowerCase().trim(), full: t.name });
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${START}&endDate=${END}`;
    const sched = await getJson(url);
    const rows = [];
    for (const day of sched.dates || []) for (const g of day.games || []) {
      const home = teams.get(g.teams?.home?.team?.id) || {}, away = teams.get(g.teams?.away?.team?.id) || {};
      rows.push({
        league: 'mlb', team: home.nick || (g.teams?.home?.team?.name || '').toLowerCase(), team_full: home.full,
        opponent: away.nick || g.teams?.away?.team?.name, event_date: day.date,
        event_time: g.gameDate ? g.gameDate.slice(11, 19) : null, venue: g.venue?.name || null,
        home_away: 'home', external_id: String(g.gamePk), source_url: url,
        source_note: 'MLB StatsAPI; event_time UTC', season: SEASON,
      });
    }
    if (dry) { res.status(200).json({ ok: true, dry: true, fetched: rows.length }); return; }

    const addedIds = [];
    let fetched = 0;
    for (const batch of chunk(rows, 200)) {
      const out = await fetch(`${supaUrl}/rest/v1/rpc/upsert_events_master`, { method: 'POST', headers: sh, body: JSON.stringify({ p_rows: batch }) }).then(r => r.json());
      for (const r of (out || [])) { fetched++; if (r.out_inserted && r.out_id) addedIds.push(r.out_id); }
    }
    const runId = await fetch(`${supaUrl}/rest/v1/rpc/record_schedule_run`, { method: 'POST', headers: sh,
      body: JSON.stringify({ p: { league: 'mlb', season: SEASON, source_url: url, fetched, added: addedIds.length, added_ids: addedIds } }) }).then(r => r.json());

    res.status(200).json({ ok: true, league: 'mlb', season: SEASON, fetched, added: addedIds.length, run_id: runId });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
