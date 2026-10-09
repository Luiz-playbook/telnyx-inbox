// Loads an arena section-map sheet into public.venue_section_zones (AI-1098).
//
// NBA today, every league eventually — --league is what makes adding a sport data rather than
// code. The zone vocabulary is checked per league so a typo in a sheet cannot invent a zone.
//
//   node --env-file=.env scripts/load-section-zones.js --dry     # report coverage, write nothing
//   node --env-file=.env scripts/load-section-zones.js           # upsert into Supabase
//
// The sheet is shared with the playbook-scrapes service account, so this reads it with
// GOOGLE_SERVICE_ACCOUNT_KEY. Self-contained like the other scripts/ one-offs: the JWT is a
// dozen lines of node:crypto rather than a dependency this repo does not have (the same
// reasoning, and the same code shape, as the Sheets import in api/contacts.js).
//
// RUN --dry FIRST, EVERY TIME. Two things in the source need a human to look at them and the dry
// report is where they show up: which tiers got classified into which ring, and which teams or
// tiers are missing. A silent load of a mis-classified mezzanine would quietly undercut every
// "lower bowl from $X" quote with a section number that is not in the bowl at all.

import crypto from 'node:crypto';

const SHEET_ID = process.env.NBA_ZONE_SHEET_ID || '1j2pTC85y7yUoS7IRLNP5Z30_g79mw7Vz7SuNlATd90o';
const TAB = process.env.NBA_ZONE_SHEET_TAB || 'By Section';
const DRY = process.argv.includes('--dry');
const li = process.argv.indexOf('--league');
const LEAGUE = (li > -1 && process.argv[li + 1] ? process.argv[li + 1] : 'nba').toLowerCase();

// The zones this league is allowed to use. A sheet that spells one differently should fail
// loudly here rather than quietly create a fifth zone nothing queries for.
const LEAGUE_ZONES = {
  nba: { 'center court': 1, sideline: 2, corner: 3, 'behind basket': 4 },
};
if (!LEAGUE_ZONES[LEAGUE]) throw new Error(`no zone vocabulary for league "${LEAGUE}" — add it to LEAGUE_ZONES`);

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- zones -----------------------------------------------------------------------------------
//
// Rank is the premium order Josh quotes in, and it is also the tie-break: the sheet lists the
// midcourt sections a second time under sideline, so the lowest rank seen for a section wins.
const ZONES = LEAGUE_ZONES[LEAGUE];

// The sheet writes them title-cased and has used a couple of spellings for the baseline.
function zoneOf(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.startsWith('center') || s.startsWith('mid')) return 'center court';
  if (s.startsWith('side')) return 'sideline';
  if (s.startsWith('corner')) return 'corner';
  if (s.includes('basket') || s.includes('baseline')) return 'behind basket';
  return null;
}

// --- tier -> ring ----------------------------------------------------------------------------
//
// Order matters and each branch is a real row in the sheet:
//   'Mezzanine M101–M126'        mezzanine, and it repeats the bowl's own numbers with an M
//   'Middle 100s (102–129)'      Barclays' second ring, not the bowl
//   'Courtside Club 1–23'        on the floor
//   "Lower-lower 'L' sections"   the sheet calls these floor-level, in front of the baseline
//   'Loge 1–22 (lower bowl)'     the bowl, matched on 'lower bowl'
//   'Club 100s (sideline club)'  a club ring — checked BEFORE the 100-level branch, which looks
//                                for '100 level' and so does not catch '100s' on its own
function tierClass(raw) {
  const s = String(raw || '').toLowerCase();
  if (/mezzanin/.test(s)) return 'mezzanine';
  if (/\bmiddle\b/.test(s)) return 'mezzanine';
  if (/courtside|floor/.test(s)) return 'floor';
  if (/lower-lower/.test(s)) return 'floor';
  if (/pinnacle|premier|suite|\bclub\b/.test(s)) return 'club';
  if (/100 level|lower bowl|\bplaza\b|\bloge\b/.test(s)) return 'lower_bowl';
  if (/all rings/.test(s)) return 'lower_bowl';   // Clippers' shared 1-32 clock numbering
  return 'upper';
}

// Sections are matched against whatever a marketplace printed, so both sides get the same
// treatment: uppercase, and everything that is not a letter or digit thrown away.
//   ' 106 CT ' -> '106CT'    'M-103' -> 'M103'    '101L' -> '101L'
const normSection = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

// --- Google auth -----------------------------------------------------------------------------

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function googleKey() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw) return null;
  let txt = raw;
  if (!txt.startsWith('{')) { try { txt = Buffer.from(raw, 'base64').toString('utf8'); } catch { return null; } }
  try {
    const j = JSON.parse(txt);
    if (!j.client_email || !j.private_key) return null;
    return { email: j.client_email, privateKey: String(j.private_key).replace(/\\n/g, '\n') };
  } catch { return null; }
}

async function googleToken() {
  const k = googleKey();
  if (!k) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set (the sheet is private)');
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: k.email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signed = `${head}.${claims}`;
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(signed), k.privateKey));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signed}.${sig}` }),
  });
  if (!r.ok) throw new Error('Google rejected the service-account key: ' + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}

async function readTab(token) {
  const range = encodeURIComponent(`${TAB}!A1:G2000`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`,
    { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    if (r.status === 403 || r.status === 404) {
      throw new Error(`Sheets refused ${r.status}. Share the sheet with ${googleKey().email} as Viewer. ${body}`);
    }
    throw new Error(`Sheets ${r.status}: ${body}`);
  }
  return (await r.json()).values || [];
}

// --- main ------------------------------------------------------------------------------------

