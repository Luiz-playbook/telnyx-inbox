// AI-1097: (re)publish a Kernel POC run to a Google Sheet tab, from a saved run file.
//
//   node --env-file=.env scripts/kernel-poc-sheet.js --in kernel-poc.json [--tab "Kernel POC"]
//
// Separate from the run itself so the report can be rebuilt — reformatted, corrected, renamed —
// without re-scraping anything or spending another Kernel session.
//
// TWO FORMATTING RULES, both learned by getting them wrong on the live sheet:
//
//  1. CLEAR THE TAB FIRST. values.update writes a block from A1 and leaves everything outside it
//     alone, so a shorter run lands on top of a longer one and the leftovers read as part of the
//     new report. What that looked like in practice: a COST row trailing off into the previous
//     run's per-game columns, and prices sitting next to the wrong game.
//  2. EVERY ROW IS PADDED TO THE SAME WIDTH. A sheet is a grid, and short rows let whatever is
//     to the right show through. Padding is what keeps a price in line with its own row.

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const IN = arg('in');
const SHEET_ID = process.env.NBA_ZONE_SHEET_ID || '1j2pTC85y7yUoS7IRLNP5Z30_g79mw7Vz7SuNlATd90o';
const TAB = arg('tab', 'Kernel POC ' + new Date().toISOString().slice(0, 10));
if (!IN) throw new Error('--in <run.json> required (kernel-poc.js --out)');

const run = JSON.parse(readFileSync(IN, 'utf8'));
const games = run.games || [];
const ZONES = ['center court', 'sideline', 'corner', 'behind basket'];
const PATHS = [
  ['gametime_ladder', 'Gametime', 'existing ladder (HTML)'],
  ['gametime_api', 'Gametime', 'JSON API (plain HTTP)'],
  ['gametime_kernel', 'Gametime', 'via Kernel'],
  ['vivid_kernel', 'Vivid Seats', 'via Kernel (only way in)'],
];

const okCount = k => games.filter(g => g.sites[k] && g.sites[k].ok).length;
const avg = k => {
  const v = games.map(g => g.sites[k]).filter(x => x && x.ok).map(x => x.ms);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : '';
};
const money = v => (v == null || v === '' ? '' : '$' + Number(v).toLocaleString('en-US'));

// --- build the grid ---------------------------------------------------------------------------

const rows = [];
rows.push(['Kernel POC — section-level ticket prices, zone-tagged']);
rows.push(['run', run.cost && run.cost.seconds ? new Date().toISOString() : new Date().toISOString(), `${games.length} games`]);
rows.push([]);

// The one table that answers "what can we actually get, and how". Method across, site down.
rows.push(['1. SUMMARY — WHAT EACH METHOD GETS FROM EACH SITE']);
rows.push(['site', 'Ladder (HTML + Crawl4AI/Firecrawl)', 'Direct API (plain HTTP, no browser)', 'Kernel (hosted browser)', 'best available today']);
rows.push(['Gametime',
  'section + row, but fragile — the parser reverse-engineers two HTML encodings',
  'SAME DATA, ~1.2 s/game, and states the ring (Lower/Middle/Upper)',
  'same data, ~12 s/game — works, but Kernel is not needed here',
  'Direct API']);
rows.push(['Vivid Seats',
  'team page only: lowPrice, NO section, all-in only estimated',
  'blocked — Imperva challenge on both the page and the listings API',
  '850-1500 listings w/ section, row, qty, REAL all-in, ~11 s/game',
  'Kernel (only way in)']);
rows.push(['TickPick',
  'team page only: lowPrice, NO section',
  'blocked — DataDome 403 on the listings API',
  'page clears sometimes; listings API never. Aggregates only (count/min/max/avg)',
  'nothing section-level']);
rows.push(['SeatGeek',
  'team page only: lowest_price, NO section',
  'event page DataDome (its own API was never probed directly — worth an hour)',
  'blocked both modes — headless 0/2, headful 0/2',
  'nothing section-level']);
rows.push(['StubHub',
  'team page only: lowPrice, NO section, all-in only estimated',
  'event page DataDome (API never probed directly)',
  'HEADFUL only: 8 curated listings w/ section, row, qty, real all-in',
  'cross-check only — 8 listings cannot price a zone']);
rows.push(['', '', '', '', '']);
rows.push(['Takeaway', 'Gametime JSON API is the biggest win and needs no Kernel.',
  'Kernel unlocks exactly one real source: Vivid Seats.',
  'Three sites still blocked by DataDome; one residential-proxy test settles all three.', '']);
rows.push([]);

rows.push(['2. SIDE BY SIDE vs THE CURRENT SCRAPER (measured this run)']);
rows.push(['site', 'path', 'success rate', 'avg time per game', 'section-level data?']);
for (const [k, site, label] of PATHS) {
  rows.push([site, label, `${okCount(k)}/${games.length} (${games.length ? Math.round((okCount(k) / games.length) * 100) : 0}%)`,
    avg(k) ? (avg(k) / 1000).toFixed(1) + ' s' : '—', 'yes']);
}
rows.push([]);

