# AI-1097 — Kernel browser POC

**Spike.** Can a hosted browser (Kernel) get us section-level ticket prices from the sites our
HTTP ladder cannot reach? Measured 2026-10-07/09 against live event pages, on the free tier and
then again on Hobbyist with proxies and persistent profiles.

**Answer: one site, Vivid Seats.** The paid plan was bought to test whether a residential IP would
unblock the other three. It did not unblock any of them, and it broke two configurations that
already worked. Details in [the IP-reputation section](#the-ip-reputation-theory-was-testable-on-the-paid-plan-and-it-was-wrong).

Code: [lib/kernel-browser.js](../../lib/kernel-browser.js) ·
[lib/vivid-listings.js](../../lib/vivid-listings.js) ·
harness [scripts/kernel-poc.js](../../scripts/kernel-poc.js) ·
paid-plan runs [scripts/kernel-wall-matrix.js](../../scripts/kernel-wall-matrix.js) ·
[scripts/kernel-datadome-probe.js](../../scripts/kernel-datadome-probe.js)

## The question this actually answers

Not "should we replace the scraper" — that was never in doubt. [lib/scrape-price.js](../../lib/scrape-price.js)
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

**It survived in a second place until 2026-10-09.** `openKernelSession` was fixed when this was
found, but `kernelPage` — the function behind `viaKernel`, the step that would join the
production ladder — still sent `stealth_mode`. So the one code path destined for production was
the one still running non-stealth. Both now send `stealth`.

Found alongside it, same function: `kernelPage` referenced `profileId` without declaring it, so
it would have thrown `ReferenceError` on **every** call the moment `PRICE_SCRAPE_KERNEL=on` was
set. Nothing caught it because the step is off by default and every measured run in this POC went
through `openKernelSession` instead. Fixed and smoke-tested end to end (200, real HTML back
through `viaKernel`).

The lesson both times: a flag the API accepts and ignores, and a dead code path nothing exercises,
fail the same silent way. The `granted` readback covers the first; only actually calling the
thing covers the second.

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

### The IP-reputation theory was testable on the paid plan, and it was wrong

TickPick, SeatGeek and StubHub all failed the same way on Kernel's datacenter egress. TickPick
even reported *"Verification successful"* and then stalled. The reading was that DataDome scores
IP reputation before it looks at the browser, so a residential IP would be the fix. On the free
tier that was untestable:

```
POST /browsers  {"proxy":{"id":"..."}}
-> 403 {"code":"insufficient_plan","message":"Proxies require a paid plan"}
```

The Hobbyist plan ($30/mo) includes proxies, so the grid got run. **The theory did not hold.**

`scripts/kernel-wall-matrix.js` — headless/headful x proxy/no-proxy, residential egress, stealth
on throughout, Vivid as the control because it already worked without a proxy:

| Configuration | SeatGeek | StubHub | TickPick | Vivid (control) |
|---|---|---|---|---|
| headless | DataDome | DataDome | DataDome | nav timed out (harness, not a block) |
| headless + proxy | DataDome | DataDome | DataDome | shell, **API 404** |
| headful | DataDome | **72 rows** | DataDome | **1,020 listings** |
| headful + proxy | DataDome | shell | shell, **API 403** | shell, **API 404** |

**The residential proxy did not unblock a single site, and it broke the two that worked** —
Vivid went 1,020 listings to zero, StubHub 72 rows to zero. Vivid is the control, so that is the
configuration failing, not the site.

The mechanism on Vivid is worth naming, because it is not a wall: its listings API answers **404**
on both proxy rows. The proxy's egress lands in a different locale and the productionId is not
found there — the same localisation trap that already returns CAD prices if the currency is not
pinned. A proxy does not just change reputation, it changes which catalogue you are querying.

Then the two levers AI-1097 named that had never been tried — proxy *type* and persistent
profiles (`scripts/kernel-datadome-probe.js`, headful throughout, profile runs warmed in a first
session and scored on the second):

| Egress | SeatGeek | TickPick | StubHub |
|---|---|---|---|
| mobile | DataDome | DataDome | shell |
| ISP | DataDome | Cloudflare | **73 rows** |
| mobile + warmed profile | DataDome | shell, 0 rows | **73 rows** |

Two things worth keeping from that:

- **ISP egress is the one proxy type that does not break StubHub.** Residential and mobile both
  take it to zero; ISP leaves it where no-proxy headful had it. If a proxy is ever needed for
  another reason, ISP is the one to use.
- **A warmed profile recovers StubHub on an egress that otherwise breaks it** — mobile alone is
  shell, mobile plus profile is 73 rows. That is the profile doing real work on a reputation
  system. It still does nothing for SeatGeek.

**SeatGeek is now DataDome in all seven configurations tested** — headless, headful, residential,
mobile, ISP, warmed profile, every combination of stealth. It is not an IP problem and it is not a
browser-mode problem. Apify gets 5,548 listings from it for less than a cent, so this stops being
worth chasing.

A caveat on those row counts: the probe counts DOM nodes matching `Section ... Row ...`, not
parsed listings. 72 and 73 are the same page. StubHub's real ceiling is still the **8 distinct
listings** two independent methods agree on, below.

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

### Replays need headful, and all nine from the paid-plan run download

`POST /browsers/{id}/replays` on a headless session answers *"headless browsers don't support
replays at this time"*. Recording therefore forces `headless: false`, which `openKernelSession`
does automatically when `replay: true`. The dashboard's "live view not available in headless mode"
is a separate thing — that is real-time viewing, not recording.

Recording is **opt-in and the session must be stopped, not just deleted** — stopping the replay is
what persists the video. Once persisted it outlives the session: a deleted session's replay still
downloads fine, which is why `scripts/kernel-replay.js` takes ids rather than listing live
sessions.

Every replay from the paid-plan probe was downloaded and checked, not just recorded — nine files,
44 KB to 475 KB, each with a real MP4 `ftyp` box. The commands are in the sheet tab. Hobbyist
retains them **7 days**, up from the free tier's 1, which is the difference between "share with
Marx" and "share with Marx today".

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

Kernel is a hosted browser billed on session wall-clock — $0.0000166667 per GB-second — at ~9-12s
a page against plain HTTP's ~1.2-2.7s. It is never the cheap step.

The paid plan makes it measurable rather than estimated. The two test runs above cost
**$0.0561** (4 sessions, the wall matrix) and **$0.0661** (9 scored sessions plus 3 warm-ups, the
probe) — $0.12 to answer the whole question, against Hobbyist's $10/month of included credits.

Two consequences, both already in the code:

- It sits at the **bottom** of the ladder, after Firecrawl, and is **off by default**
  (`PRICE_SCRAPE_KERNEL=on` plus `KERNEL_API_KEY`). A step that silently joined the production
  ladder would change the thing being measured.
- `KERNEL_MAX_PER_RUN` defaults to 20, far tighter than Firecrawl's 150.
- One session is reused across the whole run (`openKernelSession`), so 5 games over 2 sites is
  ~1.6 page loads per game in **one** browser, not a browser per page.

Headful is not free: Kernel gives a headful session **8GB against a headless one's 1GB** and bills
per GB-second, so headful costs 8x per second — $0.003/game instead of $0.0004. Irrelevant in
absolute terms, but it is the reason not to leave headful on by default. Vivid needs it, so Vivid
pays it.

One caution on the timing ratio: Kernel looks *faster* than the ladder whenever the ladder had to
escalate to Firecrawl (on MSG: 9.7s vs 20.6s), and slower whenever plain HTTP answered on its
own. The harness prints which ladder step answered, because quoting the ratio alone is how a POC
talks itself into the wrong recommendation.

## Recommendation to Marx

**Use it for one site. The paid plan answered the open question and the answer was no.**

1. **Keep the HTTP ladder exactly as it is.** It is faster, free, and 28/28 on the data it covers.
2. **Adopt Kernel for Vivid Seats only.** It is the only way to reach a second section-level
   source, and a second source is what makes the zone map trustworthy rather than self-reported.
   Headful, **no proxy** — the proxy breaks it.
3. **The $30/mo Hobbyist plan does not pay for itself on unblocking.** That was the case for
   upgrading and it did not survive the test: residential, mobile and ISP egress all leave
   SeatGeek, StubHub and TickPick exactly where they were, and residential actively breaks Vivid
   and StubHub. What the plan does buy is operational — 7-day replay retention, 10 concurrent
   browsers (the matrix ran 4 at once), and $10/month of credits that comfortably covers Vivid.
   Worth keeping for that, not for the walls.
4. **Use Apify for SeatGeek.** 5,548 seat-level listings at ~$0.008/event from the site Kernel
   cannot touch in any configuration. This is the bigger win and it is not a Kernel win.
5. **Do not use Kernel for Gametime in production.** It works and agrees exactly, which is useful
   as a correctness check, but it is strictly slower than the step we already have.

### Not yet done

- SeatGeek's quantity modal (defaults to 2 tickets) is still untested — nothing ever got past
  DataDome, and now that Apify is the route for SeatGeek the question is moot there.
- StubHub's full inventory. Two independent methods agree on 8 listings; getting more would need
  seat-map interaction, which nothing has tried.
- Wiring the two winners into the production refresh (Apify for SeatGeek, Kernel for Vivid) is a
  decision, not a discovery — neither is on the live ladder yet.
