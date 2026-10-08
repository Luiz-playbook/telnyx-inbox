// AI-1097: the Kernel POC run, and the side-by-side against the ladder we already have.
//
//   node --env-file=.env scripts/kernel-poc.js --map zones.json --games 5
//   node --env-file=.env scripts/kernel-poc.js --map zones.json --games 5 --sheet
//
// Pulls SECTION-LEVEL prices for N games across two sites, zone-tags every listing with the
// NBA_Arena_Section_Map, and measures Kernel against plain HTTP on the same pages. --sheet
// writes the result to a new tab in the section-map spreadsheet.
//
// WHY THESE TWO SITES. Section-level data exists on exactly one site without a browser
// (Gametime) and on one more with one (Vivid). Measured 2026-10-07 against the event pages:
//
//   Gametime  open            section, row, sectionGroup per listing
//   Vivid     Imperva wall    Kernel clears it; 966 listings with section, row, quantity
//   TickPick  Cloudflare      Kernel gets "Verification successful" then never loads the page
//   SeatGeek  DataDome        does not clear on Kernel's datacenter IP
//   StubHub   DataDome        does not clear on Kernel's datacenter IP
//
// So the honest comparison is: Gametime through BOTH paths, which measures Kernel's cost against
// a page the ladder already handles, plus Vivid, which measures what Kernel is actually for. The
// three walled sites need a residential egress IP, and Kernel gates proxies behind a paid plan.
//
// ONE BROWSER FOR THE WHOLE RUN. The free tier is a small allowance, so the session is opened
// once and navigated repeatedly — a 5-game run is ~15 page loads in one browser, not 15 browsers.

import { readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { gameListings, newScrapeContext, parseGametimeListings, isStandingRoom } from '../lib/scrape-price.js';
import { buildZoneIndex, matchZone, cheapestByZone, ZONES } from '../lib/section-zones.js';
import { openKernelSession } from '../lib/kernel-browser.js';
import { parseVividListings, parseVividProductions, vividListingsUrl } from '../lib/vivid-listings.js';
import { fetchGametimeListings, gametimeEventId, gametimeListingsUrl, parseGametimeApi } from '../lib/gametime-api.js';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const MAP = arg('map');
const N = Number(arg('games', 5));
const SKIP = Number(arg('skip', 2));
const TO_SHEET = process.argv.includes('--sheet');
const SHEET_ID = process.env.NBA_ZONE_SHEET_ID || '1j2pTC85y7yUoS7IRLNP5Z30_g79mw7Vz7SuNlATd90o';

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
if (!MAP) throw new Error('--map <zones.json> required (scripts/load-section-zones.js --out)');

const index = buildZoneIndex(JSON.parse(readFileSync(MAP, 'utf8')));
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// --- games -----------------------------------------------------------------------------------

// --from picks the window. NBA preseason games are frequently absent from the marketplaces
// altogether, so the default steps past them: measuring "not listed on Gametime" five times
// measures the schedule, not the scrapers.
const today = arg('from') || new Date().toISOString().slice(0, 10);
const qs = new URLSearchParams({
  select: 'external_id,event_date,team,team_full,opponent,venue',
  league: 'eq.nba', event_date: 'gte.' + today, order: 'event_date.asc', limit: '200',
});
const r0 = await fetch(`${SUPA_URL}/rest/v1/events_master?${qs}`, { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } });
if (!r0.ok) throw new Error(`events_master ${r0.status}`);
// One game per home team, skipping the next couple of days: a game tipping off today is often
// already gone from the marketplaces, which would measure the schedule rather than the scrapers.
const seen = new Set();
const games = (await r0.json())
  .filter(g => { const k = g.team_full || g.team; if (seen.has(k)) return false; seen.add(k); return true; })
  .slice(SKIP, SKIP + N);
const vias = [];
if (!games.length) throw new Error('no upcoming NBA games found');

console.log(`zone map ${index.size} rows | ${games.length} games | kernel session: one for the run\n`);

// --- the run ---------------------------------------------------------------------------------

const tag = (listings, g) => listings.map(l => ({ ...l, ...matchZone(index, { ...l, team_full: g.team_full, team: g.team }) }));
const zoneLine = z => ZONES.map(k => (z.zones[k] ? `${k.split(' ')[0]} $${z.zones[k].all_in}` : `${k.split(' ')[0]} -`)).join('  ');

