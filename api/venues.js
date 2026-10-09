// Venues: add, edit and delete the youth-event venue list from the Catalog tab (AI-1086).
//
// SAME SPLIT AS api/markets.js, for the same reason. Migration 114 grants the anon key `select`
// and nothing else; the anon key is published to every visitor in config.js. So reads happen
// straight from the page against youth_event_venues_with_market, and writes come through here
// with the service-role key, authenticated against a Playbook account.
//
// THREE THINGS THIS ROUTE WILL NOT LET A CALLER DO, each because the table would accept it:
//
//   1. SET `sports`. It is derived from venue_type by Josh's rule and recomputed on every write
//      (lib/youth-venues.js). A form that could post its own array could produce a basketball
//      venue hosting softball, and nothing downstream would notice — the seasonal cron filters
//      on this column, so a wrong value invites the wrong programme to the wrong building.
//   2. CLEAR `edited_by_hand`. The route sets it on every write. A caller that could clear it
//      could hand its own correction back to the loader to be overwritten, which is the exact
//      failure migration 116 exists to prevent.
//   3. CHANGE THE MARKET. A venue's market is its state's market — that is the whole finding of
//      migration 115 — so there is no market field to set. Picking the state picks the market.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (for token checks).

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';
import { cleanVenue } from '../lib/youth-venues.js';

export const config = { maxDuration: 15 };

const TABLE = 'youth_event_venues';

async function pg(path, init) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...supabaseHeaders(supabaseKey()), ...(init && init.headers) },
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.message || j.hint || msg; } catch {}
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  if (!(await gate(req, res))) return;
  if (!process.env.SUPABASE_URL || !supabaseKey()) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const id = String((req.query && req.query.id) || body.id || '').trim();

  try {
    if (req.method === 'GET') {
      // The joined view, so a caller sees the market alongside the venue without knowing how
      // the two tables relate.
      const rows = await pg('youth_event_venues_with_market?select=*&order=state_code.asc,venue_city.asc');
      return res.status(200).json({ rows });
    }

    if (req.method === 'POST') {
      const { row, error } = cleanVenue(body, { partial: false });
      if (error) return res.status(400).json({ error });
      row.edited_by_hand = true;
      const made = await pg(TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      return res.status(200).json({ row: (made || [])[0] || null });
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'id is required' });
      const { row, error } = cleanVenue(body, { partial: true });
      if (error) return res.status(400).json({ error });
      if (!Object.keys(row).length) return res.status(400).json({ error: 'nothing to update' });
      row.edited_by_hand = true;
      const got = await pg(`${TABLE}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      // PostgREST answers 200 with [] when the filter matched nothing, which is not success.
      if (!got || !got.length) return res.status(404).json({ error: `no venue with id ${id}` });
      return res.status(200).json({ row: got[0] });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id is required' });
      const gone = await pg(`${TABLE}?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      if (!gone || !gone.length) return res.status(404).json({ error: `no venue with id ${id}` });
      // Worth saying plainly in the response: the loader's CSV still holds this venue, so a
      // delete here is undone by the next load unless the row is removed there too.
      return res.status(200).json({
        deleted: gone[0].venue,
        note: 'Removed from the table. data/greenfield-venues.csv still lists it, so a loader run would bring it back.',
      });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: `method ${req.method} not allowed` });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // unique (org, venue). The one error a person hits by accident rather than by typo, so it
    // gets a sentence that says what to do instead of naming the constraint.
    if (/duplicate key|already exists/i.test(msg)) {
      return res.status(409).json({
        error: 'That organisation already has a venue with this name — edit that row instead',
      });
    }
    return res.status(e && e.status === 404 ? 404 : 400).json({ error: msg });
  }
}
