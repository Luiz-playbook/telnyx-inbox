// AI-1088: section-level listings from Vivid Seats, which needs a real browser to reach.
//
// WHY THIS IS A SEPARATE SHAPE FROM EVERY OTHER SOURCE. lib/scrape-price.js parses HTML: each
// source there hands a document to a regex and gets listings back. Vivid's event page holds no
// listings at all. It renders a shell, then calls its own API:
//
//   GET /hermes/api/v1/listings?productionId=<id>&currency=USD&localizeCurrency=false
//
// 966 listings came back for one game, each with a section, a row, a quantity and both a pre-fee
// and an all-in price — richer than anything else available, Gametime included. Both the page and
// the API sit behind Imperva, so neither is reachable from Node; the fetch has to be issued from
// inside a Kernel page (see fetchInPage in lib/kernel-browser.js).
//
// CURRENCY IS NOT OPTIONAL HERE. The endpoint localises to the caller's country and Kernel's
// egress came out of Canada on the first run, so the untouched request returned CAD. The repo
// already had this bug class with StubHub (lib/scrape-price.js forces a US location through
// Firecrawl for exactly this reason). currency=USD and localizeCurrency=false are therefore
// pinned, and the parser refuses a payload that still answers in another currency rather than
// quoting Canadian dollars as if they were US ones.

export const vividProductionId = url => (String(url || '').match(/\/production\/(\d+)/) || [])[1] || null;

export function vividListingsUrl(productionId) {
  const qs = new URLSearchParams({
    productionId: String(productionId),
    includeIpAddress: 'true',
    currency: 'USD',
    localizeCurrency: 'false',
  });
  return `https://www.vividseats.com/hermes/api/v1/listings?${qs}`;
}

// Vivid sends every field twice, once under a one-or-two-letter key and once spelled out:
//   s / sectionName   r / row   q / quantity   p / <pre-fee>   aip / allInPricePerTicket
// The long names are preferred and the short ones are the fallback, because the short set is
// what an older response shape carried and it still appears on some productions.
//
// `section` is a NAME, not a number — 'Lower Level 134 GA - Dirty Bird's Nest' is a real value.
// It is passed through untouched; pulling a section number out of prose is the zone matcher's
// job (sectionTokens in lib/section-zones.js), and doing it here would hide the original from
// whoever has to debug an unmapped row.
// STANDING ROOM, AND WHY THE ROW HAS TO BE CHECKED TOO (AI-1087).
//
// Vivid sells standing room alongside seats and it is not always obvious from the section alone.
// Measured on one real production, 6 of 966 listings were standing or GA:
//
//   section 'SRO8'                              row 'SRO'
//   section 'SRO7'                              row 'GA'
//   section "Lower Level 134 GA - Dirty Bird's Nest"  row 'GA'
//
// The last one is the dangerous shape: '134' reads as an ordinary lower-bowl section, so without
// this filter a standing ticket would become the cheapest "lower bowl" price and could be quoted
// as a seat. isStandingRoom only inspects section and section_group, which catches that row by
// luck (the words 'GA' sit in the section name) but would miss a listing whose section is clean
// and whose ROW is 'GA'. So the row is matched as well, which is where Vivid actually puts it.
const STANDING = /\bstanding\b|\bsro\b|general\s+admission|\bga\b|drink\s*rail/i;
export const vividIsStandingRoom = l =>
  STANDING.test(`${l.section || ''} ${l.row || ''}`);

export function parseVividListings(text, opts = {}) {
  const { url = null, requireUsd = true } = opts;
  let j;
  try { j = JSON.parse(text); } catch { return null; }

  const tickets = Array.isArray(j.tickets) ? j.tickets : null;
  if (!tickets || !tickets.length) return null;

  // The payload states its own currency in a couple of places depending on the production.
  const cur = String((j.global && (j.global.currency || j.global.currencyCode)) || '').toUpperCase();
  if (requireUsd && cur && cur !== 'USD') {
    const e = new Error(`Vivid answered in ${cur}, not USD`);
    e.currency = cur;
    throw e;
  }

  const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const out = [];
  let dropped = 0;
  for (const t of tickets) {
    const price = num(t.p);
    const allIn = num(t.allInPricePerTicket != null ? t.allInPricePerTicket : t.aip);
    if (!price && !allIn) continue;
    const section = String(t.sectionName != null ? t.sectionName : (t.s != null ? t.s : '')).trim();
    if (!section) continue;
    const row = String(t.row != null ? t.row : (t.r != null ? t.r : '')).trim() || null;
    // Dropped here rather than by the caller: every consumer of this parser wants seats, and a
    // standing ticket that reaches a zone price is a wrong number in a customer's inbox.
    if (vividIsStandingRoom({ section, row })) { dropped++; continue; }
    out.push({
      source: 'Vivid Seats',
      url,
      section,
      row,
      quantity: num(t.quantity != null ? t.quantity : t.q),
      price: price || allIn,
      all_in: allIn || price,
      currency: 'USD',
    });
  }
  // The standing-room count is attached so a caller can report what it removed, the way
  // gameListings reports dropped_standing — a silent filter is one nobody can audit.
  if (out.length) out.dropped_standing = dropped;
  return out.length ? out : null;
}

// Event links off a Vivid search or team page. Vivid publishes JSON-LD events whose url carries
// the production id, which is the only thing the listings endpoint needs.
export function parseVividProductions(html) {
  const out = [];
  for (const b of String(html || '').matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(b[1]); } catch { continue; }
    for (const e of [].concat(j)) {
      if (!e || !e.startDate) continue;
      const url = String(e.url || (e.offers && e.offers.url) || '');
      const id = vividProductionId(url);
      if (!id) continue;
      out.push({ id, url, name: String(e.name || ''), date: String(e.startDate).slice(0, 10) });
    }
  }
  return out.length ? out : null;
}
