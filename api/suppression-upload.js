// Browser-side upload of a do-not-contact list → public.do_not_contact.
//
// WHY A ROUTE AND NOT A DIRECT RPC. The browser holds the anon key, and anon is deliberately
// allowed to READ do_not_contact (there is a select policy) but NOT to execute
// suppress_contacts. That asymmetry is right: the list should be visible to anyone who can open
// the app, while writing to it — which can silence an entire market by suppressing everyone in
// it — goes through a credential. This route holds the service-role key and does the write.
//
// THE SAME CHECK "Send now" USES. requireCaller accepts a signed-in Supabase session on the
// Playbook domain, or Bearer CRON_SECRET server-side. It does NOT accept the published
// REPLY_SECRET, and must not: lib/auth.js exists because that header proved nothing about who
// was calling. An unauthenticated caller reaching this route could mass-suppress the prospect
// base, which is a quiet way to turn off all marketing and would look like a deliverability
// problem for weeks.
//
// BATCHES COME FROM THE BROWSER ALREADY PARSED. The CSVs run to 46MB and 496k rows, far past
// what a serverless request body can carry, so ui/index.html parses the file locally and posts
// slices of it. This route is therefore small on purpose: authenticate, sanity-check the shape,
// hand the batch to suppress_contacts, report exactly what the database said.
//
// NORMALISATION IS THE DATABASE'S JOB, NOT THIS ROUTE'S. suppress_contacts runs the rows
// through norm_phone_e164 and sendable_email — the SAME functions the send path uses. A list
// that normalised differently from the send would fail to match the very people it protects,
// and would do so silently. So nothing here reformats an address or a number.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { requireCaller } from '../lib/auth.js';
import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';

export const config = { maxDuration: 60 };

// One batch, not one file. The browser decides how to slice; this is the ceiling that stops a
// single request being large enough to time out the statement or blow the body limit.
const MAX_ROWS = 5000;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const caller = await requireCaller(req);
  if (!caller) { res.status(401).json({ error: 'Sign in to upload a do-not-contact list.' }); return; }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) { res.status(400).json({ error: 'rows[] is required' }); return; }
  if (!rows.length) { res.status(400).json({ error: 'rows[] is empty' }); return; }
  if (rows.length > MAX_ROWS) {
    res.status(413).json({ error: `too many rows in one batch (${rows.length} > ${MAX_ROWS}) — send it in slices` });
    return;
  }

  // The file name, kept per row by suppress_contacts as the provenance of the entry. Worth
  // having: "why is this person suppressed" is asked months later, and "it came from
  // james-master-marketing-exclude.csv" is most of the answer.
  const source = String(body.source || '').trim().slice(0, 200) || 'browser upload';

  // Only the columns suppress_contacts reads. Anything else a spreadsheet carried is dropped
  // HERE rather than stored: these files are exports full of unrelated personal data, and the
  // one thing worse than an un-enforced suppression list is an un-enforced suppression list
  // that quietly became a copy of someone's CRM.
  const clean = rows.map(r => ({
    email:        r && r.email        ? String(r.email).slice(0, 320)        : null,
    phone:        r && r.phone        ? String(r.phone).slice(0, 40)         : null,
    full_name:    r && r.full_name    ? String(r.full_name).slice(0, 200)    : null,
    organization: r && r.organization ? String(r.organization).slice(0, 200) : null,
    reason:       r && r.reason       ? String(r.reason).slice(0, 500)       : null,
    channel:      r && r.channel      ? String(r.channel).slice(0, 40)       : null,
    source,
  })).filter(r => r.email || r.phone);

  if (!clean.length) {
    // Not an error: a slice of a big file can legitimately be all junk rows. Say so and let the
    // browser carry on with the next one.
    res.status(200).json({ inserted: 0, updated: 0, skipped: rows.length, note: 'no row in this batch had an email or a phone' });
    return;
  }

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }

  try {
    const r = await fetch(`${url}/rest/v1/rpc/suppress_contacts`, {
      method: 'POST',
      headers: supabaseHeaders(key),
      body: JSON.stringify({ p_rows: clean, p_source_file: source }),
    });
    const text = await r.text();
    if (!r.ok) { res.status(502).json({ error: `suppress_contacts failed (HTTP ${r.status})`, detail: text.slice(0, 400) }); return; }
    let j = null; try { j = JSON.parse(text); } catch { /* fall through to zeros */ }
    const out = Array.isArray(j) ? j[0] : j;
    res.status(200).json({
      inserted: Number((out && out.inserted) || 0),
      updated:  Number((out && out.updated)  || 0),
      // Rows the DATABASE rejected, plus the ones dropped above for having no identifier at all.
      skipped:  Number((out && out.skipped)  || 0) + (rows.length - clean.length),
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
