# Ticket sources — what each method gets from each site

Measured 2026-10-07/09 against live event pages and APIs, on Kernel’s free tier and then again on the paid Hobbyist plan with proxies and profiles. This is the reference behind the
AI-1097 recommendation; the per-run numbers are in [ai-1097-kernel-poc.md](ai-1097-kernel-poc.md).

**Four access methods**, in rough order of cost:

| Method | What it is |
|---|---|
| **Ladder** | the existing scraper — plain HTTP, then Crawl4AI, then Firecrawl ([lib/scrape-price.js](../../lib/scrape-price.js)) |
| **Direct API** | the site's own JSON endpoint, called from Node with no browser |
| **Kernel** | a hosted browser driven over CDP ([lib/kernel-browser.js](../../lib/kernel-browser.js)) |
| **Apify** | a third-party pre-built scraper, called as a job |

---

## Gametime

- **Direct API = best.** `mobile.gametime.co/v3/listings/<eventId>` is **open** — no wall, no browser. ~220 listings in **1.2 s**, with `section`, `row` and `spot.section_group` (`Lower`/`Middle`/`Upper`), and `quantity` as a request parameter.
- **Ladder = works but fragile.** 3/6 games against the API's 4/5; the parser reverse-engineers two different HTML encodings and returns nothing when the page shifts.
- **Kernel = works, 10× slower.** ~12 s against 1.2 s, and it agrees to the dollar. Useful as a correctness check, pointless in production.
- **Apify** — not tested, no reason to.

**Use: the Direct API.** This was the single biggest win of the exercise and has nothing to do with Kernel.

## SeatGeek

