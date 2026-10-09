// Rebuild public.contact_directory — the one-row-per-person merge behind the Contacts tab.
//
// WHY IT NEEDS A CRON AT ALL. contact_directory (migration 091) is a materialized view over
// three sources that each change on their own schedule: hubspot.hubspot_contacts every 6 hours
// from n8n, public.contact_intel whenever the scrape runs, and ticketblaster.imported_contacts
// the moment someone uploads a list. Until it is refreshed the tab is simply out of date — a
// contact added to HubSpot this morning is not in it, and the overlap figures the tab exists to
// report are yesterday's.
//
// This is the exact failure migration 062 warned about and AI-970 lived: a mirror that quietly
// stops being refreshed looks identical to a mirror with nothing new in it. Two defences, and
// neither is optional — contact_directory_state records every rebuild, and the tab PRINTS that
// timestamp beside the counts, so a cron that has stopped is visible on the screen rather than
// inferred weeks later.
//
// WHY NOT INSIDE api/refresh-contacts.js, which rebuilds the other snapshot over the same data.
// Measured against production on 2026-10-06, that route takes ~85 seconds on its own — already
// past its 60s maxDuration — and this rebuild adds ~17s. Combined they would time out and lose
// both rebuilds rather than one. Separate routes fail independently.
//
// IT RUNS AFTER THE OTHER TWO, DELIBERATELY. 14:00 UTC sits after the HubSpot contact sync and
// after refresh-contacts at 13:30, so the merge reads the freshest version of each source. Run
// before them and every rebuild would be one cycle behind for no extra cost.
//
// Auth: Bearer CRON_SECRET (Vercel Cron) or ?token=. Unset => open, matching the other crons in
// this directory — see the note in api/schedule-refresh.js. Note this is the REBUILD, not the
// data: it returns a row count and nothing about any person, so an open rebuild leaks nothing.
// Reading the directory is a different route (api/contacts.js) and is always authenticated.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.js).

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';

// The merge walks ~350,000 rows across three schemas and took 16.9s against production. 60s
// leaves room for it to grow; the default 10s would fail it every single time.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const ok = !secret
    || req.query?.token === secret
    || req.headers.authorization === `Bearer ${secret}`;
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }

  const started = Date.now();
  try {
    const r = await fetch(`${url}/rest/v1/rpc/refresh_contact_directory`, {
      method: 'POST', headers: supabaseHeaders(key), body: '{}',
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ error: `refresh_contact_directory failed (HTTP ${r.status})`, detail: detail.slice(0, 500) });
      return;
    }
    const j = await r.json().catch(() => null);
    const row = Array.isArray(j) ? j[0] : j;

    // The row count is reported rather than a bare 200 for the same reason refresh-contacts
    // reports its totals: a silent success looks identical whether the merge found 256,000
    // people or zero, and zero is the failure worth seeing — it would empty the tab.
    res.status(200).json({
      ok: true,
      rows: Number((row && row.row_count) || 0),
      rebuild_ms: Number((row && row.ms) || 0),
      ms: Date.now() - started,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
