// AI-1088/1089: Gametime's own listings API, which turns out to be open.
//
//   GET https://mobile.gametime.co/v3/listings/<eventId>?all_in_pricing=true&quantity=<n>
//
// Found by watching the event page's network traffic inside a Kernel session. It answers plain
// HTTP with no wall — 329KB and 220 listings on a real NBA game — so this is NOT a Kernel-only
// source. It is simply better than the HTML the repo parses today:
//
//   * the ring is STATED, not inferred. spot.section_group is 'Lower' / 'Middle' / 'Upper', so
//     a 100-level number that is really a mezzanine seat cannot be mistaken for the bowl. The
//     section map has to guess this from a tier string; here the site just tells us.
//   * quantity is a request parameter, so "two seats together" stops being a post-filter.
//   * it is JSON. parseGametimeListings() reverse-engineers two different HTML encodings of the
//     same data and returns nothing when a page changes shape.
//
// WHY THE HTML PARSER STAYS. It is what priced 28/28 games and it is still the fallback here —
// this module is additive. It also matters for the Kernel comparison: parsing the event page's
// HTML through a real browser FAILED on 3 of 3 games (hydration replaces the server-rendered
// literal the regex needs), while this endpoint works identically from Node and from inside a
// Kernel page. That is the difference between a flaky second source and a reliable one.
//
// PRICES ARE IN CENTS, like the HTML (`prefee` 196000 = $1960.00). USD throughout: unlike Vivid
// and StubHub this endpoint does not localise by caller IP, so there is no currency to pin.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Event ids are the last path segment of a Gametime event URL:
//   /nba-basketball/76-ers-at-knicks-tickets/10-20-2026-.../events/6a7b0c8a5042e78c84a5c053
export const gametimeEventId = url => (String(url || '').match(/\/events\/([a-z0-9]+)/) || [])[1] || null;

export function gametimeListingsUrl(eventId, opts = {}) {
  const qs = new URLSearchParams({
    all_in_pricing: 'true',
    quantity: String(opts.quantity || 2),
  });
  return `https://mobile.gametime.co/v3/listings/${eventId}?${qs}`;
}

// Gametime's own ring naming -> the tier_class vocabulary the zone matcher uses.
const RING = { lower: 'lower_bowl', floor: 'floor', courtside: 'floor', middle: 'mezzanine', mezzanine: 'mezzanine', club: 'club', upper: 'upper' };

export function parseGametimeApi(text, opts = {}) {
  const { url = null } = opts;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const rows = Array.isArray(j.listings) ? j.listings : null;
  if (!rows || !rows.length) return null;

  const out = [];
  for (const l of rows) {
    const p = l.price || {};
    const prefee = Number(p.prefee);
    const total = Number(p.total);
    if (!(prefee > 0) && !(total > 0)) continue;
    const spot = l.spot || {};
    const group = String(spot.section_group || '').trim();
    out.push({
      source: 'Gametime',
      url,
      // Same basis as the rest of the pipeline: `price` is per ticket before fees, `all_in` is
      // what the buyer pays. Both are cents here.
      price: Math.round((prefee || total)) / 100,
      all_in: Math.round((total || prefee)) / 100,
      currency: 'USD',
      section: spot.section != null ? String(spot.section) : null,
      row: spot.row != null ? String(spot.row) : null,
      section_group: group || null,
      // The site's own ring, passed through so the zone matcher can prefer it over the map's.
      ring: RING[group.toLowerCase()] || null,
      quantities: Array.isArray(l.available_lots) ? l.available_lots : null,
      deal: l.deal || null,
      seats: Array.isArray(l.seats) ? l.seats.length : null,
    });
  }
  return out.length ? out : null;
}

// Plain HTTP. No wall as of 2026-10-08, but callers should still treat an empty result as a
// failure rather than "no tickets" — the same rule the fetch ladder applies everywhere else.
export async function fetchGametimeListings(eventUrl, opts = {}) {
  const id = gametimeEventId(eventUrl);
  if (!id) return { ok: false, note: 'no event id in url' };
  const api = gametimeListingsUrl(id, opts);
  const t0 = Date.now();
  try {
    const r = await fetch(api, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const text = await r.text();
    const data = parseGametimeApi(text, { url: eventUrl });
    return { ok: !!data, status: r.status, listings: data || [], ms: Date.now() - t0, api };
  } catch (e) {
    return { ok: false, note: String(e.message || e).slice(0, 120), ms: Date.now() - t0, api };
  }
}
