// AI-1097: the per-site routing, and the rule that AI never prices a seat.
//
//   node --env-file=.env scripts/source-routing-check.js
//
// Pure checks — no network, no money. What it asserts:
//
//   1. Every site routes to the method that was measured to work for it.
//   2. A PREMIUM request never contains 'ai', on any site, by any route.
//   3. A premium request also drops the ladder, which cannot name a section — so TickPick's
//      premium chain is EMPTY, and an empty chain is the correct answer rather than a bug.
//   4. runSource refuses a section from the ai method even when called directly, so the rule
//      survives someone wiring an adapter that ignores it.
//
// Check 4 is the one worth having. The first three are configuration and would survive a
// careless edit to the registry; the fourth is the one that catches an adapter author who
// decides their model is good enough to guess a section.

import { SOURCES, SITE_KEYS, chainFor, explainChain, runSource, METHOD_KINDS, METHODS } from '../lib/ticket-sources.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } };

console.log('--- 1. what each site routes to ---');
const EXPECTED = { gametime: 'api', seatgeek: 'apify', vivid: 'kernel', stubhub: 'kernel', tickpick: 'ladder' };
for (const [site, want] of Object.entries(EXPECTED)) {
  const got = SOURCES[site] && SOURCES[site].primary;
  ok(got === want, `${site.padEnd(9)} primary = ${got} (want ${want})`);
}

console.log('\n--- 2. the get-in chain, per site ---');
for (const site of SITE_KEYS) console.log('  ' + explainChain(site));

console.log('\n--- 3. AI IS NEVER IN A PREMIUM CHAIN ---');
for (const site of SITE_KEYS) {
  const premium = chainFor(site, { premium: true });
  ok(!premium.includes('ai'), `${site.padEnd(9)} premium chain has no ai: [${premium.join(', ') || 'empty'}]`);
}
// And the get-in chains DO allow it, or the rule above is vacuous — a chain that never had ai
// in it proves nothing about ai being removed.
const anyAi = SITE_KEYS.some(s => chainFor(s).includes('ai'));
ok(anyAi, 'ai IS present in get-in chains, so its absence above is a filter and not an accident');

console.log('\n--- 4. premium drops every method that cannot name a section ---');
for (const site of SITE_KEYS) {
  const premium = chainFor(site, { premium: true });
  const bad = premium.filter(m => !METHOD_KINDS[m].sectionLevel);
  ok(!bad.length, `${site.padEnd(9)} premium chain is all section-level: [${premium.join(', ') || 'empty'}]`);
}
ok(chainFor('tickpick', { premium: true }).length === 0,
  'tickpick has an EMPTY premium chain — nothing can give it a section, and that is the honest answer');

console.log('\n--- 5. the ai method refuses to return a section even if asked directly ---');
// An adapter that returns a section is the mistake this guards against. Call it on purpose.
let threw = null;
try {
  await METHODS.ai('gametime', {}, {}, {
    aiExtract: async () => ({ ok: true, price: 100, section: '104', row: '12' }),
  });
} catch (e) { threw = String(e.message || e); }
ok(threw && /never produce section-level/i.test(threw),
  'a section-returning ai adapter throws: ' + (threw ? threw.slice(0, 70) : 'IT DID NOT THROW'));

// The same adapter without a section is fine, and must be — otherwise the guard is just "ai is
// broken" rather than "ai cannot price a seat".
const fine = await METHODS.ai('gametime', {}, {}, {
  aiExtract: async () => ({ ok: true, price: 100, url: 'https://example.com' }),
});
ok(fine.ok && fine.listings[0].section === null && fine.ai === true,
  'a get-in-only ai adapter is accepted, marked ai:true, section null');

console.log('\n--- 6. runSource records a trail and skips disabled methods ---');
const r = await runSource('seatgeek', { team: 'Lakers' }, {}, {
  eventUrl: null,                                  // nothing resolves, so every method fails
  enabled: { apify: false, kernel: false, ai: false },
  ladder: async () => ({ ok: false, fail: 'team page 403' }),
}, {});
ok(!r.ok, 'seatgeek with nothing available does not claim success');
ok(r.trail.some(x => x.method === 'apify' && x.skipped), 'apify is marked SKIPPED, not failed, when the key is absent');
ok(r.trail.some(x => x.method === 'ladder' && x.fail === 'team page 403'),
  'the ladder failure is recorded verbatim, so a trail says why');
console.log('  trail:', JSON.stringify(r.trail));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
