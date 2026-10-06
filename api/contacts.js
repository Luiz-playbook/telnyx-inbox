// The Contacts tab: browse every contact we hold, open one in full, and upload more.
//
// WHY A ROUTE AND NOT DIRECT TABLE READS. Nothing the browser holds can read any of the three
// contact sources:
//   * public.contact_intel      — RLS on with ZERO policies, so the anon key gets an empty
//                                 array rather than an error. That is exactly how Market
//                                 History sat three months stale under AI-970 while looking
//                                 merely empty, and it is the failure this route exists to
//                                 avoid repeating.
//   * hubspot.hubspot_contacts  — the schema is deliberately not exposed to PostgREST (062).
//   * ticketblaster.imported_contacts — likewise (090).
// Exposing two private schemas to PostgREST to serve one tab would widen the blast radius of
// every future RLS mistake across both. So the reads happen here, through security-definer
// functions, with the service-role key that never reaches the page. Same shape and the same
// reasoning as api/market-history.js, over the same tables.
//
// EVERY ACTION IS AUTHENTICATED, INCLUDING THE READS. requireCaller accepts a signed-in Supabase
// session on the Playbook domain, or Bearer CRON_SECRET server-side. It does NOT accept the
// published REPLY_SECRET, and must not: lib/auth.js exists because that header proved nothing
// about who was calling. These rows are the names, addresses and phone numbers of a quarter of
// a million real people — this is the one route in the directory where an unauthenticated GET
// would be a data breach rather than an inconvenience.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (for token checks),
//      GOOGLE_SERVICE_ACCOUNT_KEY (optional — only for private Sheets imports),
//      N8N_HUBSPOT_CONTACTS_SYNC_URL (optional — defaults to the deployed webhook).

import crypto from 'node:crypto';
import { requireCaller } from '../lib/auth.js';
import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';

// The directory rebuild is a 350k-row merge across three schemas and measured 21.7s on
// production data. The default 10s would fail it every time, and fail it in the most confusing
// way: a timeout on a statement that had in fact started and would finish.
export const config = { maxDuration: 60 };

// One batch, not one file. The browser parses locally and slices; this is the ceiling that
// stops a single request being large enough to time out the statement or blow the body limit.
const MAX_IMPORT_ROWS = 2000;

// Counts above this come back from contacts_browse as 10001 meaning "more than 10,000". See the
// migration: an exact count on a one-letter search term would scan the whole directory on every
// keystroke. Kept in step with c_cap in migration 092.
const COUNT_CAP = 10000;

const N8N_CONTACTS_SYNC = (process.env.N8N_HUBSPOT_CONTACTS_SYNC_URL || '').trim()
  || 'https://playbooksports.app.n8n.cloud/webhook/hubspot-contacts-sync';

const rpc = (url, key) => async (fn, body) => {
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: supabaseHeaders(key), body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  if (!r.ok) {
    // UNWRAP PostgREST'S ENVELOPE. A `raise exception` in a function comes back as
    // {"code":"P0001","message":"a contact needs a usable email address or phone number"} — and
    // those messages are written to be read by the person who hit the problem. Reporting
    // "update_imported_contact failed (HTTP 400)" instead throws away the only useful part and
    // leaves them with an error that names a function they have never heard of.
    let inner = null;
    try { inner = JSON.parse(text); } catch { /* not JSON — fall back to the generic message */ }
    const msg = inner && typeof inner.message === 'string' && inner.message.trim()
      ? inner.message
      : `${fn} failed (HTTP ${r.status})`;
    const e = new Error(msg);
    e.detail = inner && inner.message ? undefined : text.slice(0, 500);
    e.status = r.status;
    // A P0001 is a rule this code chose to enforce, i.e. the caller's input is wrong — 400, not
    // a 502 blaming the database for doing what it was told.
    if (inner && inner.code === 'P0001') e.status = 400;
    throw e;
  }
  try { return JSON.parse(text); } catch { return null; }
};

