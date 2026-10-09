// Which method fetches which ticket site, and what happens when it fails.
//
// WHY THIS FILE EXISTS. Until now every one of the five sites was read the same way — the HTTP
// ladder against a TEAM page — which gets a get-in price and nothing else. The AI-1097 testing
// established that the best method is DIFFERENT FOR EVERY SITE, and that no single tool wins:
//
//   Gametime    open JSON API, ~220 listings in 1.2s          -> api
//   SeatGeek    hard-blocked in all 7 Kernel configs; Apify
//               returns 5,548 seat-level listings for ~$0.008 -> apify
//   Vivid Seats unreachable from Node (Imperva), ~1,000
//               listings from inside a Kernel page            -> kernel
//   StubHub     headful Kernel only, caps at ~10 listings     -> kernel
//   TickPick    nothing reaches its listings API; the team
//               page is open and carries a get-in             -> ladder
//
// So the method is a property of the SITE, declared here once, rather than something each
// candidate function decides for itself.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE HARD RULE: AI NEVER PRODUCES A SECTION-LEVEL PRICE.
//
// The fallback chain may end at an LLM, and for a get-in that is defensible — it reads a page we
// already fetched and pulls the number out of it, which is extraction, not invention. For a
// PREMIUM price it is not defensible at any confidence, because "center court from $240" is a
// specific claim about a specific seat in a specific section, and a model that is 95% right
// invents the other 5% in a form nobody can tell apart from the truth. A wrong get-in is an
// embarrassing email; a wrong premium zone price is an email quoting a seat that does not exist
// at a price nobody can honour.
//
// Enforced in two places on purpose, because one of them will eventually be bypassed:
//   1. chainFor(site, { premium: true }) strips 'ai' from the chain, so it is never reached.
//   2. runSource() refuses to return section data from the ai method even if something calls it
//      directly — see the throw in METHODS.ai.
// ───────────────────────────────────────────────────────────────────────────────────────────────

import { fetchGametimeListings, gametimeListingsUrl } from './gametime-api.js';
import { vividListingsUrl, parseVividListings, vividIsStandingRoom } from './vivid-listings.js';
import { STUBHUB_CARD_EXPR, parseStubhubCards } from './stubhub-listings.js';
import { openKernelSession } from './kernel-browser.js';
import { fetchApifySeatgeek } from './apify-listings.js';
import { stripSectionWord } from './section-zones.js';

// A method is section-level if it can say WHICH SEAT a price belongs to. The premium offer needs
// that; a get-in does not. This is the flag chainFor filters on, not a comment.
export const METHOD_KINDS = {
  api: { sectionLevel: true, cost: 'free', note: "the site's own JSON endpoint, called from Node" },
  apify: { sectionLevel: true, cost: 'paid', note: 'a third-party scraper, billed per run' },
  kernel: { sectionLevel: true, cost: 'paid', note: 'a hosted browser driven over CDP' },
  ladder: { sectionLevel: false, cost: 'free', note: 'plain HTTP -> Crawl4AI -> Firecrawl, team page only' },
  ai: { sectionLevel: false, cost: 'paid', note: 'an LLM reading a page we already fetched — GET-IN ONLY' },
};

export const SOURCES = {
  gametime: {
    label: 'Gametime',
    primary: 'api',
    // The HTML pool stays in the chain because it is what priced 28/28 games before the API was
    // found, and the API is one undocumented endpoint away from changing shape.
    fallback: ['ladder', 'ai'],
  },
  seatgeek: {
    label: 'SeatGeek',
    primary: 'apify',
    // Deliberately NO kernel: DataDome refused it on headless, headful, residential, mobile, ISP
    // and a warmed profile — seven for seven. Putting it in the chain would spend money to fail.
    fallback: ['ladder', 'ai'],
  },
  vivid: {
    label: 'Vivid Seats',
    primary: 'kernel',
    fallback: ['ladder', 'ai'],
  },
  stubhub: {
    label: 'StubHub',
    primary: 'kernel',
    fallback: ['ladder', 'ai'],
  },
  tickpick: {
    label: 'TickPick',
    primary: 'ladder',
    // No kernel: the event page sometimes clears but the listings call behind it never does, so
    // a Kernel attempt buys a page with zero listing rows on it.
    fallback: ['ai'],
  },
};

