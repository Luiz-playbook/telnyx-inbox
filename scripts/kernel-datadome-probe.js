// AI-1097: the two levers never tried against DataDome — mobile/ISP egress, and a persistent
// profile.
//
//   node --env-file=.env scripts/kernel-datadome-probe.js --out probe.json
//
// The Hobbyist plan's residential proxy did NOT move SeatGeek: all four of headless/headful x
// proxy/no-proxy came back DataDome at ~79s. It made StubHub worse — headful alone rendered 72
// listing nodes, headful plus the residential proxy rendered none.
//
// Kernel's own account of why names two things that run had not used:
//
//   PROXY TYPE. Residential is one of five. Mobile egress is carrier NAT, so thousands of real
//   people share the address and blocking it is expensive for the site; ISP is a datacenter host
//   on an ISP-registered range, which scores better than plain datacenter.
//
//   PERSISTENT PROFILES. Every run so far arrived as a brand-new device with no cookies and no
//   history, which is itself the signal. A profile carries state between sessions so the second
//   visit is a returning browser. This is the one AI-1097 asked for by name and never got
//   tested, and on a reputation system it is plausibly the bigger lever of the two.
//
// WARM, THEN MEASURE. A profile is worthless on first use — it has to collect something first.
// So each profile run loads the site twice in separate sessions and only the second is scored.

import { writeFileSync } from 'node:fs';
import { openKernelSession } from '../lib/kernel-browser.js';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const OUT = arg('out', 'kernel-datadome-probe.json');

const PROXIES = {
  mobile: process.env.KERNEL_PROXY_MOBILE || '',
  isp: process.env.KERNEL_PROXY_ISP || '',
  residential: process.env.KERNEL_PROXY_ID || '',
};
const PROFILE = process.env.KERNEL_PROFILE_ID || '';

const SITES = {
  seatgeek: 'https://seatgeek.com/san-diego-padres-tickets/3-25-2027-san-diego-california-petco-park/mlb/18381293',
  tickpick: 'https://www.tickpick.com/buy-los-angeles-lakers-vs-los-angeles-clippers-tickets-crypto-com-arena-10-23-26-7pm/8206052/',
  stubhub: 'https://www.stubhub.com/ph/athletics-sacramento-tickets-4-5-2027/event/161778058/?quantity=2',
};

const PROBE = `JSON.stringify({
  rows: [...document.querySelectorAll('div,li,a')].filter(n => /^Section\\s+\\S+\\s+Row\\s+/i.test((n.innerText||'').trim())).length
      + document.querySelectorAll('[data-testid*="listing" i]').length,
  secs: (document.body.innerText.match(/\\bsection\\b/gi)||[]).length })`;

// Every run records, and headful is forced by replay:true — replays do not record headless.
async function visit(label, site, url, opts, { warm = false } = {}) {
  let s;
  try {
    s = await openKernelSession({
      stealth: true, replay: !warm, ...opts,
      // Named so the dashboard reads "ai1097-isp-stubhub-1009-1830" instead of a 24-char id.
      // warm-ups are labelled as such — otherwise two sessions per site look like a retry.
      name: ['ai1097', label, site],
      tags: { ticket: 'AI-1097', run: label, site, phase: warm ? 'warmup' : 'scored' },
    });
  } catch (e) {
    console.log(`  [${label}] ${site}: session refused — ${e.message}`);
    return { label, site, error: String(e.message || e) };
  }
  const out = { label, site, granted: s.granted };
  try {
    const page = await s.goto(url, { timeoutMs: 75000, pollMs: 5000 });
    out.wall = page.wall || '';
    out.ms = page.ms;
    if (!page.wall) { try { Object.assign(out, JSON.parse(await s.eval(PROBE) || '{}')); } catch {} }
    if (warm) { console.log(`  [${label}] ${site}: warm-up ${page.wall || 'ok'}`); return out; }
    const verdict = out.wall ? out.wall.toUpperCase() : (out.rows ? 'DATA' : 'shell');
    console.log(`  [${label}] ${site.padEnd(9)} ${String(out.ms).padStart(6)}ms ${verdict.padEnd(10)} rows=${out.rows ?? 0}`);
  } catch (e) { out.error = String(e.message || e).slice(0, 90); }
  finally {
    out.cost = s.cost();
    const rep = await s.close().catch(() => null);
    if (rep) { out.replay = rep; console.log(`        replay ${rep.replay_id} (session ${rep.session_id})`); }
  }
  return out;
}

const runs = [];
console.log('--- egress type, headful, no profile ---');
for (const [kind, id] of Object.entries(PROXIES)) {
  if (!id) { console.log(`  (no ${kind} proxy configured, skipping)`); continue; }
  for (const [site, url] of Object.entries(SITES)) {
    runs.push(await visit(kind, site, url, { headless: false, proxyId: id }));
  }
}

if (PROFILE) {
  console.log('\n--- persistent profile, headful, mobile egress, second visit scored ---');
  for (const [site, url] of Object.entries(SITES)) {
    const opts = { headless: false, proxyId: PROXIES.mobile || PROXIES.residential, profileId: PROFILE };
    await visit('profile-warm', site, url, opts, { warm: true });
    runs.push(await visit('profile', site, url, opts));
  }
} else {
  console.log('\n(no KERNEL_PROFILE_ID set — profile runs skipped)');
}

console.log('\n================ summary ================');
const sites = Object.keys(SITES);
const labels = [...new Set(runs.map(r => r.label))];
console.log('  ' + 'egress'.padEnd(14) + sites.map(s => s.padEnd(13)).join(''));
for (const l of labels) {
  const cells = sites.map(s => {
    const r = runs.find(x => x.label === l && x.site === s) || {};
    return String(r.error ? 'error' : r.wall ? r.wall : r.rows ? `${r.rows} rows` : 'shell').padEnd(13);
  });
  console.log('  ' + l.padEnd(14) + cells.join(''));
}
const spend = runs.reduce((n, r) => n + ((r.cost && r.cost.usd) || 0), 0);
console.log(`\ncost $${spend.toFixed(4)}`);
const reps = runs.filter(r => r.replay).map(r => r.replay);
console.log(`replays recorded: ${reps.length}`);
for (const r of reps.slice(0, 4)) console.log(`  node --env-file=.env scripts/kernel-replay.js ${r.session_id} ${r.replay_id}`);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), runs }, null, 1));
console.log(`wrote ${OUT}`);
