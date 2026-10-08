# AI-1097 — Kernel browser POC

**Spike.** Can a hosted browser (Kernel) get us section-level ticket prices from the sites our
HTTP ladder cannot reach? Measured 2026-10-07/08 against live event pages.

Code: [lib/kernel-browser.js](../lib/kernel-browser.js) ·
[lib/vivid-listings.js](../lib/vivid-listings.js) ·
harness [scripts/kernel-poc.js](../scripts/kernel-poc.js)

## The question this actually answers

Not "should we replace the scraper" — that was never in doubt. [lib/scrape-price.js](../lib/scrape-price.js)
gets Gametime and TickPick get-ins on 28/28 games over plain HTTP at ~1-3s a page and ~$0. No
hosted browser beats that.

The real gap is **section-level** data. The premium offer wants to say "center court from $X"
(AI-1098), and that needs a section per listing. Measured, straight at the event pages:

| Site | Plain HTTP at the event page | Kernel, no stealth | **Kernel with stealth** | Section-level data? |
|---|---|---|---|---|
| Gametime | **open** (incl. its JSON API) | works | works | yes — section, row, section_group |
| Vivid Seats | 200 + Imperva interstitial | **clears ~9s** | clears | yes — 600-1500 listings, section/row/qty/all-in |
| TickPick | Cloudflare challenge | "Verification successful", never loads | page clears ~2 of 3 tries; **listings API never clears** | no — see below |
| SeatGeek | 403, DataDome | blocked | still blocked (79s) | no |
| StubHub | 403, DataDome | blocked | **headless 0/2, HEADFUL 2/2 in ~7s** | partial — 8 curated listings, see below |

### The stealth flag was silently ignored for most of this POC

The create field is **`stealth`**, not `stealth_mode`. The API accepts `stealth_mode`, ignores it,
and answers `{"stealth": false}` — so every run before this was measured on plain Chromium while
the notes said "stealth". Always read the flag back from `GET /browsers/{id}`; `openKernelSession`
now returns a `granted` object for exactly this reason.

Turning it on changed an outcome: **TickPick's event page went from permanently stalled to
loading in ~13s.** Per Kernel's docs stealth also attaches an ISP proxy and an automatic CAPTCHA
solver by default. Stealth works on the free tier and is worth having on by default.

### TickPick: the page is not the wall, the listings call is

Chasing the listings endpoint showed the page load was a false summit. TickPick fetches its
inventory from:

```
GET https://api.tickpick.com/1.0/listings/internal/event-v2/<eventId>?trackView=true
```

That endpoint is DataDome-protected and did not clear by any route tried:

| route | result |
|---|---|
| plain HTTP | 403, DataDome captcha payload |
| plain HTTP + Origin/Referer | 403, same |
| in-page fetch from a cleared Kernel page | `TypeError: Failed to fetch` (cross-origin subdomain) |
| navigating the stealth browser straight at it | 403, DataDome |

And the page itself is **inconsistent**: it cleared on 2 of 3 stealth attempts and returned a
403 DataDome wall on the third (93s). That smells like exit-IP reputation inside the stealth ISP
pool — some addresses are burned. Even on a page that loads, the DOM renders **zero** listing
rows, because the inventory call behind it is the thing being blocked.

So TickPick stays in the same bucket as SeatGeek and StubHub: blocked by DataDome, with a
residential egress IP the one remaining untested lever. The earlier note here that TickPick
"CLEARS" was about the page only and overstated it.

Team pages on all five are open — they are SEO surfaces carrying a JSON-LD `lowPrice` per game,
which is why the ladder uses them and why it can only ever report a get-in with **no section**.
The event pages hold the seats, and they are walled.

**A 200 is not a result here.** Vivid answers its wall with HTTP 200 and 1.9KB; Imperva and
Cloudflare interstitials are both 200. Wall detection is explicit in `detectWall()`, by body
marker, not status code.

### Three of the four walls are an IP-reputation problem, not a browser problem

TickPick, SeatGeek and StubHub all fail the same way on Kernel's datacenter egress. TickPick even
reports *"Verification successful"* and then stalls. Kernel sells residential proxies, which is
almost certainly the fix — but:

```
POST /browsers  {"proxy":{"id":"..."}}
-> 403 {"code":"insufficient_plan","message":"Proxies require a paid plan"}
```

**This still blocks SeatGeek and StubHub, but no longer TickPick.** A US residential proxy was
created fine (`pb-tickets-us`, id `sxrfyulouvfy2v41191ow63q`, IP 24.127.114.113) — attaching it to
a session is what needs the upgrade. Setting `KERNEL_PROXY_ID` retests both with no code change.

DataDome is the one wall stealth did not move. Both sites sat at 403 for 79s with stealth on, so a
different egress IP is the remaining variable worth paying to test.

### Headful vs headless changes what you can reach

Run as a controlled A/B, stealth on, two passes each:

| Site | headless | headful |
|---|---|---|
| StubHub | 0/2 — DataDome 403 after ~74s | **2/2 — page in ~7s, sections rendered** |
| SeatGeek | 0/2 | 0/2 |
| TickPick | 0/2 | 0/2 |

StubHub is the only site where the mode changed the outcome, and it changed it completely.
Plausible reason: a headful Chromium has a real compositor, real window metrics and real paint
timing, all of which DataDome fingerprints.

It is not free. Kernel gives a headful session **8GB against a headless one's 1GB** and bills per
GB-second, so headful costs 8x per second. At this scale that is $0.003/game instead of $0.0004 —
irrelevant in absolute terms, but it is the reason not to leave headful on by default.

### StubHub: reachable, but it is a cross-check and not a source

`lib/stubhub-listings.js` parses it, and the data is good: section, row, quantity and a real
all-in price per listing. The problem is how little of it there is.

