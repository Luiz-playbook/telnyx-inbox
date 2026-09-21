// Recount the state/segment reach grid on demand — the "Refresh counts" button in Offers.
//
// This is the SMALL refresh. There are two, and confusing them is expensive:
//
//   /api/refresh-contacts  -> refresh_market_contacts()       ~28-66s. Rebuilds the whole
//                             90,000-row market_contacts table from contact_intel, then every
//                             matview over it. A scheduled job, not something to sit and wait for.
//   /api/refresh-counts    -> refresh_state_segment_summary()  ~1s. Recounts the 192-cell
//                             companies/emails/phones grid from whatever is in the tables now.
//
// Migration 087 cached that grid because rebuilding it was costing ~12 seconds per Offers load
// (see the header there for the measurements). Caching it means the numbers are a snapshot, so
// this route exists to let an operator take a fresh one straight after an import instead of
// waiting for the nightly job.
//
// The refresh runs CONCURRENTLY, so pressing the button does not lock the matview and stall
// anyone else's page load while it runs.
//
// Auth: a signed-in @callplaybook.com user, via lib/auth.js. NOT the CRON_SECRET pattern the
// other routes in this directory use — that one falls open when CRON_SECRET is unset, which it
// currently is, and this is reachable from a browser by anyone who loads the page.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.js).

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';

// ~1s in practice. The ceiling is for the case where it lands behind one of the long-running
// pipelines that share this database — the org-enrichment batches run 12-23s.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!(await gate(req, res))) return;

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }

  // refresh_state_segment_summary() is granted to service_role only — migration 087 revokes it
  // from anon precisely so that it cannot be triggered with the published anon key.
  const started = Date.now();
  try {
    const r = await fetch(`${url}/rest/v1/rpc/refresh_state_segment_summary`, {
      method: 'POST', headers: supabaseHeaders(key), body: '{}',
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ error: `refresh failed (HTTP ${r.status})`, detail: detail.slice(0, 500) });
      return;
    }

    // The RPC returns the new timestamp, so the button can update its "as of" label from this
    // response rather than making a second round trip to counts_refreshed_at().
    const refreshed_at = await r.json().catch(() => null);

    // Totals back with the response for the same reason api/refresh-contacts.js reports them:
    // a bare 200 looks identical whether the grid came back with 51,000 companies or zero, and
    // zero is the failure worth seeing — it would blank every reach number in the UI.
    const grid = await fetch(
      `${url}/rest/v1/state_segment_summary_mv?select=companies,emails,phones`,
      { headers: supabaseHeaders(key) },
    ).then(x => x.ok ? x.json() : null).catch(() => null);

    const sum = (k) => Array.isArray(grid) ? grid.reduce((n, g) => n + (Number(g[k]) || 0), 0) : null;

    res.status(200).json({
      ok: true,
      refreshed_at,
      cells: Array.isArray(grid) ? grid.length : null,
      companies: sum('companies'),
      emails: sum('emails'),
      phones: sum('phones'),
      ms: Date.now() - started,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