const rows = await readTab(await googleToken());
if (!rows.length) throw new Error(`"${TAB}" came back empty`);

const header = rows[0].map(h => String(h || '').trim().toLowerCase());
const col = name => header.indexOf(name);
const iTeam = col('team'), iArena = col('arena'), iTier = col('tier'),
  iSection = col('section'), iZone = col('zone'), iSource = col('source'), iConf = col('confidence');
for (const [label, idx] of [['team', iTeam], ['tier', iTier], ['section', iSection], ['zone', iZone]]) {
  if (idx < 0) throw new Error(`"${TAB}" has no ${label} column; got: ${header.join(', ')}`);
}

const byKey = new Map();   // team|tier|section -> row, most premium zone kept
const skipped = [];
const tiers = new Map();   // tier text -> {class, n}

for (let n = 1; n < rows.length; n++) {
  const r = rows[n];
  const team = String(r[iTeam] || '').trim();
  const tier = String(r[iTier] || '').trim();
  const section = normSection(r[iSection]);
  const zone = zoneOf(r[iZone]);
  if (!team || !tier || !section) continue;              // spacer rows
  if (!zone) { skipped.push(`row ${n + 1}: ${team} ${tier} ${section} — zone "${r[iZone]}" not recognised`); continue; }

  const klass = tierClass(tier);
  const t = tiers.get(tier) || { class: klass, n: 0 };
  t.n++; tiers.set(tier, t);

  const rec = {
    league: LEAGUE,
    team,
    arena: String(r[iArena] || '').trim() || team,
    tier,
    section,
    zone,
    zone_rank: ZONES[zone],
    tier_class: klass,
    source: String(r[iSource] || '').trim() || null,
    // Anything not explicitly High is treated as needing a look, which is the safe direction.
    confidence: /^high$/i.test(String(r[iConf] || '').trim()) ? 'High' : 'Medium',
  };

  const key = `${team}|${tier}|${section}`;
  const prev = byKey.get(key);
  if (!prev || rec.zone_rank < prev.zone_rank) byKey.set(key, rec);
}

const out = [...byKey.values()];
const teams = [...new Set(out.map(r => r.team))].sort();
const lower = out.filter(r => r.tier_class === 'lower_bowl');

console.log(`\nread ${rows.length - 1} rows from "${TAB}" -> ${out.length} unique team+tier+section`);
console.log(`teams: ${teams.length}   lower-bowl sections: ${lower.length}`);
console.log(`collapsed by the midcourt/sideline overlap: ${(rows.length - 1) - out.length - skipped.length}`);

console.log('\n-- zones --');
for (const z of Object.keys(ZONES)) {
  const all = out.filter(r => r.zone === z).length;
  console.log(`  ${z.padEnd(14)} ${String(all).padStart(4)}   (lower bowl ${lower.filter(r => r.zone === z).length})`);
}

console.log('\n-- tier -> ring (CHECK THIS) --');
for (const [tier, t] of [...tiers].sort((a, b) => a[1].class.localeCompare(b[1].class) || a[0].localeCompare(b[0]))) {
  console.log(`  ${t.class.padEnd(11)} ${String(t.n).padStart(4)}  ${tier}`);
}

console.log('\n-- confidence --');
console.log(`  High   ${out.filter(r => r.confidence === 'High').length}`);
console.log(`  Medium ${out.filter(r => r.confidence === 'Medium').length}   <- derived by counting; verify before quoting`);

const noLower = teams.filter(t => !lower.some(r => r.team === t));
if (noLower.length) console.log(`\n!! teams with NO lower-bowl tier: ${noLower.join(', ')}`);
if (teams.length < 30) console.log(`\n!! ${30 - teams.length} NBA teams missing from the map`);
if (skipped.length) { console.log('\n-- skipped --'); for (const s of skipped.slice(0, 15)) console.log('  ' + s); }

console.log('\n-- teams --');
console.log('  ' + teams.join(', '));

// --out writes the normalised rows to a file. The matcher is deliberately source-agnostic, so a
// snapshot is enough to run and test the whole zone pipeline with no database at all — which is
// also how the Kernel comparison harness gets its map without touching prod.
const outFlag = process.argv.indexOf('--out');
if (outFlag > -1 && process.argv[outFlag + 1]) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[outFlag + 1], JSON.stringify(out, null, 1));
  console.log(`\nwrote ${out.length} rows to ${process.argv[outFlag + 1]}`);
}

if (DRY) { console.log('\n--dry: nothing written to the database.\n'); process.exit(0); }

if (!SUPA_URL || !SUPA_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY needed to write');

// Replace this league's rows wholesale rather than merging: a section that moved zone in the
// sheet has to stop answering with its old one, and a merge would leave the stale row behind
// forever. Scoped to the league so loading the NBA map never touches another sport's rows.
const del = await fetch(`${SUPA_URL}/rest/v1/venue_section_zones?league=eq.${encodeURIComponent(LEAGUE)}`, {
  method: 'DELETE',
  headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, Prefer: 'return=minimal' },
});
if (!del.ok) throw new Error('clear failed: ' + (await del.text()).slice(0, 300));

for (let i = 0; i < out.length; i += 500) {
  const chunk = out.slice(i, i + 500);
  const r = await fetch(`${SUPA_URL}/rest/v1/venue_section_zones`, {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY,
      'content-type': 'application/json', Prefer: 'return=minimal,resolution=merge-duplicates',
    },
    body: JSON.stringify(chunk),
  });
  if (!r.ok) throw new Error(`insert at ${i} failed: ${(await r.text()).slice(0, 300)}`);
  console.log(`  wrote ${Math.min(i + 500, out.length)}/${out.length}`);
}
console.log('done.\n');