// ---------------------------------------------------------------------------------------------
// GOOGLE SHEETS
//
// TWO PATHS, BECAUSE THERE ARE TWO WAYS A SHEET CAN BE SHARED and they need different
// credentials:
//   1. "Anyone with the link" — the CSV export endpoint serves it with no auth at all.
//   2. Shared with the service account — needs an OAuth token minted from the key.
// The route tries the private path first when a key is configured, because a sheet shared with
// the service account is ALSO often link-restricted, and falling back the other way round would
// report "make it public" for a sheet that was already shared correctly.
//
// SIGNED WITH node:crypto, NO DEPENDENCY. This project has no package.json and no node_modules
// by design; adding googleapis for one JWT would be the largest dependency in the repo. RS256
// over two base64url segments is a dozen lines and is what the library would do.

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function googleKey() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw) return null;
  // Accepts the key as raw JSON or base64-wrapped: both are common ways to get a multi-line
  // private key through a dashboard env field without it being mangled.
  let txt = raw;
  if (!txt.startsWith('{')) {
    try { txt = Buffer.from(raw, 'base64').toString('utf8'); } catch { return null; }
  }
  try {
    const j = JSON.parse(txt);
    if (!j.client_email || !j.private_key) return null;
    // A key pasted through a shell or a .env often arrives with literal backslash-n instead of
    // real newlines, which makes crypto reject it as malformed PEM for no visible reason.
    return { email: j.client_email, privateKey: String(j.private_key).replace(/\\n/g, '\n') };
  } catch { return null; }
}

async function googleToken(scope) {
  const k = googleKey();
  if (!k) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: k.email, scope, aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signed = `${header}.${claims}`;
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(signed), k.privateKey));

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signed}.${sig}`,
    }),
  });
  if (!r.ok) {
    const d = await r.text().catch(() => '');
    throw new Error(`Google rejected the service-account key: ${d.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.access_token || null;
}

