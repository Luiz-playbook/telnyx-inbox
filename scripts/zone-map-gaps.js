// AI-1098: find the sections the marketplaces list that the section map cannot place, and
// write them out in the sheet's own column order so they can be pasted in and filled.
//
//   node --env-file=.env scripts/zone-map-gaps.js --teams 20 --from 2026-10-20 --csv gaps.csv
//
// WHY THIS EXISTS. "Fill gaps for any NBA team or tier missing from the map" is the one item on
// the ticket that needs a person: the pipeline can say WHICH sections it could not place, but
// not which ring they belong to. Guessing is explicitly out — a listing mislabelled 'center
// court' is a wrong price in a customer's inbox.
//
// So this does the half a machine can do. It collects every unmapped section seen on real
// listings, counts how often each appeared, and proposes a zone ONLY where the arena already has
// a row for the same bare number (Orlando '109A' next to its '109'). The proposal is a separate
// column, clearly labelled, and the Zone column is left EMPTY for a human — a suggestion that
// quietly became the answer is the failure this is trying to avoid.
//
// Confidence is pre-filled Medium, which is what the ticket asks for on anything added by hand.

import { writeFileSync } from 'node:fs';
import { bestGameListings, newScrapeContext } from '../lib/scrape-price.js';
import { loadZoneIndex, matchZone, normSection } from '../lib/section-zones.js';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const TEAMS = Number(arg('teams', 20));
const FROM = arg('from', new Date().toISOString().slice(0, 10));
const CSV = arg('csv', 'zone-map-gaps.csv');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const H = { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY };

const index = await loadZoneIndex(SUPA_URL, SUPA_KEY);
if (!index) throw new Error('no section map — run scripts/load-section-zones.js --league nba');

// What the map already knows per team, so a proposal can be grounded in a real neighbour row.
const known = new Map();   // teamKey -> Map(section -> {zone, tier, tier_class})
for (const [team, sections] of index.byTeam) known.set(team, sections);

const qs = new URLSearchParams({
  select: 'external_id,event_date,team,team_full,opponent,venue',
  league: 'eq.nba', event_date: 'gte.' + FROM, order: 'event_date.asc', limit: '300',
});
const r0 = await fetch(`${SUPA_URL}/rest/v1/events_master?${qs}`, { headers: H });
if (!r0.ok) throw new Error('events_master ' + r0.status);
const seenTeam = new Set();
const games = (await r0.json())
  .filter(g => { const k = g.team_full || g.team; if (seenTeam.has(k)) return false; seenTeam.add(k); return true; })
  .slice(0, TEAMS);

console.log(`${games.length} games, one per team, from ${FROM}\n`);

const gaps = new Map();   // team|section -> { team, arena, section, n }
const ctx = newScrapeContext();

for (const g of games) {
  let got;
  try { got = await bestGameListings(g, ctx); } catch { continue; }
  if (!got || !got.listings.length) { console.log(`  -- ${g.team_full}: no listings`); continue; }
  let miss = 0;
  for (const l of got.listings) {
    const m = matchZone(index, { ...l, team_full: g.team_full, team: g.team });
    if (!m.unmapped) continue;
    const sec = normSection(l.section);
    if (!sec) continue;
    miss++;
    const key = `${g.team_full}|${sec}`;
    const row = gaps.get(key) || { team: g.team_full, arena: g.venue || '', section: sec, n: 0 };
    row.n++; gaps.set(key, row);
  }
  console.log(`  ${g.team_full.padEnd(24)} ${got.listings.length} listings, ${miss} unmapped`);
}

// NOT ALL GAPS ARE WORTH THE SAME. The map covers the rings a premium offer quotes from; it has
// no 200- or 300-level rows at all, by design. So a missing '310' is the map working as intended
// and a missing '109A' is a real hole next to a seat we might quote. Sorting by that first means
// the rows that matter are at the top instead of buried under three hundred upper-deck sections.
const priority = sec => {
  const m = String(sec).match(/^([A-Z]{0,2})(\d{1,3})([A-Z]{0,2})$/);
  if (!m) return { rank: 1, why: 'lettered section — likely club, suite or floor' };
  const n = Number(m[2]);
  const lettered = !!(m[1] || m[3]);
  if (n <= 199 && lettered) return { rank: 0, why: 'LOWER BOWL variant — premium relevant' };
  if (n <= 199) return { rank: 0, why: 'LOWER BOWL number — premium relevant' };
  if (n < 300) return { rank: 2, why: '200 level — map has no mid tier' };
  return { rank: 3, why: '300 level — upper deck, not quoted' };
};

// A proposal only where the same arena already maps the bare number this section is built on.
const baseOf = s => { const m = String(s).match(/^[A-Z]{0,2}(\d{1,3})[A-Z]{0,2}$/); return m ? m[1] : null; };
const rows = [...gaps.values()]
  .map(r => ({ ...r, p: priority(r.section) }))
  .sort((a, b) => a.p.rank - b.p.rank || b.n - a.n || a.team.localeCompare(b.team));

const out = [['Team', 'Arena', 'Tier', 'Section', 'Zone', 'Source', 'Confidence', 'priority', 'seen', 'suggested zone (NOT authoritative)', 'basis']];
for (const r of rows) {
  const teamKey = r.team.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const sections = known.get(teamKey);
  const base = baseOf(r.section);
  const neighbour = base && sections ? sections.get(base) : null;
  out.push([
    r.team, r.arena, '', r.section,
    '',                                   // Zone — for a human
    'Added by hand after a live spot check', 'Medium',
    r.p.why,
    r.n,
    neighbour ? neighbour.zone : '',
    neighbour ? `same arena maps section ${base} as ${neighbour.zone} (${neighbour.tier})` : 'no neighbouring row — needs a look at the arena map',
  ]);
}

const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
writeFileSync(CSV, out.map(r => r.map(esc).join(',')).join('\n'));

const withSuggestion = rows.filter(r => {
  const sections = known.get(r.team.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  const b = baseOf(r.section); return b && sections && sections.get(b);
}).length;

const byRank = {};
for (const r of rows) byRank[r.p.why] = (byRank[r.p.why] || 0) + 1;
console.log(`\n${rows.length} distinct unmapped sections across ${games.length} arenas`);
for (const [why, n] of Object.entries(byRank).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`);
const premium = rows.filter(r => r.p.rank <= 1).length;
console.log(`\n  ${premium} are premium-relevant — do these first`);
console.log(`  ${withSuggestion} of all rows have a neighbouring row to suggest from`);
console.log(`\nwrote ${CSV} — paste columns A-G into the sheet's "By Section" tab and fill Zone.`);
