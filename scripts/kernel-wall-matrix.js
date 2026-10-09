// AI-1097: which Kernel configuration reaches which ticket site.
//
//   node --env-file=.env scripts/kernel-wall-matrix.js --out matrix.json
//
// On the free tier three sites were unreachable and the untested variable was always the same:
// Kernel's egress is a datacenter IP, and DataDome scores IP reputation before it looks at the
// browser at all. The Hobbyist plan includes proxies, so this runs the grid that was impossible
// before — headless and headful, with and without a residential proxy — against every site.
//
// A PAGE LOADING IS NOT THE TEST. TickPick taught that: its event page cleared on stealth while
// the DOM rendered zero listing rows, because the inventory call behind it was the thing being
// blocked. So each site is probed for the DATA, not the document — rendered rows, or the
// listings endpoint fetched the way that site needs it.
//
// Sessions run concurrently (the plan allows 10) because the grid is 4 configurations and doing
// them in series is four times the wall-clock for the same answer.

import { writeFileSync } from 'node:fs';
import { openKernelSession } from '../lib/kernel-browser.js';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const OUT = arg('out', 'kernel-matrix.json');
const PROXY = (process.env.KERNEL_PROXY_ID || 'sxrfyulouvfy2v41191ow63q').trim();

const SITES = {
  seatgeek: {
    url: 'https://seatgeek.com/san-diego-padres-tickets/3-25-2027-san-diego-california-petco-park/mlb/18381293',
    // SeatGeek renders its listings client-side; count what is on screen.
    probe: `JSON.stringify({ rows: document.querySelectorAll('[class*="listing" i],[data-testid*="listing" i]').length,
                             secs: (document.body.innerText.match(/\\bsection\\b/gi)||[]).length })`,
  },
  stubhub: {
    url: 'https://www.stubhub.com/ph/athletics-sacramento-tickets-4-5-2027/event/161778058/?quantity=2',
    probe: `JSON.stringify({ rows: [...document.querySelectorAll('div,li,a')].filter(n => /^Section\\s+\\S+\\s+Row\\s+/i.test((n.innerText||'').trim())).length,
                             secs: (document.body.innerText.match(/\\bsection\\b/gi)||[]).length })`,
  },
  tickpick: {
    url: 'https://www.tickpick.com/buy-los-angeles-lakers-vs-los-angeles-clippers-tickets-crypto-com-arena-10-23-26-7pm/8206052/',
    // The page is Cloudflare; the inventory is a separate DataDome-protected endpoint. Both are
    // checked, because clearing the first proved nothing last time.
    api: 'https://api.tickpick.com/1.0/listings/internal/event-v2/8206052?trackView=true',
    probe: `JSON.stringify({ rows: document.querySelectorAll('[class*="listing" i]').length,
                             secs: (document.body.innerText.match(/\\bsection\\b/gi)||[]).length })`,
  },
  vivid: {
    // Control: known to work without a proxy. If this breaks under a configuration, the
    // configuration is the problem and not the site.
    url: 'https://www.vividseats.com/new-york-knicks-tickets-madison-square-garden-10-20-2026--sports-nba-basketball/production/7415371',
    api: 'https://www.vividseats.com/hermes/api/v1/listings?productionId=7415371&currency=USD&localizeCurrency=false',
    sameOrigin: true,
    probe: `JSON.stringify({ rows: 0, secs: (document.body.innerText.match(/\\bsection\\b/gi)||[]).length })`,
  },
};

const MODES = [
  { name: 'headless',          headless: true,  proxy: false },
  { name: 'headless + proxy',  headless: true,  proxy: true  },
  { name: 'headful',           headless: false, proxy: false },
  { name: 'headful + proxy',   headless: false, proxy: true  },
];

async function runMode(mode) {
  const out = { mode: mode.name, granted: null, sites: {}, cost: null };
  let s;
  try {
    s = await openKernelSession({
      stealth: true,
      headless: mode.headless,
      proxyId: mode.proxy ? PROXY : '',
      // One session per configuration, so the configuration is the name. Four concurrent
      // sessions with opaque ids is exactly the case this solves.
      name: ['ai1097', 'matrix', mode.name],
      tags: { ticket: 'AI-1097', run: 'wall-matrix', mode: mode.name,
              headless: String(mode.headless), proxy: String(mode.proxy) },
    });
  } catch (e) {
    out.error = String(e.message || e);
    return out;
  }
  out.granted = s.granted;
  try {
    for (const [name, cfg] of Object.entries(SITES)) {
      const r = { wall: '', ms: 0, rows: 0, listings: 0, note: '' };
      try {
        const page = await s.goto(cfg.url, { timeoutMs: 75000, pollMs: 5000 });
        r.wall = page.wall || '';
        r.ms = page.ms;
        if (!page.wall) {
          try { Object.assign(r, JSON.parse(await s.eval(cfg.probe) || '{}')); } catch {}
          // The listings endpoint, by whichever route that site allows.
          if (cfg.api) {
            const got = cfg.sameOrigin ? await s.fetchInPage(cfg.api) : await s.gotoJson(cfg.api, { timeoutMs: 45000 });
            if (got.ok && got.body) {
              try {
                const j = JSON.parse(got.body);
                const arr = j.tickets || j.listings || (Array.isArray(j) ? j : null);
                r.listings = Array.isArray(arr) ? arr.length : 0;
                if (!r.listings) r.note = 'api ok, no listing array';
              } catch { r.note = 'api body not json'; }
            } else {
              r.note = `api ${got.status}${got.wall ? ' ' + got.wall : ''}`;
            }
          }
        }
      } catch (e) { r.note = String(e.message || e).slice(0, 70); }
      out.sites[name] = r;
      const verdict = r.wall ? r.wall.toUpperCase() : (r.listings || r.rows ? 'DATA' : 'shell');
      console.log(`  [${mode.name.padEnd(16)}] ${name.padEnd(9)} ${String(r.ms).padStart(6)}ms  ${verdict.padEnd(10)} rows=${r.rows} listings=${r.listings} ${r.note}`);
    }
  } finally {
    out.cost = s.cost();
    await s.close().catch(() => {});
  }
  return out;
}

console.log(`proxy: ${PROXY}\nrunning ${MODES.length} configurations concurrently\n`);
const results = await Promise.all(MODES.map(runMode));

console.log('\n================ matrix ================');
const names = Object.keys(SITES);
console.log('  ' + 'configuration'.padEnd(18) + names.map(n => n.padEnd(14)).join(''));
for (const r of results) {
  const cells = names.map(n => {
    const x = r.sites[n] || {};
    const v = x.wall ? x.wall : (x.listings ? `${x.listings} listings` : x.rows ? `${x.rows} rows` : 'shell');
    return String(v).padEnd(14);
  });
  console.log('  ' + r.mode.padEnd(18) + cells.join(''));
}
const spend = results.reduce((n, r) => n + ((r.cost && r.cost.usd) || 0), 0);
console.log(`\ncost: $${spend.toFixed(4)} across ${results.length} sessions`);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), proxy: PROXY, results }, null, 1));
console.log(`wrote ${OUT}`);
