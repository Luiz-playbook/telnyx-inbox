// AI-1098: fill events_master.zone_prices for games that have none, as a one-off.
//
//   node --env-file=.env scripts/backfill-zone-prices.js --dry --limit 10
//   node --env-file=.env scripts/backfill-zone-prices.js --limit 40
//
// DELIBERATELY NOT WIRED INTO THE REFRESH. api/price-refresh.js can already compute zones on
// every run, but turning that on changes a production job. This writes the same data by hand so
// the Ticket Prices tab has something real to show while that decision is still open.
//
// IT WRITES ONE COLUMN. A PATCH on zone_prices only — not set_event_prices, which would also
// rewrite best_price, price_source, price_candidates and priced_at from a scrape taken now. The
// point is to add zones to existing rows, not to re-price the slate behind someone's back.
//
// Only games that have none are touched, so re-running it is safe and resumable.

import { bestGameListings, newScrapeContext } from '../lib/scrape-price.js';
import { loadZoneIndex, matchZone, cheapestByZone, zonesForLeague } from '../lib/section-zones.js';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const DRY = process.argv.includes('--dry');
const LIMIT = Number(arg('limit', 25));
const LEAGUE = (arg('league', 'nba')).toLowerCase();
const FROM = arg('from', new Date().toISOString().slice(0, 10));

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
if (!zonesForLeague(LEAGUE)) throw new Error(`no zone vocabulary for "${LEAGUE}"`);

const H = { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'content-type': 'application/json' };

const index = await loadZoneIndex(SUPA_URL, SUPA_KEY);
if (!index) throw new Error('no section map — run scripts/load-section-zones.js --league ' + LEAGUE);
console.log(`zone map: ${index.size} rows\n`);

// Only games with no zones yet, soonest first — those are the ones a marketplace still lists.
const qs = new URLSearchParams({
  select: 'id,external_id,event_date,team,team_full,opponent,venue,league',
  league: 'eq.' + LEAGUE,
  event_date: 'gte.' + FROM,
  zone_prices: 'is.null',
  order: 'event_date.asc',
  limit: String(LIMIT),
});
const r0 = await fetch(`${SUPA_URL}/rest/v1/events_master?${qs}`, { headers: H });
if (!r0.ok) throw new Error(`events_master ${r0.status}: ${(await r0.text()).slice(0, 200)}`);
const games = await r0.json();
console.log(`${games.length} ${LEAGUE.toUpperCase()} games from ${FROM} with no zone_prices\n`);

const ctx = newScrapeContext();
let written = 0, empty = 0, failed = 0;

for (const g of games) {
  const label = `${g.team_full || g.team} v ${g.opponent} ${g.event_date}`;
  let got;
  try { got = await bestGameListings(g, ctx); } catch (e) { failed++; console.log(`  !! ${label}: ${e.message}`); continue; }
  if (!got || !got.listings.length) {
    empty++;
    console.log(`  -- ${label}: ${(got && got.fail && (got.fail.error || got.fail.kind)) || 'no listings'}`);
    continue;
  }

  const tagged = got.listings.map(l => ({ ...l, ...matchZone(index, { ...l, team_full: g.team_full, team: g.team }) }));
  const bowl = cheapestByZone(tagged, { rings: ['lower_bowl'] });
  const zones = bowl.zones;
  if (!Object.keys(zones).length) {
    empty++;
    console.log(`  -- ${label}: ${tagged.length} listings but none in the lower bowl`);
    continue;
  }

  const line = Object.entries(zones).map(([z, v]) => `${z.split(' ')[0]} $${v.all_in}`).join('  ');
  console.log(`  ${DRY ? '[dry] ' : ''}${label}  via ${got.via}  ${tagged.length} listings  ${line}`);
  if (DRY) { written++; continue; }

  const up = await fetch(`${SUPA_URL}/rest/v1/events_master?id=eq.${encodeURIComponent(g.id)}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ zone_prices: zones }),
  });
  if (!up.ok) { failed++; console.log(`     write failed: ${up.status} ${(await up.text()).slice(0, 140)}`); continue; }
  written++;
}

console.log(`\n${DRY ? 'would write' : 'wrote'} ${written} · no usable listings ${empty} · failed ${failed}`);
if (DRY) console.log('--dry: nothing written.');
