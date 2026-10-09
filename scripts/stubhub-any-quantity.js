// AI-1097: StubHub's quantity filter defaults to 2, and "Any" was never selected.
//
//   node --env-file=.env scripts/stubhub-any-quantity.js [eventUrl]
//
// WHAT THIS CHASES. The POC reported StubHub as "a curated shortlist, not an inventory" — ~8-10
// listings against Gametime's ~220 — and called that a real ceiling because Apify independently
// returned the same count. But both were handed a URL carrying `?quantity=2`, and StubHub opens
// every event with a blocking "How many tickets? You'll be seated together" dialog whose default
// is 2. Every listing we have ever parsed from StubHub has quantity exactly 2.
//
// A quantity filter is not cosmetic: it drops every listing that cannot seat that many TOGETHER,
// which on a resale marketplace is most of the single seats and odd lots. The dropdown behind
// that dialog has an "Any" option. Nothing has ever clicked it, so "two independent methods
// agree on 8" may just be two methods inheriting one filter.
//
// So this walks the page the way a person does: dismiss the dialog, set quantity to Any, scroll
// until the count stops growing, count again. If Any returns the same ~10, the ceiling is real
// and the POC's conclusion stands. If it returns many more, the ceiling was ours.

import { openKernelSession } from '../lib/kernel-browser.js';
import { STUBHUB_CARD_EXPR, parseStubhubCards } from '../lib/stubhub-listings.js';

const EVENT = process.argv[2]
  || 'https://www.stubhub.com/ph/athletics-sacramento-tickets-4-5-2027/event/161778058/?quantity=2';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Clicks by VISIBLE TEXT rather than by selector. StubHub's class names are generated hashes
// that churn on every deploy (bway-jTBMCa), so a selector written today breaks next week; the
// words a customer reads are the stable part. Reports what it actually clicked, because a
// silent no-op would otherwise look exactly like "Any made no difference".
function clickByText(want, opts) {
  const exact = !!(opts && opts.exact);
  const tags = (opts && opts.tags) || 'button,[role="option"],[role="menuitem"],li,a,div';
  return '(() => { try {'
    + '  const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);'
    + '    return r.width > 8 && r.height > 8 && s.visibility !== "hidden" && s.display !== "none"; };'
    + '  const want = ' + JSON.stringify(want) + ';'
    + '  const hits = [...document.querySelectorAll(' + JSON.stringify(tags) + ')].filter(n => {'
    + '    if (!vis(n)) return false;'
    + '    const t = (n.innerText || n.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();'
    + '    return ' + (exact ? 't.toLowerCase() === want.toLowerCase()' : 't.toLowerCase().includes(want.toLowerCase())') + ';'
    + '  });'
    // The innermost match: a wrapper div can "contain" the text while the clickable thing is
    // nested three levels down, and clicking the wrapper does nothing at all.
    + '  const el = hits.filter(n => !hits.some(o => o !== n && n.contains(o))).pop();'
    + '  if (!el) return JSON.stringify({ clicked: false, candidates: hits.length });'
    + '  el.click();'
    + '  return JSON.stringify({ clicked: true, tag: el.tagName,'
    + '    text: (el.innerText || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60) });'
    + '} catch (e) { return JSON.stringify({ clicked: false, err: String(e && e.message || e) }); } })()';
}

const STATE = '(() => { try {'
  + '  const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);'
  + '    return r.width > 40 && r.height > 20 && s.visibility !== "hidden" && s.display !== "none"; };'
  + '  return JSON.stringify({'
  + '    dialogs: [...document.querySelectorAll("[role=\'dialog\'],[aria-modal=\'true\'],dialog")].filter(vis)'
  + '      .map(n => (n.innerText||"").replace(/\\s+/g," ").trim().slice(0,90)),'
  + '    qtyShown: [...document.querySelectorAll("button,[role=\'combobox\']")].filter(vis)'
  + '      .map(n => (n.innerText || n.getAttribute("aria-label") || "").replace(/\\s+/g," ").trim())'
  + '      .filter(x => /^(any|\\d+\\s*ticket)/i.test(x)).slice(0,4),'
  // The <select> is the source of truth; the chip is a styled mirror of it that can lag.
  + '    selValue: (() => { const s = [...document.querySelectorAll("select")]'
  + '      .find(x => /number of tickets/i.test(x.getAttribute("aria-label")||"")); '
  + '      return s ? s.value + "=" + ((s.options[s.selectedIndex]||{}).textContent||"").trim() : null; })(),'
  + '  });'
  + '} catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); } })()';

