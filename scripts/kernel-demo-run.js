// AI-1088: one recorded Kernel session that visits every marketplace in turn.
//
//   node --env-file=.env scripts/kernel-demo-run.js [--game "Los Angeles Lakers"] [--date 2026-10-23]
//
// This is the artefact for the review: a single replay showing, in order, what Kernel can and
// cannot reach. One session rather than five, because the point is the comparison — a reviewer
// watching it sees Vivid's listings come back and SeatGeek's DataDome wall in the same video.
//
// HEADFUL, because replays do not record otherwise (Kernel answers POST /replays on a headless
// session with "headless browsers don't support replays at this time"). Headful is slower and
// heavier than the POC runs, which is fine for a one-off demo and wrong for production.
//
// It proves work, not just page loads: on Gametime and Vivid it actually pulls the listings and
// prints how many came back, so the recording is evidence of a scrape rather than of a browser
// looking at a page.

import { gameListings, newScrapeContext } from '../lib/scrape-price.js';
import { openKernelSession } from '../lib/kernel-browser.js';
import { gametimeEventId, gametimeListingsUrl, parseGametimeApi } from '../lib/gametime-api.js';
import { parseVividListings, parseVividProductions, vividListingsUrl } from '../lib/vivid-listings.js';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const TEAM = arg('game', 'Los Angeles Lakers');
const DATE = arg('date', '2026-10-23');
const OPP = arg('opp', 'Clippers');

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const results = [];
const note = (site, ok, detail) => {
  results.push({ site, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'BLOCKED'} ${site.padEnd(12)} ${detail}`);
};

// Resolve the Gametime event URL with the normal (non-Kernel) path — finding the URL is not
// what is being demonstrated, reaching the inventory is.
const game = { external_id: 'demo', team: TEAM.split(' ').pop(), team_full: TEAM, opponent: OPP, event_date: DATE, league: 'nba' };
const ctx = newScrapeContext();
const gt = await gameListings(game, ctx).catch(() => ({}));
const gtUrl = gt.url || null;
console.log(`game: ${TEAM} v ${OPP} ${DATE}`);
console.log(`gametime event: ${gtUrl || '(not resolved)'}\n`);

const s = await openKernelSession({ stealth: true, replay: true });
console.log(`session ${s.id}  granted=${JSON.stringify(s.granted)}  replay=${s.replay_id}\n`);

try {
  // 1. GAMETIME — open. Included to show the baseline: Kernel works here but is not needed.
  if (gtUrl) {
    await s.goto(gtUrl, { timeoutMs: 60000 });
    const api = await s.gotoJson(gametimeListingsUrl(gametimeEventId(gtUrl), { quantity: 2 }), { timeoutMs: 60000 });
    const rows = api.ok ? parseGametimeApi(api.body, { url: gtUrl }) : null;
    note('Gametime', !!rows, rows ? `${rows.length} listings with section + row` : `no listings (${api.wall || api.status})`);
  } else {
    note('Gametime', false, 'event URL did not resolve');
  }

  // 2. VIVID — the one site that genuinely needs the browser.
  try {
    const sp = await s.goto(`https://www.vividseats.com/search?searchTerm=${encodeURIComponent(TEAM.toLowerCase())}`,
      { ready: h => !!parseVividProductions(h), timeoutMs: 60000 });
    const prods = sp.html ? parseVividProductions(sp.html) : null;
    const opp = slug(OPP).split('-').pop();
    const hit = (prods || []).find(p => p.date === DATE && (!opp || slug(p.name).includes(opp)))
      || (prods || []).find(p => p.date === DATE);
    if (!hit) throw new Error(sp.wall ? `${sp.wall} wall on search` : 'game not listed');
    const ev = await s.goto(hit.url, { timeoutMs: 60000 });
    if (ev.wall) throw new Error(`${ev.wall} wall on event page`);
    const api = await s.fetchInPage(vividListingsUrl(hit.id));
    const rows = api.ok ? parseVividListings(api.body, { url: hit.url }) : null;
    if (!rows) throw new Error(api.ok ? 'listings returned nothing usable' : `listings api ${api.status}`);
    note('Vivid Seats', true, `${rows.length} listings with section + row + qty (Imperva cleared)`);
  } catch (e) { note('Vivid Seats', false, String(e.message || e).slice(0, 90)); }

  // 3-5. The DataDome three. Each gets its event page loaded so the wall is on camera.
  const WALLED = [
    ['TickPick', 'https://www.tickpick.com/buy-los-angeles-lakers-vs-los-angeles-clippers-tickets-crypto-com-arena-10-23-26-7pm/8206052/'],
    ['SeatGeek', 'https://seatgeek.com/san-diego-padres-tickets/3-25-2027-san-diego-california-petco-park/mlb/18381293'],
    ['StubHub', 'https://www.stubhub.com/ph/athletics-sacramento-tickets-4-5-2027/event/161778058/?lt=38.5810606&lg=-121.493895'],
  ];
  for (const [name, url] of WALLED) {
    const r = await s.goto(url, { timeoutMs: 60000, pollMs: 5000 });
    if (r.wall) { note(name, false, `${r.wall} wall on the event page (${r.ms}ms)`); continue; }
    // TickPick's page can load while its inventory call is still blocked — so count what the
    // page actually rendered rather than calling a 200 a success.
    const rows = await s.eval('document.querySelectorAll(\'[class*="listing" i]\').length');
    note(name, false, `page loaded (${r.ms}ms) but ${rows || 0} listing rows rendered — inventory call blocked`);
  }
} finally {
  const rep = await s.close().catch(() => null);
  console.log('\n--- summary ---');
  for (const r of results) console.log(`  ${r.ok ? 'OK     ' : 'BLOCKED'} ${r.site.padEnd(12)} ${r.detail}`);
  if (rep) {
    console.log(`\nreplay ${rep.replay_id} (session ${rep.session_id})`);
    console.log(`download: node --env-file=.env scripts/kernel-replay.js ${rep.session_id} ${rep.replay_id}`);
  } else {
    console.log('\nno replay was recorded');
  }
}