// Accepts a full URL or a bare id. The gid is kept when present so a link to the second tab
// imports the second tab — pasting a tab link and silently getting sheet one is the kind of
// wrong that is only noticed after the send.
function parseSheetUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const id = (s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [])[1]
    || (/^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : null);
  if (!id) return null;
  const gid = (s.match(/[#&?]gid=([0-9]+)/) || [])[1] || null;
  return { id, gid };
}

async function fetchSheetRows(input, wantGid) {
  const ref = parseSheetUrl(input);
  if (!ref) {
    throw Object.assign(new Error('That does not look like a Google Sheets link.'), { hint: 'url' });
  }
  // An explicitly chosen tab beats whatever the URL carried: the picker below exists precisely
  // for the case where the URL named no tab, or named the wrong one.
  const gid = (wantGid != null && wantGid !== '') ? String(wantGid) : ref.gid;

  // --- private path: service account ---------------------------------------------------------
  const haveKey = !!googleKey();
  if (haveKey) {
    try {
      const token = await googleToken('https://www.googleapis.com/auth/spreadsheets.readonly');
      if (token) {
        // THE TAB LIST IS READ FIRST, ALWAYS, and it earns the extra call twice over:
        //   * the values API addresses sheets by NAME while a link identifies them by gid, so a
        //     gid has to be resolved to a title or the read silently returns sheet one;
        //   * when the link names no tab and the file has several, guessing the first one is how
        //     an import quietly loads "Sheet1 (old)" instead of the list someone meant. With the
        //     titles in hand the caller can be asked.
        const meta = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${ref.id}?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))`,
          { headers: { Authorization: `Bearer ${token}` } });

        if (meta.ok) {
          const mj = await meta.json();
          const sheets = (mj.sheets || []).map(s => ({
            gid:   String(s.properties?.sheetId ?? ''),
            title: String(s.properties?.title ?? ''),
            rows:  Number(s.properties?.gridProperties?.rowCount ?? 0),
          })).filter(s => s.gid !== '');

          // No tab chosen and more than one to choose from: hand back the list instead of
          // picking. The browser renders it and asks again with a gid.
          if (!gid && sheets.length > 1) {
            return { needsTab: true, sheets, via: 'service_account' };
          }

          const chosen = gid
            ? sheets.find(s => s.gid === String(gid))
            : sheets[0];

          // A gid that is not in this file is almost always a link pasted from a different
          // spreadsheet, which is worth saying rather than silently reading sheet one.
          if (gid && !chosen) {
            throw Object.assign(new Error(
              `That link points at a tab this sheet does not have. Pick one: ${sheets.map(s => s.title).join(', ')}.`
            ), { hint: 'tab' });
          }

          const range = chosen?.title
            ? `'${String(chosen.title).replace(/'/g, "''")}'!A1:Z5000`
            : 'A1:Z5000';

          const r = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${ref.id}/values/${encodeURIComponent(range)}`,
            { headers: { Authorization: `Bearer ${token}` } });
          if (r.ok) {
            const j = await r.json();
            return { table: j.values || [], via: 'service_account', tab: chosen?.title || null, sheets };
          }
          if (r.status === 403 || r.status === 404) {
            const k = googleKey();
            throw Object.assign(new Error(
              `The service account cannot open that sheet. Share it with ${k.email} (Viewer is enough), or set the sheet to "Anyone with the link".`
            ), { hint: 'share' });
          }
        }

        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${ref.id}/values/${encodeURIComponent('A1:Z5000')}`,
          { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) {
          const j = await r.json();
          return { table: j.values || [], via: 'service_account' };
        }
        if (r.status === 403 || r.status === 404) {
          // The actionable error, with the address to share WITH. "403 Forbidden" sends someone
          // to the wrong place; the fix is one click in the Share dialog.
          const k = googleKey();
          throw Object.assign(new Error(
            `The service account cannot open that sheet. Share it with ${k.email} (Viewer is enough), or set the sheet to "Anyone with the link".`
          ), { hint: 'share' });
        }
      }
    } catch (e) {
      if (e.hint) throw e;             // already a clear message — do not bury it in a fallback
      // Any other failure falls through to the public path: a sheet that is genuinely public
      // should still import when the key is misconfigured.
    }
  }

  // --- public path: CSV export ---------------------------------------------------------------
  //
  // NO TAB PICKER HERE, AND IT IS NOT AN OVERSIGHT: the CSV export endpoint serves one sheet and
  // offers no way to list the others, so without the service account there is nothing to choose
  // from. A gid in the URL is still honoured; without one this is the first tab, which is what
  // Google itself does.
  const csvUrl = `https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv`
    + (gid ? `&gid=${gid}` : '');
  const r = await fetch(csvUrl, { redirect: 'follow' });
  const body = await r.text().catch(() => '');
  // Google answers a private sheet with a 200 and an HTML sign-in page, not a 403. Without this
  // check the importer would parse that page as a spreadsheet and report "no usable rows",
  // which points at the file format instead of at the sharing setting.
  const looksHtml = /^\s*<(!doctype|html)/i.test(body);
  if (!r.ok || looksHtml) {
    throw Object.assign(new Error(
      haveKey
        ? `That sheet is not shared with the service account and is not public. Share it with ${googleKey().email}, or set it to "Anyone with the link".`
        : 'That sheet is not public. Set it to "Anyone with the link" — or ask for the service-account address to be configured so private sheets work.'
    ), { hint: 'share' });
  }
  return { table: parseCsv(body), via: 'public_csv' };
}

// RFC4180-ish, and the SAME parser as the browser's and scripts/import-suppression.js's. Three
// importers that disagree about quoting is the kind of difference nobody notices until a list
// imports empty. If one changes, change all three.
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQuotes = false;
  const s = String(text).replace(/^﻿/, '');   // Excel's BOM, or "email" never matches
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// ---------------------------------------------------------------------------------------------

export default async function handler(req, res) {
  const caller = await requireCaller(req);
  if (!caller) { res.status(401).json({ error: 'Sign in with a Playbook account to view contacts.' }); return; }

  const url = process.env.SUPABASE_URL, key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const call = rpc(url, key);

  try {
    if (req.method === 'GET')  { await handleGet(req, res, call); return; }
    if (req.method === 'POST') { await handlePost(req, res, call, caller); return; }
    res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    const status = e.hint ? 400 : (e.status && e.status >= 400 && e.status < 500 ? e.status : 502);
    res.status(status).json({ error: String(e.message || e), detail: e.detail || undefined, hint: e.hint || undefined });
  }
}