// Scroll the thing that actually scrolls — the listings sit in an inner pane, so driving the
// window alone loads nothing.
const SCROLL = '(() => {'
  + '  const panes = [...document.querySelectorAll("div,section,main,ul")]'
  + '    .filter(n => n.scrollHeight > n.clientHeight + 200 && n.clientHeight > 200);'
  + '  const pane = panes.sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight))[0];'
  + '  if (pane) { pane.scrollTop = pane.scrollHeight; return "pane"; }'
  + '  window.scrollTo(0, document.body.scrollHeight); return "window";'
  + '})()';

// Printed only when the Any selection fails, so the next attempt has the real markup to work
// from rather than another guess at a text label.
// A backtick template so the selector's own quotes need no escaping. The previous version
// built it by string concatenation and the nested quotes collapsed into a syntax error that
// `node --check` waved through — it parses a .js file as CommonJS, where top-level await is
// already invalid, so it never reached the real problem. Run the script, do not just check it.
const DUMP = `(() => { try {
  const sel = 'select,[role="combobox"],[role="listbox"],[aria-haspopup]';
  const out = [];
  for (const n of document.querySelectorAll(sel)) {
    const t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!/any|ticket/i.test(t)) continue;
    out.push({ tag: n.tagName, role: n.getAttribute('role'),
      expanded: n.getAttribute('aria-expanded'),
      text: t.slice(0, 120), html: n.outerHTML.slice(0, 700) });
  }
  return JSON.stringify(out, null, 1).slice(0, 2600);
} catch (e) { return 'dump error: ' + (e && e.message); } })()`;

// Sets the real <select> to "Any" (value 0) and fires the event React is listening for. Returns
// what the select reads afterwards, so the caller can confirm rather than assume.
const SET_ANY = `(() => { try {
  const sel = [...document.querySelectorAll('select')]
    .find(s => /number of tickets/i.test(s.getAttribute('aria-label') || '')
            || [...s.options].some(o => /^any$/i.test(o.textContent.trim())));
  if (!sel) return JSON.stringify({ set: false, why: 'no quantity <select> on the page' });
  const any = [...sel.options].find(o => /^any$/i.test(o.textContent.trim()));
  if (!any) return JSON.stringify({ set: false, why: 'select has no Any option',
    options: [...sel.options].map(o => o.value + '=' + o.textContent.trim()) });
  sel.value = any.value;
  // Both events: frameworks differ on which one they bind, and a missed notification leaves the
  // DOM showing Any while the listing query still asks for 2.
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ set: true, value: sel.value,
    label: (sel.options[sel.selectedIndex] || {}).textContent });
} catch (e) { return JSON.stringify({ set: false, why: String(e && e.message || e) }); } })()`;

const s = await openKernelSession({
  stealth: true, headless: false, replay: true,
  name: ['ai1097', 'stubhub', 'any-quantity'],
  tags: { ticket: 'AI-1097', run: 'stubhub-any-quantity', site: 'stubhub' },
});
const j = async expr => { try { return JSON.parse(await s.eval(expr) || 'null'); } catch { return null; } };
const count = async () => {
  const l = parseStubhubCards(JSON.parse(await s.eval(STUBHUB_CARD_EXPR) || '[]'));
  return {
    n: l.length,
    sections: new Set(l.map(x => x.section)).size,
    qtys: [...new Set(l.map(x => x.quantity))].sort((a, b) => a - b),
    list: l,
  };
};

console.log('session', s.granted.name);
if (s.live_view_url) console.log('live view', s.live_view_url);