export const SITE_KEYS = Object.keys(SOURCES);
export const siteLabel = k => (SOURCES[k] && SOURCES[k].label) || k;

// The ordered list of methods to try for one site.
//
// `premium: true` means the caller needs a section per price. Two things follow: 'ai' is removed
// (the hard rule above), and so is any other method that cannot name a section — there is no
// point running the ladder for a premium price when the ladder only ever returns a team-page
// get-in. The result can therefore be EMPTY, and an empty chain is a real answer: it means this
// site cannot give section-level data, which is true of TickPick.
export function chainFor(site, opts = {}) {
  const cfg = SOURCES[site];
  if (!cfg) throw new Error(`unknown ticket source: ${site}`);
  const chain = [cfg.primary, ...(cfg.fallback || [])];
  if (!opts.premium) return chain;
  return chain.filter(m => METHOD_KINDS[m] && METHOD_KINDS[m].sectionLevel);
}

// A one-line explanation of what will be tried, for logs and for the price editor's "why".
export const explainChain = (site, opts = {}) => {
  const chain = chainFor(site, opts);
  if (!chain.length) return `${siteLabel(site)}: no method can return section-level data`;
  return `${siteLabel(site)}: ${chain.join(' -> ')}${opts.premium ? ' (premium — ai excluded)' : ''}`;
};

// ---------------------------------------------------------------------------------------------
// Kernel, shared across the sites that need it
// ---------------------------------------------------------------------------------------------
//
// ONE SESSION PER RUN, NOT PER SITE. A Kernel browser is billed on wall-clock and takes seconds
// to start, so Vivid and StubHub share one. It is opened on first use and closed by the caller
// via closeKernel(ctx) — holding it on the context is what makes "one session spans the run"
// true rather than aspirational.
//
// HEADFUL, NO PROXY, and both halves of that are measured. Vivid and StubHub only answer a
// headful browser; the residential proxy broke both (Vivid 1,020 listings -> 0 via a 404 on its
// own listings API, because the proxy's locale does not have that productionId).
async function kernelFor(ctx) {
  if (ctx && ctx.kernel) return ctx.kernel;
  const s = await openKernelSession({
    stealth: true,
    headless: false,
    proxyId: '',
    name: ['refresh', 'listings'],
    tags: { run: 'price-refresh', purpose: 'section-level listings' },
  });
  if (ctx) ctx.kernel = s;
  return s;
}

export async function closeKernel(ctx) {
  if (!ctx || !ctx.kernel) return null;
  const s = ctx.kernel;
  ctx.kernel = null;
  const cost = s.cost();
  await s.close().catch(() => {});
  return cost;
}

// ---------------------------------------------------------------------------------------------
// The methods
// ---------------------------------------------------------------------------------------------
//
// Every method returns the same shape so the chain can try the next one without knowing which
// ran:  { ok, listings: [...], via, url, note, fail }
//
// `listings` is always an array of {price, all_in, section, row, quantities}. A method that
// cannot name a section returns listings with section: null rather than omitting the field —
// the premium path filters on it, and a missing key reads as "not checked" instead of "none".

const round2 = n => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