rows.push(['3. COST']);
rows.push(['metric', 'value', 'note']);
if (run.cost) {
  const per = games.length ? run.cost.usd / games.length : 0;
  rows.push(['Kernel — this run', money(run.cost.usd.toFixed(4)), `${games.length} games in one browser session`]);
  rows.push(['Kernel — per game', money(per.toFixed(4)), '']);
  rows.push(['Kernel — est. per 100 games', money((per * 100).toFixed(2)), 'extrapolated from this run, not a quote']);
  rows.push(['  session memory', run.cost.memory_gb + ' GB', run.cost.memory_gb >= 8 ? 'headful (required to record a replay) — 8x the headless rate' : 'headless']);
  rows.push(['  session wall-clock', run.cost.seconds + ' s', 'Kernel bills duration, not requests']);
  rows.push(['  billed GB-seconds', run.cost.gb_seconds, '$0.0000166667 per GB-second']);
} else {
  rows.push(['Kernel — this run', 'not recorded', 'run file predates cost tracking']);
}
rows.push(['Existing ladder', 'no per-call cost', 'plain HTTP; Firecrawl credits only when it escalates']);
rows.push(['Gametime JSON API', 'no per-call cost', 'open over plain HTTP, ~1.2 s/game']);
rows.push(['Kernel plan', 'Free — $0/mo + usage', '$5/mo free credits; stealth, captcha solver and proxies included']);
rows.push([]);

rows.push(['4. REACHABILITY DETAIL (measured 2026-10-07/08)']);
rows.push(['site', 'plain HTTP', 'Kernel + stealth', 'section-level data?']);
rows.push(['Gametime', 'open — page and JSON API', 'works, but slower than plain', 'YES']);
rows.push(['Vivid Seats', 'Imperva challenge', 'clears — listings reachable', 'YES (Kernel only)']);
rows.push(['TickPick', 'Cloudflare on page, DataDome on listings API', 'page clears sometimes; listings API never — headless 0/2, headful 0/2', 'no']);
rows.push(['SeatGeek', '403 DataDome', 'does not clear — headless 0/2, headful 0/2', 'no']);
rows.push(['StubHub', '403 DataDome', 'headless 0/2 blocked; HEADFUL 2/2 reached it in ~7s', 'PARTIAL — only 8 curated listings, see note below']);
rows.push([]);
rows.push(['HOW MANY LISTINGS EACH SOURCE ACTUALLY RETURNS (same kind of game)']);
rows.push(['source', 'listings per game', 'verdict', '']);
rows.push(['Vivid Seats (Kernel)', '~850-1500', 'full inventory — section, row, qty, real all-in', '']);
rows.push(['Gametime (JSON API)', '~210-270', 'full inventory — section, row, and the ring stated outright', '']);
rows.push(['StubHub (Kernel, headful)', '8', 'curated shortlist, NOT inventory — cross-check only, cannot price a zone', '']);
rows.push([]);
rows.push(['NOTES']);
rows.push(['Headful vs headless', 'only StubHub changed', 'headful = 8 GB vs 1 GB, so ~8x the rate ($0.003/game vs $0.0004)', '']);
rows.push(['Residential proxy (paid plan)', 'untested', 'the one remaining lever for SeatGeek and TickPick — both fail identically on DataDome', '']);
rows.push(['One test answers both', '', 'SeatGeek and TickPick fail the same way, so a single proxy trial settles both', '']);
rows.push([]);

rows.push(['5. CHEAPEST LOWER-BOWL PRICE PER ZONE (all-in per ticket, USD, standing room excluded)']);
rows.push(['game', 'venue', 'site', 'path', 'listings',
  ...ZONES, ...ZONES.map(z => z + ' — section'), 'listing url']);
for (const g of games) {
  for (const [k, site, label] of PATHS) {
    const s = g.sites[k];
    if (!s) { rows.push([g.game, g.venue || '', site, label, 'not run']); continue; }
    if (!s.ok) { rows.push([g.game, g.venue || '', site, label, 'FAILED: ' + (s.why || '')]); continue; }
    const z = (s.bowl && s.bowl.zones) || {};
    rows.push([g.game, g.venue || '', site, label, s.listings,
      ...ZONES.map(n => (z[n] ? z[n].all_in : '')),
      ...ZONES.map(n => (z[n] ? z[n].section : '')),
      s.url || '']);
  }
}

if (run.replay && run.replay.download_url) {
  rows.push([]);
  rows.push(['6. SESSION REPLAY']);
  rows.push(['download', run.replay.download_url]);
  rows.push(['command', `node --env-file=.env scripts/kernel-replay.js ${run.replay.session_id} ${run.replay.replay_id}`]);
}
if (run.fails && run.fails.length) {
  rows.push([]);
  rows.push(['7. FAILURES']);
  for (const f of run.fails) rows.push([f]);
}

// Rule 2: one width for the whole grid.
const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
const grid = rows.map(r => { const c = r.slice(); while (c.length < width) c.push(''); return c; });

// --- publish ------------------------------------------------------------------------------------

const b64 = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
const k = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
const now = Math.floor(Date.now() / 1000);
const signed = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({
  iss: k.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
}))}`;
const sig = b64(crypto.sign('RSA-SHA256', Buffer.from(signed), String(k.private_key).replace(/\\n/g, '\n')));
const tr = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signed}.${sig}` }),
});
if (!tr.ok) throw new Error('google token: ' + (await tr.text()).slice(0, 200));
const H = { Authorization: 'Bearer ' + (await tr.json()).access_token, 'content-type': 'application/json' };

const add = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
  method: 'POST', headers: H, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }),
});
if (!add.ok) { const t = await add.text(); if (!t.includes('already exists')) throw new Error('addSheet: ' + t.slice(0, 300)); }

// Rule 1.
const clear = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}:clear`,
  { method: 'POST', headers: H, body: '{}' });
if (!clear.ok) throw new Error('clear: ' + (await clear.text()).slice(0, 300));

const up = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB + '!A1')}?valueInputOption=RAW`,
  { method: 'PUT', headers: H, body: JSON.stringify({ values: grid }) });
if (!up.ok) throw new Error('update: ' + (await up.text()).slice(0, 300));

console.log(`wrote "${TAB}" — ${grid.length} rows x ${width} cols (cleared first)`);
console.log(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