const ctx = newScrapeContext();
// replay: true records the session so Marx can watch the run back (acceptance criterion).
const kernel = await openKernelSession({ replay: true });
console.log(`kernel session ${kernel.id}\n`);

let replayInfo = null;
let costInfo = null;
const results = [];
const timing = { gametime_plain: [], gametime_api: [], gametime_kernel: [], vivid_kernel: [] };
const fails = [];

try {
  for (const g of games) {
    const label = `${g.team_full || g.team} v ${g.opponent} ${g.event_date}`;
    console.log('=== ' + label);
    const row = { game: label, venue: g.venue, external_id: g.external_id, sites: {} };

    // --- Gametime, the existing ladder (plain HTTP first) ---
    let gtUrl = null;
    try {
      const t0 = Date.now();
      const got = await gameListings(g, ctx);
      const ms = Date.now() - t0;
      gtUrl = got.url || null;
      if (got.listings.length) {
        const tagged = tag(got.listings, g);
        const bowl = cheapestByZone(tagged, { rings: ['lower_bowl'] });
        timing.gametime_plain.push(ms);
        vias.push(got.via);
        row.sites.gametime_ladder = { ok: true, ms, via: got.via, listings: tagged.length, bowl, url: got.url };
        console.log(`  Gametime ladder   ${String(ms).padStart(6)}ms via ${String(got.via).padEnd(9)} ${tagged.length} listings  ${zoneLine(bowl)}`);
      } else {
        const why = got.fail ? (got.fail.error || got.fail.kind) : 'no listings';
        row.sites.gametime_ladder = { ok: false, ms, why };
        fails.push(`${label} Gametime/ladder: ${why}`);
        console.log(`  Gametime ladder   ${String(ms).padStart(6)}ms  FAIL ${why}`);
      }
    } catch (e) { fails.push(`${label} Gametime/ladder: ${e.message}`); console.log('  Gametime ladder   ERROR ' + e.message); }

    // --- Gametime's own JSON API over plain HTTP (no browser) ---
    if (gtUrl) {
      try {
        const got = await fetchGametimeListings(gtUrl, { quantity: 2 });
        if (got.ok) {
          const usable = got.listings.filter(l => l.deal !== 'zone' && !isStandingRoom(l));
          const tagged = tag(usable, g);
          const bowl = cheapestByZone(tagged, { rings: ['lower_bowl'] });
          timing.gametime_api.push(got.ms);
          row.sites.gametime_api = { ok: true, ms: got.ms, listings: tagged.length, bowl, url: gtUrl };
          console.log(`  Gametime API      ${String(got.ms).padStart(6)}ms plain         ${tagged.length} listings  ${zoneLine(bowl)}`);
        } else {
          row.sites.gametime_api = { ok: false, ms: got.ms, why: got.note || ('status ' + got.status) };
          console.log(`  Gametime API      ${String(got.ms).padStart(6)}ms  FAIL ${got.note || got.status}`);
        }
      } catch (e) { console.log('  Gametime API      ERROR ' + e.message); }
    }

    // --- Gametime through Kernel, via the SAME api from inside the page ---
    //
    // Not by parsing the rendered HTML: that failed on 3 of 3 games because hydration replaces
    // the server-rendered literal parseGametimeListings() depends on. Calling the JSON endpoint
    // from inside the page is both reliable and a fair test of Kernel as a transport.
    if (gtUrl) {
      try {
        const t0 = Date.now();
        const id = gametimeEventId(gtUrl);
        // Load the event page first so the session carries Gametime's cookies, then navigate to
        // the listings endpoint. fetchInPage cannot be used here: mobile.gametime.co is a
        // different origin from gametime.co, so the in-page fetch is blocked by CORS.
        await kernel.goto(gtUrl, { timeoutMs: 45000 });
        const api = await kernel.gotoJson(gametimeListingsUrl(id, { quantity: 2 }));
        const ms = Date.now() - t0;
        const parsed = api.ok ? parseGametimeApi(api.body, { url: gtUrl }) : null;
        if (parsed) {
          const usable = parsed.filter(l => l.deal !== 'zone' && !isStandingRoom(l));
          const tagged = tag(usable, g);
          const bowl = cheapestByZone(tagged, { rings: ['lower_bowl'] });
          timing.gametime_kernel.push(ms);
          row.sites.gametime_kernel = { ok: true, ms, listings: tagged.length, bowl, url: gtUrl };
          console.log(`  Gametime kernel   ${String(ms).padStart(6)}ms ${' '.repeat(13)}${tagged.length} listings  ${zoneLine(bowl)}`);
        } else {
          const why = api.ok ? 'api returned nothing usable' : `api ${api.status} ${String(api.error || '').slice(0, 50)}`;
          row.sites.gametime_kernel = { ok: false, ms, why };
          fails.push(`${label} Gametime/kernel: ${why}`);
          console.log(`  Gametime kernel   ${String(ms).padStart(6)}ms  FAIL ${why}`);
        }
      } catch (e) { fails.push(`${label} Gametime/kernel: ${e.message}`); console.log('  Gametime kernel   ERROR ' + e.message); }
    }

    // --- Vivid, Kernel only: plain HTTP cannot reach either the page or its API ---
    try {
      const t0 = Date.now();
      const search = `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(String(g.team_full || g.team).toLowerCase())}`;
      const sp = await kernel.goto(search, { ready: h => !!parseVividProductions(h), timeoutMs: 60000 });
      const prods = sp.html ? parseVividProductions(sp.html) : null;
      // Match on date first — a team page lists every home game — then confirm the opponent, so
      // a doubleheader or a relocated game cannot silently resolve to the wrong production.
      const opp = slug(g.opponent).split('-').pop();
      const hit = (prods || []).find(p => p.date === g.event_date && (!opp || slug(p.name).includes(opp)))
        || (prods || []).find(p => p.date === g.event_date);
      if (!hit) throw new Error(sp.wall ? `${sp.wall} wall on search` : 'game not found on Vivid');

      const ev = await kernel.goto(hit.url, { timeoutMs: 60000 });
      if (ev.wall) throw new Error(`${ev.wall} wall on event page`);
      // fetchInPage, not gotoJson, and the difference is the payload size. Vivid returns ~750KB
      // of listings; read back through document.innerText after navigating, that comes back
      // truncated and JSON.parse gets nothing. An in-page fetch returns the body intact.
      //
      // It is safe here where it was not for Gametime: this endpoint is same-origin with the
      // event page, so there is no CORS failure to wedge the session with.
      const api = await kernel.fetchInPage(vividListingsUrl(hit.id));
      if (!api.ok) throw new Error(`listings api ${api.status} ${String(api.error || '').slice(0, 60)}`);
      const parsed = parseVividListings(api.body, { url: hit.url });
      const ms = Date.now() - t0;
      if (!parsed) throw new Error('listings api returned nothing usable');

      const tagged = tag(parsed, g);
      const bowl = cheapestByZone(tagged, { rings: ['lower_bowl'] });
      timing.vivid_kernel.push(ms);
      row.sites.vivid_kernel = { ok: true, ms, listings: tagged.length, bowl, url: hit.url };
      console.log(`  Vivid    kernel   ${String(ms).padStart(6)}ms ${' '.repeat(13)}${tagged.length} listings  ${zoneLine(bowl)}`);
    } catch (e) {
      fails.push(`${label} Vivid/kernel: ${e.message}`);
      console.log('  Vivid    kernel   FAIL ' + e.message);
    }

    results.push(row);
  }
} finally {
  // Read the cost BEFORE close(), while the session clock is still the run's clock.
  costInfo = kernel.cost();
  console.log(`\nkernel pages this run: ${kernel.pages}`);
  console.log(`kernel cost this run: $${costInfo.usd}  (${costInfo.memory_gb}GB x ${costInfo.seconds}s = ${costInfo.gb_seconds} GB-s)`);
  const rep = await kernel.close().catch(() => null);
  if (rep) {
    replayInfo = rep;
    console.log(`session replay: ${rep.download_url}`);
    console.log(`  download: curl -H "Authorization: Bearer $KERNEL_API_KEY" -o replay.mp4 "${rep.download_url}"`);
  }
}

