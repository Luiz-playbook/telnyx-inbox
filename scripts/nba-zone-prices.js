// AI-1098: zone-tag every NBA listing and report the cheapest lower-bowl price per zone.
//
//   node --env-file=.env scripts/nba-zone-prices.js --map zones.json --games 15
//   node --env-file=.env scripts/nba-zone-prices.js --map zones.json --teams 15 --csv out.csv
//
// This is the acceptance evidence for the ticket, computed rather than eyeballed:
//   * every listing carries a zone or an unmapped flag
//   * each game shows the cheapest lower-bowl price per zone
//   * the unmapped rate for lower-bowl listings, against the "under 5%" bar
//   * one game per team, so the 15-team spot check is a filter on this output
//
// --map takes the JSON snapshot from `scripts/load-section-zones.js --out`. The matcher is
// source-agnostic on purpose, so this runs with no database and no migration applied; point it
// at public.venue_section_zones instead once 106 is in.
//
// SOURCE IS GAMETIME ONLY, TODAY. It is the only marketplace that serves per-seat sections to a
// plain request. TickPick, SeatGeek and StubHub wall their event pages, and Vivid's needs the
// Kernel step (AI-1097, lib/kernel-browser.js) — so a second source arrives behind that work,
// not this script.

import { readFileSync, writeFileSync } from 'node:fs';
import { gameListings, newScrapeContext } from '../lib/scrape-price.js';
import { buildZoneIndex, matchZone, cheapestByZone, ZONES } from '../lib/section-zones.js';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};

const MAP = arg('map');
const WANT_GAMES = Number(arg('games', 0));
const WANT_TEAMS = Number(arg('teams', 0));
const CSV = arg('csv');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
if (!MAP) throw new Error('--map <zones.json> is required (scripts/load-section-zones.js --out)');
if (!SUPA_URL || !SUPA_KEY) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY needed to list games');

// WHICH UNMAPPED LISTINGS COUNT AGAINST THE 5% BAR.
//
// The map covers the rings RateYourSeats labels: the lower bowl, the floor, the clubs and a
// couple of mezzanines. It has no 200- or 300-level rows at all, by design — nobody quotes a
// premium offer off the upper deck. So an unmapped "322" is the map working as intended, while an
// unmapped "118" is a real gap, and averaging the two together produces a number that means
// nothing. The ticket's bar is explicitly "under 5% of LOWER-BOWL listings", so only
// lower-bowl-looking sections form the denominator:
//
//   100-199        the 100 level
//   1-99           the '00' style arenas (Barclays, TD Garden Loge, Gainbridge, Intuit Dome)
//   either + a tier letter   101L, 106CT, F9
//
// 200s and 300s are counted and reported separately as out of scope, never hidden.
const looksLowerBowl = raw => {
  const m = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^([A-Z]{0,2})(\d{1,3})([A-Z]{0,2})$/);
  if (!m) return false;
  const n = Number(m[2]);
  return (n >= 1 && n <= 199);
};

const index = buildZoneIndex(JSON.parse(readFileSync(MAP, 'utf8')));
console.log(`zone map: ${index.size} rows, ${index.byTeam.size} team keys\n`);

// Upcoming NBA home games. team_full is the HOME team, which is what the arena — and so the
// section map — is keyed on.
const today = new Date().toISOString().slice(0, 10);
const qs = new URLSearchParams({
  select: 'external_id,event_date,team,team_full,opponent,venue,league',
  league: 'eq.nba',
  event_date: 'gte.' + today,
  order: 'event_date.asc',
  limit: '400',
});
const res = await fetch(`${SUPA_URL}/rest/v1/events_master?${qs}`, {
  headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
});
if (!res.ok) throw new Error(`events_master ${res.status}: ${(await res.text()).slice(0, 200)}`);
let games = await res.json();