export const METHODS = {
  // Gametime's open JSON API.
  async api(site, game, ctx, io) {
    if (site !== 'gametime') return { ok: false, fail: `no api method for ${site}` };
    const url = io && io.eventUrl;
    if (!url) return { ok: false, fail: 'no Gametime event URL resolved' };
    const r = await fetchGametimeListings(url, { quantity: 2 });
    if (!r || !r.ok) return { ok: false, url, fail: (r && r.error) || 'Gametime API did not answer' };
    return {
      ok: true, via: 'api', url, endpoint: gametimeListingsUrl(url, { quantity: 2 }),
      listings: r.listings.map(l => ({
        price: round2(l.price), all_in: round2(l.all_in), section: l.section, row: l.row,
        section_group: l.section_group, quantities: l.lots, deal: l.deal,
      })),
    };
  },

  // SeatGeek through an Apify actor. The only method that reaches it at all.
  async apify(site, game, ctx, io) {
    if (site !== 'seatgeek') return { ok: false, fail: `no apify actor wired for ${site}` };
    const url = io && io.eventUrl;
    if (!url) return { ok: false, fail: 'no SeatGeek event URL resolved' };
    const r = await fetchApifySeatgeek(url);
    if (!r.ok) return { ok: false, url, fail: r.error };
    return { ok: true, via: 'apify', url, cost_usd: r.cost_usd, listings: r.listings };
  },

  // Vivid and StubHub, from inside a real browser.
  async kernel(site, game, ctx, io) {
    const url = io && io.eventUrl;
    if (!url) return { ok: false, fail: `no ${siteLabel(site)} event URL resolved` };
    const s = await kernelFor(ctx);
    const page = await s.goto(url, { timeoutMs: 75000, pollMs: 5000 });
    if (page.wall) return { ok: false, url, fail: `${page.wall} wall` };

    if (site === 'vivid') {
      // Same-origin, so fetchInPage: the endpoint sits behind the same Imperva wall as the page
      // and only answers with the browser's cookies and TLS fingerprint attached.
      const pid = (url.match(/\/production\/(\d+)/) || [])[1];
      if (!pid) return { ok: false, url, fail: 'no Vivid productionId in the URL' };
      const got = await s.fetchInPage(vividListingsUrl(pid));
      if (!got.ok || !got.body) return { ok: false, url, fail: `listings API ${got.status}` };
      let parsed;
      // parseVividListings THROWS on a non-USD body rather than quoting the wrong currency —
      // Kernel's egress has come out of Canada and the endpoint localises.
      try { parsed = parseVividListings(got.body, { url }); }
      catch (e) { return { ok: false, url, fail: String(e.message || e).slice(0, 90) }; }
      const usable = (parsed || []).filter(l => !vividIsStandingRoom(l));
      return {
        ok: usable.length > 0, via: 'kernel', url,
        dropped_standing: (parsed || []).length - usable.length,
        listings: usable.map(l => ({
          price: round2(l.price), all_in: round2(l.all_in),
          // VIVID ALSO WRITES "Section 420". Same trap as SeatGeek and the same consequence:
          // normSection turns it into SECTION420, which matches nothing in a zone map built
          // from "420", so every Vivid listing would come back unmapped and the premium block
          // would read that as "this arena has no lower bowl".
          section: stripSectionWord(l.section),
          row: l.row,
          // parseVividListings returns `quantity` (singular). Reading `quantities` off it gave
          // undefined on all 1,014 listings — silently, because null is also a legitimate
          // "unknown", so nothing looked wrong.
          quantities: l.quantity ? [Number(l.quantity)] : null,
          seat_count: l.quantity != null ? Number(l.quantity) : null,
        })),
        fail: usable.length ? null : 'listings API answered with no usable listings',
      };
    }

    if (site === 'stubhub') {
      // StubHub opens with a blocking "How many tickets?" dialog defaulting to 2, which filters
      // out every lot that cannot seat two together. Setting its <select> to Any first is the
      // difference between the inventory it will show and a subset of it. Measured: the count
      // does not change (it caps around 10 either way) but the LOTS do — quantities went from
      // [2] to [2,4,7] — so without this the cheap single seats are invisible.
      await s.eval(STUBHUB_ANY_QUANTITY).catch(() => null);
      const cards = await s.eval(STUBHUB_CARD_EXPR);
      let list = [];
      try { list = parseStubhubCards(JSON.parse(cards || '[]'), { url }); } catch { list = []; }
      return {
        ok: list.length > 0, via: 'kernel', url,
        listings: list.map(l => ({
          price: round2(l.price), all_in: round2(l.all_in ?? l.price), section: l.section,
          row: l.row, quantities: l.quantity != null ? [l.quantity] : null,
        })),
        // Stated on every StubHub result rather than in a doc, because the number is small
        // enough that treating it as an inventory is the mistake waiting to happen.
        note: 'StubHub renders a shortlist, not an inventory — ~10 listings even with quantity set to Any.',
        fail: list.length ? null : 'no listing cards rendered',
      };
    }
    return { ok: false, url, fail: `no kernel path for ${site}` };
  },

  // The existing HTTP ladder against a team page. Get-in only — no section, by nature.
  async ladder(site, game, ctx, io) {
    if (!io || typeof io.ladder !== 'function') return { ok: false, fail: 'no ladder adapter supplied' };
    const r = await io.ladder(site, game, ctx);
    if (!r || !r.ok) return { ok: false, url: r && r.url, fail: (r && r.fail) || 'ladder found no price' };
    return {
      ok: true, via: r.via || 'ladder', url: r.url,
      listings: [{ price: round2(r.price), all_in: round2(r.all_in), section: null, row: null, quantities: null }],
      all_in_estimated: !!r.all_in_estimated,
      note: r.note,
    };
  },

  // THE LAST RESORT, AND GET-IN ONLY.
  //
  // It reads HTML the ladder already fetched and pulls the lowest price out of it. That is
  // extraction from a page, not a guess at a market — the number has to be present in the text
  // or the method fails. It still never returns a section: see the rule at the top of this file.
  async ai(site, game, ctx, io) {
    if (!io || typeof io.aiExtract !== 'function') return { ok: false, fail: 'no ai adapter supplied' };
    const r = await io.aiExtract(site, game, ctx);
    if (!r || !r.ok) return { ok: false, fail: (r && r.fail) || 'ai could not find a price on the page' };
    // Belt and braces for the rule. If a future adapter starts returning sections, this throws
    // rather than letting an invented section reach a premium offer.
    if (r.section != null) {
      throw new Error('ai method returned a section — AI must never produce section-level prices');
    }
    return {
      ok: true, via: 'ai', url: r.url,
      listings: [{ price: round2(r.price), all_in: round2(r.all_in ?? r.price), section: null, row: null, quantities: null }],
      all_in_estimated: true,
      note: r.note || 'Read off the page by a model because every parser failed. Get-in only — never a section.',
      ai: true,
    };
  },
};