- **Apify = best.** `lentic_clockss/seatgeek-scraper` returned **5,548 seat-level listings** with `section`, `row`, `quantity`, `price`, `priceWithFees`, `dealScore`. ~**$0.008 per event**. Needs `memory=4096` or the run is OOM-killed (exit 137).
- **Ladder = team page only.** `lowest_price` per game, **no section**.
- **Kernel = blocked in every configuration tried.** DataDome on headless, headful, residential proxy, mobile egress, ISP egress and a warmed persistent profile — seven for seven. See [the proxy question](#the-proxy-question-settled).
- **Direct API** — the event page is DataDome; SeatGeek's own API was never probed directly.

**Use: Apify.** More listings than Vivid and Gametime combined, from the site that was fully blocked. Also answers Josh's 17:12 complaint directly — we no longer sample SeatGeek's best-value list, we take the whole inventory and pick per zone ourselves.

## Vivid Seats

- **Kernel = best, and the only way in.** 850–1,500 listings with `section`, `row`, `quantity` and a **real** all-in price, ~11 s/game.
- **Ladder = team page only.** `lowPrice`, **no section**, all-in only estimated.
- **Direct API = blocked.** `hermes/api/v1/listings` sits behind the same Imperva wall as the page, so it cannot be called from Node — only from inside a Kernel page, where the browser's cookies and TLS fingerprint apply.
- **Apify = returned 0.** `stealth_mode/vividseats-tickets-listings-scraper` produced nothing on a URL Kernel pulled 983 listings from.

**Use: Kernel.** This is the one site that justifies it.

Two traps: pin `currency=USD&localizeCurrency=false` — Kernel's egress came out of Canada and the
endpoint localises, so an untouched request returns **CAD**. And Vivid sells standing room inline
(6 of 966 on one game), including `Lower Level 134 GA`, where `134` reads as an ordinary bowl
section — the marker is often in the **row** (`row: "GA"`), not the section.

## StubHub

- **Kernel (headful) and Apify tie, and both hit the same ceiling: 8 listings.** Section, row, quantity and a real all-in price — but eight of them.
- **Ladder = team page only.** `lowPrice`, **no section**, all-in estimated.
- **Kernel headless = blocked.** DataDome, 0/2. Headful **2/2** in ~7 s — the only site where the mode changed the outcome.
- **Apify** `stealth_mode/stubhub-tickets-listings-scraper` returned **8** on the same URL Kernel got 8 from. Two independent methods agreeing is what makes 8 a real ceiling rather than a scraping failure.

**Use: cross-check only.** Eight listings cannot answer "cheapest per zone" across four zones
without quoting whatever handful StubHub chose to show. Note its `formatted_total_price` is the
**order** total, not per ticket — $292 for two tickets against Kernel's $144 each.

## TickPick

- **Nothing gets section-level data.**
- **Ladder = team page only.** `lowPrice` from schema.org, **no section**.
- **Direct API = blocked.** `api.tickpick.com/1.0/listings/internal/event-v2/<id>` is DataDome: 403 plain, 403 with Origin/Referer, CORS from inside a cleared page, 403 navigating straight at it.
- **Kernel = page sometimes, listings never.** The event page cleared on 2 of 3 stealth attempts; the DOM still renders **zero** listing rows, because the inventory call behind it is what is blocked.
- **Apify** `lexis-solutions/tickpick-scraper` returns event-level aggregates only — low/high/average price and a ticket count. No sections.

**Use: the ladder's get-in, and accept no sections.** Worth remembering TickPick charges **no
fees**, so its all-in is often genuinely the cheapest — and we already capture that. What is
missing is narrow.

---

## Summary

| Site | Ladder | Direct API | Kernel | Apify | **Use** |
|---|---|---|---|---|---|
| **Gametime** | fragile, section-level | ✅ **open, 1.2 s** | works, 10× slower | — | **Direct API** |
| **SeatGeek** | team page only | event page blocked | ❌ DataDome, 7/7 configs | ✅ **5,548 listings** | **Apify** |
| **Vivid Seats** | team page only | ❌ Imperva | ✅ **850–1,500** | ❌ returned 0 | **Kernel** |
| **StubHub** | team page only | event page blocked | ⚠️ headful only, 8 | ⚠️ 8 | cross-check |
| **TickPick** | team page only | ❌ DataDome | ⚠️ page only, 0 rows | ❌ aggregates only | get-in only |

**Three different methods win on three different sites.** There is no single tool to standardise
on, and that is the finding rather than a failure to pick one.

**Kernel's case is exactly one site.** Gametime never needed it, SeatGeek is better and cheaper
via Apify, StubHub is a dead end either way, TickPick is unreachable by both. The recommendation
to Marx is "use it for Vivid", not "adopt it".

**The walls, for reference.** DataDome (SeatGeek, StubHub, TickPick's API) scores IP reputation
before it looks at the browser, which is why stealth did not move it — and, as it turned out,
why a better IP did not either. Imperva (Vivid) and
Cloudflare (TickPick's page) are mostly client checks, which is why a real browser cleared them.
A 403 is not "no tickets" and a 200 is not success — Vivid answers its wall with 200 and 1.9 KB.
---

## The proxy question, settled

Three sites block on DataDome, which scores IP reputation before it looks at the browser. The
obvious fix was a better IP, so the Kernel plan was upgraded to Hobbyist to get proxies and the
full grid was run — headless/headful x proxy/no-proxy on residential, then mobile and ISP egress,
then a warmed persistent profile. Stealth on throughout. Vivid as the control, since it already
worked without a proxy.

| Configuration | SeatGeek | StubHub | TickPick | Vivid (control) |
|---|---|---|---|---|
| headless | DataDome | DataDome | DataDome | nav timed out (harness, not a block) |
| headless + residential | DataDome | DataDome | DataDome | shell, **API 404** |
| headful | DataDome | **72 rows** | DataDome | **1,020 listings** |
| headful + residential | DataDome | shell | shell, **API 403** | shell, **API 404** |
| headful + mobile | DataDome | shell | DataDome | — |
| headful + ISP | DataDome | **73 rows** | Cloudflare | — |
| headful + mobile + warmed profile | DataDome | **73 rows** | shell, 0 rows | — |

**The residential proxy did not unblock a single site, and it broke the two that worked** —
Vivid went 1,020 listings to zero, StubHub 72 rows to zero. Vivid is the control, so that is the
configuration failing, not the site.

The mechanism on Vivid is worth naming, because it is not a wall: its listings API answers **404**
on both proxy rows. The proxy's egress lands in a different locale and the productionId is not
found there — the same localisation trap that already returns CAD prices if the currency is not
pinned. A proxy does not just change reputation, it changes which catalogue you are querying.

What the grid did produce, worth keeping:

- **SeatGeek is blocked in all seven configurations.** Not an IP problem, not a browser-mode
  problem. Apify gets 5,548 listings for under a cent; stop chasing it with a browser.
- **ISP is the only egress that does not break StubHub**, if a proxy is ever needed for some other
  reason. Residential and mobile both take it to zero.
- **A warmed profile recovers StubHub on mobile egress** — shell without it, 73 rows with it. The
  profile does real work on a reputation system; it just does not do enough for SeatGeek.
- Those row counts are DOM nodes, not parsed listings. 72 and 73 are the same page, and StubHub's
  real ceiling is still **8 distinct listings**.

Cost of settling it: **$0.12** across 13 sessions. Hobbyist includes $10/month of credits. The
plan is worth keeping for 7-day replay retention and 10 concurrent browsers — not for the walls.
