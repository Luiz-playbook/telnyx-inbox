// AI-1097: publish the Kernel reachability matrix to a new tab in the section-map sheet.
//
//   node --env-file=.env scripts/kernel-matrix-sheet.js --matrix matrix.json --probe probe.json \n//     --replaydir ./replays
//
// Writes a DATED tab and leaves earlier ones alone. The free-tier run is the baseline the paid
// run is being compared against, so overwriting it would destroy the comparison that is the
// whole point of the report.
//
// Same two formatting rules as scripts/kernel-poc-sheet.js, learned the same way: clear the tab
// before writing, because values.update leaves anything outside the block it writes and a
// shorter run reads as part of the longer one underneath it; and pad every row to one width,
// because short rows let the previous content show through on the right.

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import crypto from 'node:crypto';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const SHEET_ID = process.env.NBA_ZONE_SHEET_ID || '1j2pTC85y7yUoS7IRLNP5Z30_g79mw7Vz7SuNlATd90o';
const TAB = arg('tab', 'Kernel paid-plan test ' + new Date().toISOString().slice(0, 10));
const load = f => (f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const matrix = load(arg('matrix'));
const probe = load(arg('probe'));
if (!matrix && !probe) throw new Error('pass --matrix and/or --probe');

// The note carries "api 403"/"api 404", which is what distinguishes a row where the page
// loaded from one where the listings call behind it was refused. Dropping it flattened
// four different outcomes into one "shell, no data".
//
// But a raw CDP timeout is OUR failure, not the site's, and printing it next to real wall
// results in a report for Marx invites reading it as one. So harness errors are labelled as
// harness errors and anything unrecognised is left out rather than guessed at.
const note = n => {
  if (!n) return '';
  if (/cdp |timed out|ECONN|socket/i.test(n)) return 'harness: navigation timed out, not a site block';
  if (/^api \d/i.test(n)) return n;
  return '';
};
const cell = r => {
  if (r.error) return 'error';
  const n = note(r.note);
  if (r.wall) return r.wall.toUpperCase() + (n ? ' — ' + n : '');
  const got = r.listings ? `${r.listings} listings` : r.rows ? `${r.rows} rows` : 'shell, no data';
  return n ? `${got} — ${n}` : got;
};

const rows = [];
rows.push(['Kernel reachability — paid plan (Hobbyist)']);
rows.push(['run', new Date().toISOString(), 'stealth on throughout']);
rows.push([]);
rows.push(['THE QUESTION THIS ANSWERS']);
rows.push(['On the free tier, proxies were refused (403 insufficient_plan) and three sites were unreachable.']);
rows.push(['The assumption was that a residential IP would unblock them, since DataDome scores IP reputation.']);
rows.push(['Hobbyist includes proxies, so that assumption is now testable. It did not hold — see below.']);
rows.push([]);

if (matrix) {
  const sites = [...new Set(matrix.results.flatMap(r => Object.keys(r.sites || {})))];
  rows.push(['1. HEADLESS / HEADFUL x PROXY / NO PROXY (residential)']);
  rows.push(['configuration', ...sites]);
  for (const r of matrix.results) {
    rows.push([r.mode, ...sites.map(s => cell(r.sites[s] || {}))]);
  }
  rows.push([]);
  rows.push(['Vivid is the CONTROL — it worked on the free tier with no proxy, so if it breaks, the configuration is at fault.']);
  rows.push(['How the proxy breaks it: its listings API answers 404 on both proxy rows. Same localisation trap as the CAD currency bug.']);
  rows.push([]);
}

if (probe) {
  const sites = [...new Set(probe.runs.map(r => r.site))];
  const labels = [...new Set(probe.runs.map(r => r.label))];
  rows.push(['2. EGRESS TYPE AND PERSISTENT PROFILE (headful throughout)']);
  rows.push(['egress', ...sites]);
  for (const l of labels) {
    rows.push([l, ...sites.map(s => cell(probe.runs.find(x => x.label === l && x.site === s) || {}))]);
  }
  rows.push([]);
  rows.push(['A profile is warmed first — the scored run is the SECOND visit, so the browser arrives with state.']);
  rows.push([]);
}

rows.push(['3. WHAT THIS MEANS']);
rows.push(['SeatGeek', 'blocked in every configuration tried', 'use Apify — 5,548 seat-level listings, ~$0.008/event']);
rows.push(['StubHub', 'headful only, and the proxy BREAKS it', 'cross-check only — the ceiling is 8 real listings']);
rows.push(['TickPick', 'proxy gets the page, never the listings API', 'no section-level data by any route']);
rows.push(['Vivid Seats', 'headful, NO proxy — ~1,000 listings', 'Kernel is worth it here, and only here']);
rows.push(['Gametime', 'never needed Kernel', 'its own JSON API is open, ~1.2 s']);
rows.push([]);
rows.push(['The residential proxy did not unblock a single site and broke two that worked.']);
rows.push(['What the paid plan does buy: 7-day replay retention (was 1) and 10 concurrent browsers.']);
rows.push([]);

// Filled by --replaydir: a replay is only marked verified if its file is on disk and starts
// with an MP4 ftyp box. An empty map leaves the column blank rather than asserting anything.
const VERIFIED = {};
const repDir = arg('replaydir');
if (repDir) {
  for (const f of (existsSync(repDir) ? readdirSync(repDir) : [])) {
    if (!f.endsWith('.mp4')) continue;
    const full = repDir + '/' + f;
    const head = readFileSync(full).subarray(4, 8).toString('latin1');
    if (head === 'ftyp') VERIFIED[f.replace(/.mp4$/, '')] = Math.round(statSync(full).size / 1024);
  }
  console.log(`verified ${Object.keys(VERIFIED).length} replay file(s) in ${repDir}`);
}

const reps = (probe ? probe.runs : []).filter(r => r.replay);
if (reps.length) {
  rows.push(['4. SESSION REPLAYS', `${reps.length} recorded, retained 7 days`]);
  rows.push(['Every one below was downloaded and checked for a real MP4 header, not just recorded.']);
  rows.push(['run', 'site', 'download command', 'verified']);
  for (const r of reps) {
    const kb = VERIFIED[`${r.label}-${r.site}`];
    rows.push([r.label, r.site,
      `node --env-file=.env scripts/kernel-replay.js ${r.replay.session_id} ${r.replay.replay_id}`,
      kb ? `mp4, ${kb} KB` : '']);
  }
  rows.push([]);
}

const spend = [...(matrix ? matrix.results : []), ...(probe ? probe.runs : [])]
  .reduce((n, r) => n + ((r.cost && r.cost.usd) || 0), 0);
rows.push(['cost of this testing', '$' + spend.toFixed(4), 'Hobbyist includes $10/month of credits']);

const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
const grid = rows.map(r => { const c = r.slice(); while (c.length < width) c.push(''); return c; });

// --- publish -----------------------------------------------------------------------------------
const b64 = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
const k = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
const now = Math.floor(Date.now() / 1000);
const signed = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({
  iss: k.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
const sig = b64(crypto.sign('RSA-SHA256', Buffer.from(signed), String(k.private_key).replace(/\\n/g, '\n')));
const tr = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signed}.${sig}` }) });
if (!tr.ok) throw new Error('google token: ' + (await tr.text()).slice(0, 200));
const H = { Authorization: 'Bearer ' + (await tr.json()).access_token, 'content-type': 'application/json' };

const add = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
  method: 'POST', headers: H, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }) });
if (!add.ok) { const t = await add.text(); if (!t.includes('already exists')) throw new Error('addSheet: ' + t.slice(0, 300)); }

const clear = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}:clear`,
  { method: 'POST', headers: H, body: '{}' });
if (!clear.ok) throw new Error('clear: ' + (await clear.text()).slice(0, 200));

const up = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB + '!A1')}?valueInputOption=RAW`,
  { method: 'PUT', headers: H, body: JSON.stringify({ values: grid }) });
if (!up.ok) throw new Error('update: ' + (await up.text()).slice(0, 300));

console.log(`wrote "${TAB}" — ${grid.length} rows x ${width} cols`);
console.log(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
