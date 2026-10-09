// AI-1097: is StubHub's 8-listing ceiling real, or did we filter it ourselves?
//
//   node --env-file=.env scripts/stubhub-quantity-probe.js
//
// THE CLAIM THIS TESTS. The POC concluded StubHub shows "a curated shortlist, not an inventory"
// — 8 distinct listings — and treated that as a real ceiling because Apify independently
// returned 8 on the same URL. Two methods agreeing is good evidence, UNLESS both share the same
// mistake. And they might: the URL carried `?quantity=2`.
//
// StubHub asks how many seats you want before it shows anything, and ours defaulted to 2. A
// quantity filter does not trim the list cosmetically — it excludes every listing that cannot
// seat two together, which on a resale marketplace is a large share of the cheap inventory.
// Apify was handed the same URL, so it would have inherited the same filter. "Independent
// methods" is only independent if the input differs.
//
// Second variable, same blind spot: the panel LAZY-LOADS. Counting what is on screen after
// first paint counts one viewport, not the inventory.
//
// So: three URL variants x scroll-until-it-stops-growing, one session, same page each time.
// Headful and no proxy, because that is the only configuration StubHub answers at all.

import { openKernelSession } from '../lib/kernel-browser.js';
import { STUBHUB_CARD_EXPR, parseStubhubCards } from '../lib/stubhub-listings.js';

const EVENT = 'https://www.stubhub.com/ph/athletics-sacramento-tickets-4-5-2027/event/161778058/';
const VARIANTS = [
  { label: 'quantity=2 (what the POC used)', url: EVENT + '?quantity=2' },
  { label: 'quantity=1', url: EVENT + '?quantity=1' },
  { label: 'no quantity param', url: EVENT },
];

// What the page is showing about quantity, so a difference in counts can be attributed rather
// than guessed at. Looks for the control, the modal, and any "N tickets" text.
const STATE_EXPR = `JSON.stringify({
  rows: [...document.querySelectorAll('div,li,a')].filter(n => /^Section\s+\S+\s+Row\s+/i.test((n.innerText||'').trim())).length,
  dialogs: [...document.querySelectorAll('[role="dialog"],dialog')].map(n => (n.innerText||'').replace(/\s+/g,' ').trim().slice(0,110)),
  qtyText: (document.body.innerText.match(/\b(?:any|\d+)\s*(?:\+\s*)?tickets?\b/gi) || []).slice(0,6),
  selects: [...document.querySelectorAll('select')].map(s => ({ name: s.name || s.id || '', value: s.value })),
  docH: document.documentElement.scrollHeight,
})`;

// Scroll the thing that actually scrolls. The listings sit in an inner pane on this page, so
// scrolling the window alone loads nothing — find the tallest scrollable element and drive that,
// falling back to the window.
const SCROLL_EXPR = `(() => {
  const panes = [...document.querySelectorAll('div,section,main,ul')]
    .filter(n => n.scrollHeight > n.clientHeight + 200 && n.clientHeight > 200);
  const pane = panes.sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight))[0];
  if (pane) { pane.scrollTop = pane.scrollHeight; return JSON.stringify({ how: 'pane', top: pane.scrollTop, h: pane.scrollHeight }); }
  window.scrollTo(0, document.body.scrollHeight);
  return JSON.stringify({ how: 'window', top: window.scrollY, h: document.body.scrollHeight });
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const parse = async s => parseStubhubCards(JSON.parse(await s.eval(STUBHUB_CARD_EXPR) || '[]'));

const s = await openKernelSession({
  stealth: true, headless: false, replay: true,
  name: ['ai1097', 'stubhub', 'quantity-scroll'],
  tags: { ticket: 'AI-1097', run: 'stubhub-quantity', site: 'stubhub' },
});
console.log('session', s.id, '| name', s.granted.name, '| headful', !s.granted.headless);
if (s.live_view_url) console.log('live view', s.live_view_url);

const results = [];
try {
  for (const v of VARIANTS) {
    console.log(`\n=== ${v.label} ===`);
    const page = await s.goto(v.url, { timeoutMs: 75000, pollMs: 5000 });
    if (page.wall) { console.log(`  blocked: ${page.wall}`); results.push({ ...v, wall: page.wall }); continue; }

    const st = JSON.parse(await s.eval(STATE_EXPR) || '{}');
    let listings = await parse(s);
    console.log(`  first paint: ${st.rows} dom rows -> ${listings.length} parsed listings`);
    if (st.dialogs && st.dialogs.length) console.log(`  dialog on screen: ${JSON.stringify(st.dialogs)}`);
    if (st.qtyText && st.qtyText.length) console.log(`  quantity wording: ${JSON.stringify(st.qtyText)}`);
    if (st.selects && st.selects.length) console.log(`  selects: ${JSON.stringify(st.selects)}`);

    // Scroll until two passes in a row add nothing. A fixed number of scrolls would either stop
    // early or waste a minute on a page that finished.
    let before = -1, stable = 0, passes = 0;
    while (stable < 2 && passes < 12) {
      const how = JSON.parse(await s.eval(SCROLL_EXPR) || '{}');
      await sleep(1600);
      listings = await parse(s);
      if (listings.length === before) stable++; else { stable = 0; before = listings.length; }
      passes++;
      process.stdout.write(`  scroll ${String(passes).padStart(2)} (${how.how}) -> ${listings.length} listings\r`);
    }
    console.log(`\n  after ${passes} scrolls: ${listings.length} parsed listings`);

    const qty = listings.map(l => l.quantity).filter(q => q != null);
    results.push({ ...v, listings: listings.length, scrolls: passes,
      sections: new Set(listings.map(l => l.section)).size,
      minQty: qty.length ? Math.min(...qty) : null,
      sample: listings.slice(0, 3).map(l => `${l.section}/${l.row} $${l.price ?? '?'} x${l.quantity ?? '?'}`) });
  }
} finally {
  console.log('\ncost', JSON.stringify(s.cost()));
  const rep = await s.close().catch(() => null);
  if (rep) console.log(`replay: node --env-file=.env scripts/kernel-replay.js ${rep.session_id} ${rep.replay_id}`);
}

console.log('\n================ result ================');
console.log('  variant'.padEnd(34) + 'listings  sections  min qty');
for (const r of results) {
  console.log('  ' + r.label.padEnd(32)
    + String(r.wall ? r.wall : r.listings).padEnd(10)
    + String(r.sections ?? '-').padEnd(10) + String(r.minQty ?? '-'));
}
for (const r of results) if (r.sample) console.log(`\n  ${r.label}: ${r.sample.join(' | ')}`);