async function handleGet(req, res, call) {
  const q = req.query || {};

  // ?stats=1 — the headline numbers, including the overlap figures the tab is really for.
  if (q.stats) {
    res.status(200).json({ ok: true, stats: await call('contacts_stats') });
    return;
  }

  // ?states=1 — the options for the state filter, counted, busiest first.
  if (q.states) {
    res.status(200).json({ ok: true, states: (await call('contacts_states')) || [] });
    return;
  }

  // ?detail=<identity_key> — one person, from every source, unmerged.
  if (q.detail) {
    const d = await call('contact_detail', { p_identity_key: String(q.detail) });
    if (!d || d.found === false) { res.status(404).json({ error: 'That contact is no longer in the directory.' }); return; }
    res.status(200).json({ ok: true, detail: d });
    return;
  }

  // Default: one page of the list.
  const PAGE = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const page = Math.max(Number(q.page) || 0, 0);
  const rows = await call('contacts_browse', {
    p_source:   String(q.source || 'all'),
    p_q:        q.q ? String(q.q) : null,
    p_state:    q.state ? String(q.state) : null,
    p_presence: q.presence ? String(q.presence) : null,
    p_limit:    PAGE,
    p_offset:   page * PAGE,
  });

  // total rides on every row (one window count, one scan). An empty page carries no total, and
  // 0 is the truthful answer there rather than null.
  const raw = Array.isArray(rows) && rows.length ? Number(rows[0].total) : 0;
  res.status(200).json({
    ok: true,
    rows: Array.isArray(rows) ? rows.map(({ total, ...r }) => r) : [],
    total: Math.min(raw, COUNT_CAP),
    // So the UI can render "10,000+" rather than presenting a capped figure as exact.
    total_capped: raw > COUNT_CAP,
    page, limit: PAGE,
  });
}