try {
  const page = await s.goto(EVENT, { timeoutMs: 75000, pollMs: 5000 });
  if (page.wall) throw new Error('blocked by ' + page.wall);
  await sleep(2500);

  console.log('\n1. as it arrives');
  console.log('   state:', JSON.stringify(await j(STATE)));
  const before = await count();
  console.log(`   ${before.n} listings, ${before.sections} sections, quantities ${JSON.stringify(before.qtys)}`);

  console.log('\n2. dismiss the "How many tickets?" dialog');
  console.log('   Continue ->', JSON.stringify(await j(clickByText('Continue', { exact: true }))));
  await sleep(2000);
  console.log('   state:', JSON.stringify(await j(STATE)));

  console.log('\n3. set the quantity filter to Any');
  // THE CHIP IS NOT THE CONTROL. Clicking "2 tickets" opens a styled listbox whose options are
  // rendered lazily, so looking for an "Any" element right after finds nothing — which is how
  // the first two attempts failed while looking like "Any made no difference".
  //
  // Underneath it there is a real <select aria-label="Number of tickets"> whose first option is
  // <option value="0">Any</option>. Setting a select's .value does NOT notify React — the
  // framework listens for the change event — so the value is set and the event dispatched.
  console.log('   set <select> ->', JSON.stringify(await j(SET_ANY)));
  await sleep(3000);
  const picked = await j(clickByText('Any', { exact: true }));
  console.log('   pick "Any"   ->', JSON.stringify(picked));
  await sleep(3000);
  const after = await j(STATE);
  console.log('   state:', JSON.stringify(after));

  // THE TEST ONLY MEANS SOMETHING IF THE FILTER ACTUALLY CHANGED. First run of this script
  // printed "THE CEILING IS REAL" after the Any click had silently failed and the control still
  // read "2 tickets" — a conclusion drawn from a step that never happened. Confirm from the
  // page's own state, not from the fact that a click was attempted.
  const nowAny = !!(after && ((after.qtyShown || []).some(x => /^any/i.test(x))
    || /^0=/.test(after.selValue || '')));
  if (!nowAny) {
    console.log('\n  INCONCLUSIVE — the quantity filter still reads '
      + JSON.stringify((after && after.qtyShown) || []) + ', so "Any" was never applied.');
    console.log('  Nothing below would be evidence about Any. Dumping the control instead:');
    console.log(await s.eval(DUMP) || '(dump failed)');
    throw new Error('could not set quantity to Any — see the dump above');
  }

  console.log('\n4. scroll until the count stops growing');
  let prev = -1, stable = 0, passes = 0, now = await count();
  while (stable < 3 && passes < 20) {
    await s.eval(SCROLL);
    await sleep(1800);
    now = await count();
    if (now.n === prev) stable++; else { stable = 0; prev = now.n; }
    passes++;
    process.stdout.write(`   scroll ${String(passes).padStart(2)} -> ${now.n} listings\r`);
  }
  console.log(`\n   settled at ${now.n} listings, ${now.sections} sections, quantities ${JSON.stringify(now.qtys)}`);

  console.log('\n================ verdict ================');
  console.log(`  quantity=2, first paint : ${before.n} listings / ${before.sections} sections / qty ${JSON.stringify(before.qtys)}`);
  console.log(`  Any + scrolled          : ${now.n} listings / ${now.sections} sections / qty ${JSON.stringify(now.qtys)}`);
  const gain = now.n - before.n;
  console.log(gain > 2
    ? `\n  THE CEILING WAS OURS. "Any" plus scrolling returns ${gain} more listings (${(now.n / Math.max(before.n, 1)).toFixed(1)}x).`
    : `\n  THE CEILING IS REAL. "Any" plus scrolling adds ${gain}. StubHub shows a shortlist, not an inventory.`);
  console.log('\n  cheapest 8 with Any:');
  for (const l of now.list.slice().sort((a, b) => (a.price ?? 9e9) - (b.price ?? 9e9)).slice(0, 8)) {
    console.log(`    ${String(l.section).padEnd(8)} row ${String(l.row).padEnd(5)} $${String(l.price ?? '?').padEnd(6)} x${l.quantity ?? '?'}`);
  }
} finally {
  console.log('\ncost', JSON.stringify(s.cost()));
  const rep = await s.close().catch(() => null);
  if (rep) console.log(`replay: node --env-file=.env scripts/kernel-replay.js ${rep.session_id} ${rep.replay_id}`);
}
