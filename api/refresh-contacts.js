// Rebuild the contact-reach snapshots the Queue and Campaigns count from.
//
// market_contacts is a TABLE, rebuilt from contact_intel/company_intel, and market_counts /
// market_segment_counts are MATERIALIZED VIEWS over it. All three are refreshed by one RPC,
// refresh_market_contacts() (migration 050).
//
// Nothing called it. It existed from the day migration 050 landed and appeared in exactly one
// place in the repo — a mention in MARKET_HISTORY.md — so every reach number in the UI has been
// as old as the last time someone ran it by hand. That is the number an operator decides to
// send on, and since migration 056 it is also what puts the "No audience" badge on a row. A
// stale snapshot means a market that has since gained contacts reads empty, and one that has
// lost them reads full.
//
// This does NOT change what gets sent. api/queue-tick.js resolves recipients through
// market_emails / market_phones, which query live. This route only keeps the displayed
// numbers honest about the same underlying data.
//
// Auth: Bearer CRON_SECRET (Vercel Cron) or ?token=. Unset => open, matching the other crons
// in this directory — see the note in api/schedule-refresh.js.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see lib/supabase.js).

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';

// The rebuild walks every contact and then refreshes two matviews. Well under this in practice,
// but the default 10s would be a coin flip as the contact table grows.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const ok = !secret
    || req.query?.token === secret
    || req.headers.authorization === `Bearer ${secret}`;
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }

  // refresh_market_contacts() is granted to service_role only, which is what lib/supabase.js
  // resolves to on a deployed route.
  const started = Date.now();
  try {
    const r = await fetch(`${url}/rest/v1/rpc/refresh_market_contacts`, {
      method: 'POST', headers: supabaseHeaders(key), body: '{}',
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ error: `refresh_market_contacts failed (HTTP ${r.status})`, detail: detail.slice(0, 500) });
      return;
    }

    // Report the totals back. A silent 200 would look identical whether the rebuild found
    // 40,000 contacts or zero, and "zero" is the failure worth seeing — it would blank every
    // reach number in the UI and mark every row "No audience".
    const counts = await fetch(`${url}/rest/v1/market_counts?select=code,email_count,phone_count`, {
      headers: supabaseHeaders(key),
    }).then(x => x.ok ? x.json() : null).catch(() => null);

    const markets = Array.isArray(counts) ? counts.length : null;
    const emails = Array.isArray(counts) ? counts.reduce((n, c) => n + (Number(c.email_count) || 0), 0) : null;
    const phones = Array.isArray(counts) ? counts.reduce((n, c) => n + (Number(c.phone_count) || 0), 0) : null;

    res.status(200).json({ ok: true, ms: Date.now() - started, markets, emails, phones });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