async function handlePost(req, res, call, caller) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || '').trim();

  // --- import a parsed batch ------------------------------------------------------------------
  if (action === 'import') {
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows)        { res.status(400).json({ error: 'rows[] is required' }); return; }
    if (!rows.length) { res.status(400).json({ error: 'rows[] is empty' }); return; }
    if (rows.length > MAX_IMPORT_ROWS) {
      res.status(413).json({ error: `too many rows in one batch (${rows.length} > ${MAX_IMPORT_ROWS}) — send it in slices` });
      return;
    }

    // Only the four columns the format defines. Anything else the spreadsheet carried is dropped
    // HERE rather than stored: these files are exports full of unrelated personal data, and a
    // contact table that quietly became a copy of someone's CRM is a liability nobody chose.
    const clean = rows.map(r => ({
      first_name: r && r.first_name ? String(r.first_name).slice(0, 120) : null,
      last_name:  r && r.last_name  ? String(r.last_name).slice(0, 120)  : null,
      email:      r && r.email      ? String(r.email).slice(0, 320)      : null,
      phone:      r && r.phone      ? String(r.phone).slice(0, 40)       : null,
      // Passed through raw. The database resolves it to a market code through state_alias and
      // then geo_region (migration 100) -- the browser must not decide what "Ontario" means, or
      // an upload would map to markets differently from the way the send path does.
      state:      r && r.state      ? String(r.state).slice(0, 80)       : null,
    })).filter(r => r.email || r.phone);

    if (!clean.length) {
      // Not an error: a slice of a big file can legitimately be all junk rows. Say so and let the
      // browser carry on with the next one.
      res.status(200).json({ inserted: 0, updated: 0, skipped: rows.length, note: 'no row in this batch had an email or a phone' });
      return;
    }

    const out = await call('import_contacts', {
      p_rows:        clean,
      p_source_file: String(body.source_file || '').slice(0, 200) || 'browser upload',
      p_source_kind: String(body.source_kind || '').slice(0, 40)  || null,
      p_imported_by: caller.email || 'cron',
    });
    const o = Array.isArray(out) ? out[0] : out;
    res.status(200).json({
      inserted: Number((o && o.inserted) || 0),
      updated:  Number((o && o.updated)  || 0),
      skipped:  Number((o && o.skipped)  || 0) + (rows.length - clean.length),
    });
    return;
  }

  // --- read a Google Sheet, return rows for the browser to confirm then import ----------------
  //
  // READ HERE, IMPORTED BY THE BROWSER. The sheet is fetched server-side (the credential lives
  // here) but handed back as a table rather than imported in one go, so the upload goes through
  // the SAME preview-and-confirm the file dropzone uses. A URL that silently imported 5,000 rows
  // on paste would be the one upload path with no chance to notice it was the wrong sheet.
  if (action === 'sheet') {
    const out = await fetchSheetRows(body.url, body.gid);

    // The file has several tabs and the link named none. Nothing is read yet; the browser shows
    // the list and asks again with a gid.
    if (out.needsTab) {
      res.status(200).json({ ok: true, needsTab: true, sheets: out.sheets, via: out.via });
      return;
    }

    const table = out.table || [];
    if (!table.length) {
      res.status(400).json({
        error: out.tab ? `The tab "${out.tab}" is empty.` : 'That sheet is empty.',
        hint: 'empty', sheets: out.sheets,
      });
      return;
    }
    res.status(200).json({
      ok: true, table: table.slice(0, 5001), via: out.via,
      tab: out.tab || null, sheets: out.sheets || null,
      truncated: table.length > 5001,
    });
    return;
  }

  // --- edit / delete an UPLOADED contact -------------------------------------------------------
  //
  // Uploaded rows only. contact_intel is rebuilt by a scrape and hubspot_contacts is a mirror, so
  // an edit to either would be overwritten by the next sync — the button would appear to work and
  // then silently undo itself, which is worse than not having it. A correction to a HubSpot
  // contact belongs in HubSpot. See migration 094.
  if (action === 'update-imported' || action === 'delete-imported') {
    const id = String(body.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: 'a contact id is required' }); return; }

    const out = action === 'delete-imported'
      ? await call('delete_imported_contact', { p_id: id })
      : await call('update_imported_contact', {
          p_id:         id,
          p_first_name: body.first_name ? String(body.first_name).slice(0, 120) : null,
          p_last_name:  body.last_name  ? String(body.last_name).slice(0, 120)  : null,
          p_email:      body.email      ? String(body.email).slice(0, 320)      : null,
          p_phone:      body.phone      ? String(body.phone).slice(0, 40)       : null,
        });

    // THE DIRECTORY IS A SNAPSHOT, so an edit is invisible in the list until it is re-merged.
    // Doing it here rather than asking means the row the person just changed agrees with what
    // they changed it to. ~15s, and it is why this route carries maxDuration 60.
    let directory = null;
    try {
      const d = await call('refresh_contact_directory');
      const row = Array.isArray(d) ? d[0] : d;
      directory = { rows: Number((row && row.row_count) || 0) };
    } catch (e) {
      // Not fatal: the write is already committed. The tab shows its rebuild time, and the
      // Rebuild button is right there.
      directory = { error: String((e && e.message) || e) };
    }

    res.status(200).json({ ok: true, contact: out, directory });
    return;
  }

  // --- manual syncs ---------------------------------------------------------------------------
  //
  // TWO BUTTONS THAT DO DIFFERENT THINGS, and the labels have to keep them apart. There is NO
  // sync to trigger for contact_intel — nothing in this repo writes it — so no button pretends
  // there is.
  if (action === 'sync-hubspot') {
    // The n8n workflow's own "Sync now" webhook: same incremental pull as its 6-hourly schedule,
    // so pressing this cannot produce a different result from waiting.
    const r = await fetch(N8N_CONTACTS_SYNC, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.REPLY_SECRET ? { 'x-webhook-secret': process.env.REPLY_SECRET } : {}) },
      body: JSON.stringify({ source: 'contacts-tab', by: caller.email || 'cron' }),
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) { res.status(502).json({ error: `the HubSpot sync webhook answered HTTP ${r.status}`, detail: text.slice(0, 300) }); return; }
    // HANDED OFF, NOT FINISHED — and the wording matters. The webhook acknowledges receipt; the
    // pull itself then runs in n8n for as long as it takes.
    res.status(200).json({ ok: true, handed_off: true, detail: text.slice(0, 300) });
    return;
  }

  if (action === 'refresh-directory') {
    const out = await call('refresh_contact_directory');
    const o = Array.isArray(out) ? out[0] : out;
    res.status(200).json({ ok: true, row_count: Number((o && o.row_count) || 0), ms: Number((o && o.ms) || 0) });
    return;
  }

  if (action === 'refresh-reach') {
    // The existing reach snapshot the Queue and Compose count from — unrelated to the directory
    // above, and the one whose staleness puts a wrong "No audience" badge on a row.
    await call('refresh_market_contacts');
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: `unknown action: ${action || '(none)'}` });
}