// --- comparison ------------------------------------------------------------------------------

const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
const rate = (ok, n) => `${ok}/${n} (${n ? Math.round((ok / n) * 100) : 0}%)`;
const okCount = k => results.filter(r => r.sites[k] && r.sites[k].ok).length;

console.log('\n================ side by side ================');
console.log(`games: ${results.length}\n`);
console.log('path                success        avg time/game   section-level?');
console.log(`Gametime ladder(HTML) ${rate(okCount('gametime_ladder'), results.length).padEnd(14)} ${String(avg(timing.gametime_plain) + 'ms').padEnd(15)} yes`);
console.log(`Gametime API (plain)  ${rate(okCount('gametime_api'), results.length).padEnd(14)} ${String(avg(timing.gametime_api) + 'ms').padEnd(15)} yes`);
console.log(`Gametime kernel     ${rate(okCount('gametime_kernel'), results.length).padEnd(14)} ${String(avg(timing.gametime_kernel) + 'ms').padEnd(15)} yes`);
console.log(`Vivid    kernel     ${rate(okCount('vivid_kernel'), results.length).padEnd(14)} ${String(avg(timing.vivid_kernel) + 'ms').padEnd(15)} yes`);

const slower = avg(timing.gametime_plain) ? (avg(timing.gametime_kernel) / avg(timing.gametime_plain)) : 0;
if (slower) {
  console.log(`\nOn the same Gametime pages, Kernel took ${slower.toFixed(1)}x the ladder's time.`);
  // WHICH LADDER STEP ANSWERED MATTERS MORE THAN THE RATIO. Kernel looks fast whenever the
  // ladder had to escalate to Firecrawl, and slow whenever plain HTTP answered on its own.
  // Quoting the ratio without this is how a POC talks itself into the wrong recommendation.
  console.log(`Ladder steps that answered Gametime: ${vias.join(', ') || 'none'}`);
}
console.log(`Kernel page loads: ${kernel.pages} for ${results.length} games (~${(kernel.pages / Math.max(results.length, 1)).toFixed(1)}/game).`);
if (costInfo) {
  const per = results.length ? costInfo.usd / results.length : 0;
  console.log(`
Kernel cost, measured: $${costInfo.usd} for ${results.length} games ($${per.toFixed(4)}/game)`);
  console.log(`  ${costInfo.memory_gb}GB x ${costInfo.seconds}s, ${costInfo.rate}`);
  console.log(`  extrapolated: ~$${(per * 100).toFixed(2)} per 100 games at this shape`);
  console.log('  The ladder and the plain API cost nothing per call by comparison (Firecrawl');
  console.log('  credits aside), so this is the premium Kernel charges for the sites it unlocks.');
}