StubHub renders a **curated shortlist, not an inventory** — 8 distinct listings on a real event,
and scrolling the panel added none. Gametime returns ~220 for the same kind of game, Vivid ~983.
No inventory API sits behind it either; the only XHRs are JS chunks and telemetry.

Eight listings cannot answer "cheapest per zone" across four zones without quoting a zone price
off whatever handful StubHub chose to show. So it corroborates Gametime and Vivid; it does not
price a game. Getting the full set would need map interaction or an API that has not been found.

Two parsing notes for whoever picks this up: the page has **no embedded JSON** and its CSS
classes are generated hashes (`bway-jTBMCa`) that churn on every deploy, so the parser reads the
card's rendered TEXT, which is user-facing and far more stable. And the same listing matches
three times at different DOM depths (24 matches for 8 listings), so it dedupes on section+row,
keeping the longest text because that is the copy that still has the price on it.

### Replays need headful

`POST /browsers/{id}/replays` on a headless session answers *"headless browsers don't support
replays at this time"*. Recording therefore forces `headless: false`, which `openKernelSession`
does automatically when `replay: true`. The dashboard's "live view not available in headless mode"
is a separate thing — that is real-time viewing, not recording. A replay survives session
deletion and downloads as an mp4.

## What Kernel does buy us today

**Vivid Seats, which is otherwise unreachable.** Its event page holds no listings at all; they
come from its own API:

```
GET /hermes/api/v1/listings?productionId=<id>&currency=USD&localizeCurrency=false
```

That endpoint is behind the same Imperva wall as the page, so it cannot be called from Node. It
*can* be called from inside a Kernel page, where the browser's cookies and TLS fingerprint apply
(`session.fetchInPage()`). One real production returned **966 listings**, each with section, row,
quantity and both pre-fee and all-in prices — richer than Gametime.

Two things that bite:

1. **Currency.** Kernel's egress came out of Canada and the endpoint localises, so the untouched
   request returns **CAD**. `currency=USD&localizeCurrency=false` is pinned, and the parser throws
   rather than quote the wrong currency. (Same bug class the repo already handles for StubHub.)
2. **Standing room.** Vivid sells it inline — 6 of 966 listings were `SRO7`, `SRO8` or
   `Lower Level 134 GA`. That last shape is the dangerous one: `134` reads as an ordinary
   lower-bowl section, so without filtering it becomes the cheapest "lower bowl" price and gets
   quoted as a seat. Vivid puts the marker in the **row** (`row: 'GA'`) as often as the section,
   so both are matched — `isStandingRoom` in scrape-price.js only checks the section.

## Cross-validation (the useful surprise)

Knicks v Wizards at MSG, cheapest lower-bowl all-in per zone:

| Path | center court | sideline | corner | behind basket | center-court section |
|---|---|---|---|---|---|
| Gametime — existing ladder | $240 | $194 | $98 | $92 | 107 |
| Gametime — through Kernel | $240 | $194 | $98 | $92 | 107 |
| Vivid Seats — through Kernel | $242 | $207 | $97 | $99 | 107 |

Gametime through both paths is byte-identical, so the Kernel step is not distorting anything. And
Vivid — a completely independent marketplace — lands within a few dollars on every zone and names
**the same section as center court**. That is real evidence the section map is right, which no
single-source run could give.

## Cost shape

Kernel is a hosted browser billed on session wall-clock: ~9-12s a page against plain HTTP's
~1.2-2.7s. It is never the cheap step.

Two consequences, both already in the code:

- It sits at the **bottom** of the ladder, after Firecrawl, and is **off by default**
  (`PRICE_SCRAPE_KERNEL=on` plus `KERNEL_API_KEY`). A step that silently joined the production
  ladder would change the thing being measured.
- `KERNEL_MAX_PER_RUN` defaults to 20, far tighter than Firecrawl's 150.
- One session is reused across the whole run (`openKernelSession`), so 5 games over 2 sites is
  ~1.6 page loads per game in **one** browser, not a browser per page.

A cost-per-100-games figure cannot honestly be quoted from the free tier — it reports no
per-session price. What is measured is page count and wall-clock; multiply by the paid plan's
per-browser-minute rate.

One caution on the timing ratio: Kernel looks *faster* than the ladder whenever the ladder had to
escalate to Firecrawl (on MSG: 9.7s vs 20.6s), and slower whenever plain HTTP answered on its
own. The harness prints which ladder step answered, because quoting the ratio alone is how a POC
talks itself into the wrong recommendation.

## Recommendation to Marx

**Use it for the sites that block us — not a switch, not a drop.** Specifically:

1. **Keep the HTTP ladder exactly as it is.** It is faster, free, and 28/28 on the data it covers.
2. **Adopt Kernel for Vivid Seats only, for now.** It is the only way to reach a second
   section-level source, and a second source is what makes the zone map trustworthy rather than
   self-reported.
3. **Decide on the paid plan.** It is the whole question for TickPick, SeatGeek and StubHub — all
   three fail on IP reputation, not on browser fingerprint. Without it this POC's ceiling is two
   sites; with it, plausibly five. That is a billing decision, not an engineering one.
4. **Do not use Kernel for Gametime in production.** It works and agrees exactly, which is useful
   as a correctness check, but it is strictly slower than the step we already have.

### Not yet done

- Residential-proxy retest of TickPick / SeatGeek / StubHub — blocked on the paid plan.
- SeatGeek's quantity modal (defaults to 2 tickets) is untested; it never got past DataDome, so
  the interaction question is still open behind the proxy one.
- Saved browser profiles are unused. Worth trying once proxies work: a profile that has already
  cleared a challenge should skip it next run.
- Session replay is wired (`replay: true`) but not captured for the shared run.
