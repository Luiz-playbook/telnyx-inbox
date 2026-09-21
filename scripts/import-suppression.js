#!/usr/bin/env node
//
// Load the do-not-contact CSVs in suppression/ into the database.
//
//   node scripts/import-suppression.js              every .csv in suppression/
//   node scripts/import-suppression.js one.csv      just that file
//   node scripts/import-suppression.js --dry-run    parse and report, write nothing
//
// WHAT IT DOES NOT DO: normalise. Phone numbers and addresses are cleaned INSIDE the database by
// suppress_contacts (migration 085), through the same functions the send path uses. A second
// implementation here would eventually disagree with the first, and a suppression list that
// normalises differently from the send fails to match the very people it protects — silently,
// which is the worst way for this particular thing to fail.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, read from .env. The service role is required:
// suppress_contacts is granted to it alone, because nothing in a browser should be able to add
// or — much more importantly — remove someone from a do-not-contact list.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const DIR = path.join(ROOT, 'suppression');

// --- env ---------------------------------------------------------------------------------
const env = {};
try {
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch { /* fall through to process.env */ }
const SUPA = process.env.SUPABASE_URL || env.SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

// --- CSV ---------------------------------------------------------------------------------
//
// A real parser, small. Exports from Sheets and Excel quote any field containing a comma, and a
// naive split() turns one such row into two half-rows — which here would mean a mangled address
// silently suppressing nobody. Handles quoted fields, escaped quotes ("") and newlines inside
// quotes; that is the whole of what these files can contain.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  // Strip a UTF-8 BOM: Excel writes one, and it would otherwise become part of the first header
  // name, so "email" arrives as "﻿email" and matches nothing.
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// Header matching is LOOSE on purpose: these files come from whoever exported them, and
// "Email Address", "email_address" and "E-Mail" are the same column. Anything unrecognised is
// ignored rather than rejected, so an export with thirty columns works untouched.
const norm = h => String(h || '').toLowerCase().replace(/[^a-z]/g, '');
const FIELDS = {
  email:        ['email', 'emailaddress', 'email1', 'workemail', 'contactemail', 'emailaddresses'],
  phone:        ['phone', 'phonenumber', 'mobile', 'mobilephone', 'cell', 'cellphone', 'telephone', 'number', 'phone1'],
  full_name:    ['name', 'fullname', 'contactname', 'contact'],
  first_name:   ['firstname', 'first'],
  last_name:    ['lastname', 'last', 'surname'],
  organization: ['organization', 'organisation', 'company', 'companyname', 'org', 'account', 'accountname', 'club'],
  reason:       ['reason', 'note', 'notes', 'why', 'comment', 'comments', 'status'],
  channel:      ['channel', 'type'],
};
function mapHeaders(header) {
  const idx = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [field, names] of Object.entries(FIELDS)) {
      if (names.includes(n) && idx[field] === undefined) idx[field] = i;
    }
  });
  return idx;
}

function rowsFrom(file) {
  const table = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!table.length) return { rows: [], noIdentifier: 0, headers: [] };
  const header = table[0];
  const idx = mapHeaders(header);
  const get = (r, f) => (idx[f] === undefined ? '' : String(r[idx[f]] ?? '').trim());
  const out = [];
  let noIdentifier = 0;
  for (const r of table.slice(1)) {
    const email = get(r, 'email');
    const phone = get(r, 'phone');
    if (!email && !phone) { noIdentifier++; continue; }
    const name = get(r, 'full_name')
      || [get(r, 'first_name'), get(r, 'last_name')].filter(Boolean).join(' ');
    out.push({
      email: email || null,
      phone: phone || null,
      full_name: name || null,
      organization: get(r, 'organization') || null,
      reason: get(r, 'reason') || null,
      channel: get(r, 'channel') || null,
      source: path.basename(file),
    });
  }
  return { rows: out, noIdentifier, headers: header };
}

// --- run ---------------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const named = args.filter(a => !a.startsWith('--'));

if (!fs.existsSync(DIR)) { console.error(`No suppression/ folder at ${DIR}`); process.exit(1); }
const files = (named.length ? named.map(f => (path.isAbsolute(f) ? f : path.join(DIR, f)))
                            : fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.csv')).map(f => path.join(DIR, f)));

if (!files.length) {
  console.log('Nothing to import — no .csv files in suppression/.');
  console.log('Drop the sheets in there and run this again. See suppression/README.md.');
  process.exit(0);
}
if (!dryRun && (!SUPA || !KEY)) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (looked in .env).');
  process.exit(1);
}

let grandIns = 0, grandUpd = 0, grandSkip = 0, failed = 0;
for (const file of files) {
  const label = path.basename(file);
  if (!fs.existsSync(file)) { console.log(`${label}: not found`); failed++; continue; }
  const { rows, noIdentifier, headers } = rowsFrom(file);

  console.log(`\n${label}`);
  console.log(`  columns found : ${headers.join(', ')}`);
  console.log(`  usable rows   : ${rows.length}`);
  if (noIdentifier) console.log(`  skipped       : ${noIdentifier} with neither an email nor a phone`);
  if (!rows.length) continue;

  if (dryRun) {
    console.log('  dry run — nothing written. First few:');
    rows.slice(0, 3).forEach(r => console.log('   ', JSON.stringify(r)));
    continue;
  }

  // Batched. suppress_contacts is set-based, so a batch costs two statements whatever its size
  // — the limit is the payload and the statement timeout, not the row count. 5,000 keeps the
  // 496k-row list to ~100 round trips instead of a thousand, at under a megabyte each.
  //
  // Still batched rather than sent whole: one failed call should lose one batch, not the import.
  const SIZE = 5000;
  let ins = 0, upd = 0, skip = 0, error = null;
  for (let i = 0; i < rows.length; i += SIZE) {
    const batch = rows.slice(i, i + SIZE);
    const res = await fetch(`${SUPA}/rest/v1/rpc/suppress_contacts`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_rows: batch, p_source_file: label }),
    });
    const text = await res.text();
    if (!res.ok) { error = `HTTP ${res.status} ${text.slice(0, 200)}`; break; }
    let j = null; try { j = JSON.parse(text); } catch { /* shrug */ }
    const r0 = Array.isArray(j) ? j[0] : j;
    ins += Number(r0?.inserted || 0); upd += Number(r0?.updated || 0); skip += Number(r0?.skipped || 0);
  }

  if (error) { console.log(`  FAILED        : ${error}`); failed++; continue; }
  console.log(`  added         : ${ins}`);
  console.log(`  updated       : ${upd}`);
  if (skip) console.log(`  unusable      : ${skip} (no valid email or phone after cleaning)`);
  grandIns += ins; grandUpd += upd; grandSkip += skip;
}

if (!dryRun) {
  console.log(`\n${grandIns} added, ${grandUpd} updated${grandSkip ? `, ${grandSkip} unusable` : ''}${failed ? `, ${failed} file(s) failed` : ''}.`);
  // Said every time, because the gap between "the list exists" and "the list is enforced" is the
  // dangerous part, and it should not be something you have to remember.
  console.log('\nNOTE: the send path does not consult this list yet. These records are stored,');
  console.log('but a blast will still reach them until the enforcement migration is applied.');
}
process.exit(failed ? 1 : 0);
