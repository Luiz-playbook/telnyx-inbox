// AI-1088: section-level listings from StubHub, which needs a HEADFUL Kernel browser.
//
// WHAT WAS MEASURED (2026-10-08, stealth on, two passes each):
//   headless   0/2 — DataDome 403 after ~74s
//   headful    2/2 — page in ~7s, listings rendered with sections visible
//
// That is the only site where headful vs headless changed the outcome, and it changed it
// completely. Worth knowing why it might: a headful Chromium has a real compositor, real window
// metrics and real paint timing, all of which DataDome fingerprints. It also costs 8x — Kernel
// gives a headful session 8GB against a headless one's 1GB, and bills per GB-second.
//
// THE CEILING, AND IT IS LOW. StubHub renders a CURATED SHORTLIST, not an inventory:
// 8 distinct listings on a real event, and scrolling the panel added none. Gametime returns 220
// for the same kind of game and Vivid 983. No inventory API was found behind it either — the
// only XHRs are JS chunks and telemetry.
//
// So this is a CROSS-CHECK, not a source. Eight listings cannot answer "cheapest per zone"
// across four zones, and anything built on it would quote a zone price off a handful of seats
// StubHub chose to show. Use it to corroborate Gametime and Vivid, not to price a game.
//
// NO EMBEDDED JSON, SO THE TEXT IS THE DATA. The page carries no __NEXT_DATA__ and the CSS
// classes are generated hashes ('bway-jTBMCa') that will churn on any deploy. Parsing the card's
// rendered TEXT is the durable option — the wording is user-facing and changes far more slowly
// than a class name:
//
//   "Section 104 Row 29 2 tickets together Clear view Aisle seat Best price $144 incl. fees"

// One card, as innerText. Everything after the price is noise (ratings, badges).
const CARD = /^Section\s+(\S+)\s+Row\s+(\S+)\b([\s\S]*)$/i;
const QTY = /(\d+)\s*tickets?\s+together/i;
const PRICE = /\$\s*([\d,]+(?:\.\d{2})?)/;
const INCL = /incl\.?\s*fees/i;
const STANDING = /\bstanding\b|\bsro\b|general\s+admission|\bga\b|drink\s*rail/i;

// Pull every listing card's text out of the live DOM. Shape, not classes: the deepest nodes
// whose text begins "Section <x> Row <y>". Returned as an expression so the caller can hand it
// straight to a Kernel session's eval().
export const STUBHUB_CARD_EXPR = `(() => {
  const out = [];
  for (const n of document.querySelectorAll('div,li,a')) {
    const t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!/^Section\\s+\\S+\\s+Row\\s+/i.test(t)) continue;
    if (t.length > 220) continue;
    out.push(t);
  }
  return JSON.stringify(out);
})()`;

// THE SAME LISTING ARRIVES THREE TIMES. The card, its inner wrapper and its innermost text node
// all match the shape test, giving "Section 104 Row 29 ... $144 incl. fees", then the same
// without the price, then just "Section 104 Row 29". Measured: 24 matches for 8 real listings.
// Keeping the LONGEST text per section+row keeps the one that still has the price on it.
export function parseStubhubCards(cards, opts = {}) {
  const { url = null } = opts;
  const best = new Map();

  for (const raw of cards || []) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    const m = text.match(CARD);
    if (!m) continue;
    const section = m[1].replace(/[^A-Za-z0-9]/g, '');
    const row = m[2].replace(/[^A-Za-z0-9]/g, '');
    if (!section || !row) continue;
    const key = section + '|' + row;
    const prev = best.get(key);
    if (!prev || text.length > prev.length) best.set(key, text);
  }

  const out = [];
  for (const [key, text] of best) {
    const [section, row] = key.split('|');
    const pm = text.match(PRICE);
    if (!pm) continue;                       // a card with no price is a fragment, not a listing
    const amount = Number(pm[1].replace(/,/g, ''));
    if (!(amount > 0)) continue;
    // StubHub labels the figure "incl. fees" when it is all-in. When it does not, the number is
    // pre-fee and the all-in is unknown — flagged rather than guessed, the way the repo already
    // treats StubHub's estimated all-in elsewhere.
    const allIn = INCL.test(text);
    const qm = text.match(QTY);
    if (STANDING.test(section + ' ' + row)) continue;   // AI-1087, same rule as everywhere else

    out.push({
      source: 'StubHub',
      url,
      section,
      row,
      quantity: qm ? Number(qm[1]) : null,
      price: amount,
      all_in: allIn ? amount : null,
      all_in_estimated: !allIn,
      currency: 'USD',
      note: allIn ? null : 'StubHub did not label this price as including fees',
      text,
    });
  }
  return out.length ? out : null;
}