// One game per team when --teams is given: the spot check is about arena coverage, so fifteen
// games at the same arena would prove nothing.
if (WANT_TEAMS) {
  const seen = new Set();
  games = games.filter(g => {
    const k = g.team_full || g.team;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, WANT_TEAMS);
} else if (WANT_GAMES) {
  // --skip steps past the next few days. Games tipping off today are routinely gone from
  // Gametime or down to scraps, which measures the schedule rather than the pipeline.
  games = games.slice(Number(arg('skip', 0)), Number(arg('skip', 0)) + WANT_GAMES);
}
if (!games.length) throw new Error('no upcoming NBA games in events_master');
console.log(`${games.length} games\n`);

const ctx = newScrapeContext();
const rows = [];
const totals = { listings: 0, mapped: 0, unmapped: 0, lowerMapped: 0, lowerUnmapped: 0, outOfScope: 0 };
const missReasons = new Map();

for (const g of games) {
  const label = `${g.team_full || g.team} v ${g.opponent} ${g.event_date}`;
  let got;
  try { got = await gameListings(g, ctx); } catch (e) { console.log(`  !! ${label}: ${e.message}`); continue; }
  if (!got.listings.length) {
    console.log(`  -- ${label}: ${got.fail ? (got.fail.error || got.fail.kind) : 'no listings'}`);
    continue;
  }

  // Every listing gets a verdict. That is the first acceptance criterion and it is also what
  // makes the unmapped rate below trustworthy — nothing is quietly dropped before counting.
  const tagged = got.listings.map(l => ({ ...l, ...matchZone(index, { ...l, team_full: g.team_full, team: g.team }) }));

  for (const t of tagged) {
    totals.listings++;
    if (t.unmapped) {
      totals.unmapped++;
      missReasons.set(t.raw_section, (missReasons.get(t.raw_section) || 0) + 1);
    } else {
      totals.mapped++;
      if (t.tier_class === 'lower_bowl') totals.lowerMapped++;
    }
  }
  const lowerish = tagged.filter(t => t.unmapped && looksLowerBowl(t.matched_section || t.raw_section));
  totals.lowerUnmapped += lowerish.length;
  totals.outOfScope += tagged.filter(t => t.unmapped && !looksLowerBowl(t.matched_section || t.raw_section)).length;

  const bowl = cheapestByZone(tagged, { rings: ['lower_bowl'] });
  const all = cheapestByZone(tagged, { rings: [] });

  console.log(`${label}`);
  console.log(`   ${tagged.length} listings (of ${got.total}; dropped ${got.dropped_standing} standing, ${got.dropped_zone} zone) via ${got.via}`);
  for (const z of ZONES) {
    const b = bowl.zones[z], a = all.zones[z];
    const show = b
      ? `$${b.all_in} all-in  sec ${b.section}${b.row ? ' row ' + b.row : ''}  [${b.confidence}]`
      : (a ? `(no lower bowl; cheapest anywhere $${a.all_in} sec ${a.section})` : '-');
    console.log(`     ${z.padEnd(14)} ${show}`);
  }
  console.log(`     unmapped ${bowl.unmapped}/${tagged.length}`);

  rows.push({ game: label, external_id: g.external_id, venue: g.venue, url: got.url, listings: tagged.length, bowl, all });
}

// --- summary ---------------------------------------------------------------------------------

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
console.log('\n================ summary ================');
console.log(`games with listings : ${rows.length}/${games.length}`);
console.log(`listings tagged     : ${totals.listings}`);
console.log(`  mapped            : ${totals.mapped} (${pct(totals.mapped, totals.listings)}%)`);
console.log(`  unmapped          : ${totals.unmapped} (${pct(totals.unmapped, totals.listings)}%)`);
console.log(`    lower-bowl-looking : ${totals.lowerUnmapped}  <- these count against the bar`);
console.log(`    200s/300s (map has no upper rings, by design): ${totals.outOfScope}`);
console.log(`lower-bowl mapped   : ${totals.lowerMapped}`);
const bar = pct(totals.lowerUnmapped, totals.lowerMapped + totals.lowerUnmapped);
console.log(`\nlower-bowl unmapped : ${bar}%  ${bar < 5 ? 'PASS (<5%)' : 'FAIL (>=5%)'}`);

const withCentre = rows.filter(r => r.bowl.zones['center court']).length;
console.log(`games quoting center court from lower bowl: ${withCentre}/${rows.length}`);
console.log(`scrape: ${ctx.stats.pages} pages, via ${JSON.stringify(ctx.stats.byVia)}, firecrawl ${ctx.firecrawlCalls}, kernel ${ctx.kernelCalls}`);

if (missReasons.size) {
  console.log('\n-- most common unmapped sections (fix these in the sheet) --');
  for (const [sec, n] of [...missReasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(4)}x  "${sec}"`);
  }
}

if (CSV) {
  const head = ['game', 'venue', 'listings', ...ZONES.map(z => z + ' $'), ...ZONES.map(z => z + ' section'), 'url'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    lines.push([
      cell(r.game), cell(r.venue), r.listings,
      ...ZONES.map(z => r.bowl.zones[z] ? r.bowl.zones[z].all_in : ''),
      ...ZONES.map(z => r.bowl.zones[z] ? r.bowl.zones[z].section : ''),
      cell(r.url),
    ].join(','));
  }
  writeFileSync(CSV, lines.join('\n'));
  console.log(`\nwrote ${rows.length} rows to ${CSV}`);
}