const sitesPerGame = results.map(r => ['gametime_ladder', 'gametime_kernel', 'vivid_kernel'].filter(k => r.sites[k] && r.sites[k].ok).length);
const twoPlus = results.filter((_, i) => {
  const r = results[i];
  return (r.sites.gametime_kernel && r.sites.gametime_kernel.ok ? 1 : 0) + (r.sites.vivid_kernel && r.sites.vivid_kernel.ok ? 1 : 0) >= 2;
}).length;
console.log(`\nAcceptance: games with section-level prices from 2+ sites VIA KERNEL: ${twoPlus}/${results.length}`);

if (fails.length) { console.log('\n-- failures --'); for (const f of fails) console.log('  ' + f); }

const OUT = arg('out');
if (OUT) { writeFileSync(OUT, JSON.stringify({ games: results, timing, fails }, null, 1)); console.log(`\nwrote ${OUT}`); }

// --- sheet -----------------------------------------------------------------------------------

if (TO_SHEET) await writeSheet();

async function writeSheet() {
  const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
  const kj = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: kj.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signed = `${head}.${claims}`;
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(signed), String(kj.private_key).replace(/\\n/g, '\n')));
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signed}.${sig}` }),
  });
  if (!tr.ok) throw new Error('google token: ' + (await tr.text()).slice(0, 200));
  const token = (await tr.json()).access_token;
  const H = { Authorization: 'Bearer ' + token, 'content-type': 'application/json' };

  // A dated tab name, so a second run does not overwrite the first — the POC is a record of what
  // was true on a day, and the sites change under us.
  const title = `Kernel POC ${new Date().toISOString().slice(0, 10)}`;
  const add = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  if (!add.ok) {
    const t = await add.text();
    if (!t.includes('already exists')) throw new Error('addSheet: ' + t.slice(0, 300));
  }

  const rows = [];
  rows.push([`Kernel POC — section-level prices and zone tagging`, '', '', '', '', '', '', '']);
  rows.push([`run ${new Date().toISOString()}`, `${results.length} games`, `${kernel.pages} kernel page loads`]);
  rows.push([]);
  rows.push(['SIDE BY SIDE']);
  rows.push(['path', 'success', 'avg ms/game', 'section-level']);
  rows.push(['Gametime — existing ladder', rate(okCount('gametime_ladder'), results.length), avg(timing.gametime_plain), 'yes']);
  rows.push(['Gametime — Kernel', rate(okCount('gametime_kernel'), results.length), avg(timing.gametime_kernel), 'yes']);
  rows.push(['Vivid Seats — Kernel (unreachable without it)', rate(okCount('vivid_kernel'), results.length), avg(timing.vivid_kernel), 'yes']);
  if (costInfo) {
    const per = results.length ? costInfo.usd / results.length : 0;
    rows.push([]);
    rows.push(['COST (measured, this run)']);
    rows.push(['metric', 'value', 'note']);
    rows.push(['Kernel cost, this run', '$' + costInfo.usd, `${results.length} games, one browser session`]);
    rows.push(['per game', '$' + per.toFixed(4), '']);
    rows.push(['session memory', costInfo.memory_gb + ' GB', costInfo.memory_gb >= 8 ? 'headful (needed for replays) - 8x the headless rate' : 'headless']);
    rows.push(['session wall-clock', costInfo.seconds + ' s', 'billed on duration, not requests']);
    rows.push(['billed GB-seconds', costInfo.gb_seconds, costInfo.rate]);
    rows.push(['extrapolated per 100 games', '$' + (per * 100).toFixed(2), 'same shape, not a committed quote']);
    rows.push(['existing ladder', 'no per-call cost', 'plain HTTP; Firecrawl credits only when it escalates']);
    rows.push(['Gametime JSON API', 'no per-call cost', 'open over plain HTTP, ~1.1s/game']);
    rows.push(['Kernel plan', 'Free: $0/mo + usage, $5/mo credits', 'stealth, captcha solver and proxies included']);
  }
  rows.push([]);
  rows.push(['WALLS, measured 2026-10-07']);
  rows.push(['site', 'plain HTTP', 'Kernel stealth (free tier, datacenter IP)']);
  rows.push(['Gametime', 'open', 'works (but slower than plain)']);
  rows.push(['Vivid Seats', 'Imperva challenge', 'CLEARS — listings reachable']);
  rows.push(['TickPick', 'Cloudflare challenge', 'does not load after verification']);
  rows.push(['SeatGeek', '403 DataDome', 'does not clear']);
  rows.push(['StubHub', '403 DataDome', 'does not clear']);
  rows.push(['', '', 'residential proxy needs a paid plan']);
  rows.push([]);
  rows.push(['CHEAPEST LOWER-BOWL PRICE PER ZONE (all-in, USD)']);
  rows.push(['game', 'venue', 'site', 'path', 'listings', ...ZONES.map(z => z), ...ZONES.map(z => z + ' section'), 'url']);
  for (const r of results) {
    for (const [k, lbl] of [['gametime_ladder', 'Gametime / ladder-HTML'], ['gametime_api', 'Gametime / plain-API'], ['gametime_kernel', 'Gametime / Kernel'], ['vivid_kernel', 'Vivid Seats / Kernel']]) {
      const s = r.sites[k];
      if (!s || !s.ok) { rows.push([r.game, r.venue || '', lbl.split(' / ')[0], lbl.split(' / ')[1], s ? 'FAILED: ' + (s.why || '') : 'not run']); continue; }
      rows.push([
        r.game, r.venue || '', lbl.split(' / ')[0], lbl.split(' / ')[1], s.listings,
        ...ZONES.map(z => (s.bowl.zones[z] ? s.bowl.zones[z].all_in : '')),
        ...ZONES.map(z => (s.bowl.zones[z] ? s.bowl.zones[z].section : '')),
        s.url || '',
      ]);
    }
  }
  if (replayInfo) { rows.push([]); rows.push(['SESSION REPLAY', replayInfo.download_url]); }
  if (fails.length) { rows.push([]); rows.push(['FAILURES']); for (const f of fails) rows.push([f]); }

  // CLEAR THE TAB FIRST. values.update writes a block starting at A1 and leaves everything
  // outside it untouched, so a shorter run lands on top of a longer one and the leftovers read
  // as part of the new report — rows from two different runs interleaved, columns from the old
  // one trailing off the end of the new. Verified happening on this very tab.
  const clear = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(title)}:clear`, {
    method: 'POST', headers: H, body: '{}',
  });
  if (!clear.ok) throw new Error('clear tab: ' + (await clear.text()).slice(0, 200));

  const up = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(title + '!A1')}?valueInputOption=RAW`, {
    method: 'PUT', headers: H, body: JSON.stringify({ values: rows }),
  });
  if (!up.ok) throw new Error('values.update: ' + (await up.text()).slice(0, 300));
  console.log(`\nwrote tab "${title}" to https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
}