// Sets StubHub's quantity filter to "Any" by driving the real <select> underneath the chip.
//
// The chip labelled "2 tickets" is a styled mirror; clicking it opens a listbox whose options
// render lazily, so looking for an "Any" element straight afterwards finds nothing — which is
// how two earlier attempts failed while looking like "Any made no difference". The <select
// aria-label="Number of tickets"> has <option value="0">Any</option> and is always present.
// Setting .value alone does not notify React, so both events are dispatched.
export const STUBHUB_ANY_QUANTITY = `(() => { try {
  const sel = [...document.querySelectorAll('select')]
    .find(s => /number of tickets/i.test(s.getAttribute('aria-label') || '')
            || [...s.options].some(o => /^any$/i.test(o.textContent.trim())));
  if (!sel) return JSON.stringify({ set: false, why: 'no quantity select' });
  const any = [...sel.options].find(o => /^any$/i.test(o.textContent.trim()));
  if (!any) return JSON.stringify({ set: false, why: 'no Any option' });
  sel.value = any.value;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ set: true, value: sel.value });
} catch (e) { return JSON.stringify({ set: false, why: String(e && e.message || e) }); } })()`;

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------
//
// Walks the chain for one site and returns the first method that answers, plus the full trail of
// what was tried. The trail is not debug noise: the price editor shows an operator why a figure
// came from where it did, and "Gametime: api failed (403), ladder answered" is the explanation.
//
// `io` carries the per-site things this file should not know how to do — resolving an event URL,
// running the existing ladder, calling the model. scrape-price.js supplies them.
export async function runSource(site, game, ctx, io = {}, opts = {}) {
  const chain = chainFor(site, opts);
  const trail = [];
  if (!chain.length) {
    return { site, label: siteLabel(site), ok: false, trail,
      fail: `no method can return section-level data for ${siteLabel(site)}` };
  }
  for (const method of chain) {
    const fn = METHODS[method];
    if (!fn) { trail.push({ method, ok: false, fail: 'method not implemented' }); continue; }
    // A method that is switched off (no key, no plan) is skipped, not failed — the distinction
    // matters when reading a trail that says every method failed.
    if (io.enabled && io.enabled[method] === false) {
      trail.push({ method, skipped: 'not enabled' });
      continue;
    }
    let r;
    try {
      r = await fn(site, game, ctx, io);
    } catch (e) {
      r = { ok: false, fail: `error: ${String(e.message || e).slice(0, 90)}` };
    }
    trail.push({ method, ok: !!r.ok, fail: r.fail || null, url: r.url || null,
      listings: r.ok ? (r.listings || []).length : 0 });
    if (r.ok) {
      return { site, label: siteLabel(site), ok: true, method, ...r, trail,
        // Whether the figures that came back can answer a premium question at all.
        section_level: (r.listings || []).some(l => l.section != null) };
    }
  }
  return { site, label: siteLabel(site), ok: false, trail,
    fail: `every method failed: ${trail.map(t => `${t.method} (${t.skipped || t.fail})`).join(', ')}` };
}
