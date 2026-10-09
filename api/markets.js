// Markets: read and EDIT public.market_season_calendar from the Catalog tab (AI-1086).
//
// WHY THIS ROUTE EXISTS AT ALL, GIVEN THE TABLE IS READABLE WITH THE ANON KEY. Migration 114
// grants `select` to anon and `all` to service_role only, and that split is deliberate: the
// date columns are what the seasonal cron (AI-1076) schedules real sends against. A table the
// browser can write directly is a table any visitor with the published anon key can write, and
// the blast dates for eighteen states are not that. So reads stay direct from the page and
// writes come through here, where the service-role key never leaves the server and every call
// is authenticated against a Playbook account.
//
// WHY THE DATES ARE VALIDATED AND NOT JUST FORWARDED. 108 ships those six date columns NULL on
// purpose — the comment on the table says a guess is worse than a blank, because someone will
// schedule against it. The form is the thing that fills them in, so it is also the last place
// that can refuse a date nobody checked. Two rules follow from that, both below: a date must be
// a real calendar date in a sane year, and school_last_day cannot precede school_first_day.
// Postgres would accept "2026-02-30" as a date error but is perfectly happy with a school year
// that ends before it starts.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (for token checks).

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';

export const config = { maxDuration: 15 };

const TABLE = 'market_season_calendar';

// The columns a person may set. state_code is handled separately because it is the primary key:
// settable on create, and on update it is the thing being matched rather than changed.
const DATE_COLS = ['school_first_day', 'school_last_day', 'fall_sports_start',
  'winter_sports_start', 'spring_sports_start', 'summer_sports_start'];
const TEXT_COLS = ['state_name', 'market_city', 'school_district', 'athletics_body',
  'source_url', 'notes'];

const trim = v => (v == null ? null : String(v).trim());
// '' and null both mean "not known", and they must mean the same thing in the database or the
// same blank renders two ways and filters two ways.
const blankToNull = v => { const s = trim(v); return s === '' ? null : s; };

// A date is accepted only as YYYY-MM-DD that round-trips. `new Date('2026-02-30')` rolls over
// to March 2nd rather than failing, so the check is that the parsed date prints back unchanged.
function cleanDate(v, label) {
  const s = blankToNull(v);
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label} must be a date like 2026-08-19`);
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`${label} is not a real date (${s})`);
  }
  const y = d.getUTCFullYear();
  // A typo'd year is the realistic failure here — "2206" sorts and compares fine and would sit
  // in the table looking plausible until a send never fired.
  if (y < 2020 || y > 2040) throw new Error(`${label} year looks wrong (${y})`);
  return s;
}

function cleanBody(body, { creating }) {
  const out = {};
  const code = trim(body.state_code);
  if (creating) {
    if (!code) throw new Error('state_code is required');
    if (!/^[A-Za-z]{2}$/.test(code)) throw new Error('state_code must be two letters, like TN');
    out.state_code = code.toUpperCase();
  }
  for (const c of TEXT_COLS) if (c in body) out[c] = blankToNull(body[c]);
  for (const c of DATE_COLS) if (c in body) out[c] = cleanDate(body[c], c.replace(/_/g, ' '));

  // not null in the table, so an empty string here is a 400 from PostgREST with a message that
  // names a constraint instead of a field.
  for (const c of ['state_name', 'market_city']) {
    if (creating && !out[c]) throw new Error(`${c.replace(/_/g, ' ')} is required`);
    if (!creating && c in out && !out[c]) throw new Error(`${c.replace(/_/g, ' ')} cannot be emptied`);
  }

  // Only meaningful when BOTH are being set in the same call, or one is set and the other is
  // already known — the caller sends the full row, so comparing what arrived is enough.
  if (out.school_first_day && out.school_last_day && out.school_last_day < out.school_first_day) {
    throw new Error('school last day is before school first day');
  }

  // The checkbox, not a free-text timestamp. Filling in dates and recording that nobody checked
  // them is the state this table already ships in; the point of the flag is to change that.
  if ('verified' in body) out.verified_at = body.verified ? new Date().toISOString() : null;
  return out;
}

// PostgREST wraps a constraint failure in its own envelope; `message` is the part a person can
// act on and `details`/`hint` usually name the column.
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
  const code = String((req.query && req.query.state_code) || body.state_code || '').trim().toUpperCase();

  try {
    if (req.method === 'GET') {
      const rows = await pg(`${TABLE}?select=*&order=state_code.asc`);
      return res.status(200).json({ rows });
    }

    if (req.method === 'POST') {
      const row = cleanBody(body, { creating: true });
      const made = await pg(TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      return res.status(200).json({ row: (made || [])[0] || null });
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      if (!code) return res.status(400).json({ error: 'state_code is required' });
      const row = cleanBody(body, { creating: false });
      if (!Object.keys(row).length) return res.status(400).json({ error: 'nothing to update' });
      const got = await pg(`${TABLE}?state_code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      // PostgREST answers 200 with [] when the filter matched nothing, which is not success.
      if (!got || !got.length) return res.status(404).json({ error: `no market with state_code ${code}` });
      return res.status(200).json({ row: got[0] });
    }

    if (req.method === 'DELETE') {
      if (!code) return res.status(400).json({ error: 'state_code is required' });
      const gone = await pg(`${TABLE}?state_code=eq.${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      if (!gone || !gone.length) return res.status(404).json({ error: `no market with state_code ${code}` });
      return res.status(200).json({ deleted: gone[0].state_code });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: `method ${req.method} not allowed` });
  } catch (e) {
    // A duplicate primary key is the one error a person hits by accident rather than by typo,
    // so it gets a sentence that says what to do instead of "duplicate key value violates...".
    const msg = String((e && e.message) || e);
    if (/duplicate key|already exists/i.test(msg)) {
      return res.status(409).json({ error: `${code} is already in the list — edit that row instead` });
    }
    return res.status(e && e.status === 404 ? 404 : 400).json({ error: msg });
  }
}
