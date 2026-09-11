# Telnyx Send Volume & the Carrier Cap

How we know what we're allowed to send, how much of it we've used, and where that shows up in
the app. Written up from the SendBlaster review call R&D: *"is there a Telnyx endpoint for
checking brand-level sending limits and volume sent?"*

Target Supabase project: **Playbook n8n** (`snfmggrnyjayuuxafats`).

```
Telnyx 10DLC API ──► vetting score ──► tier table ──► the cap (40,000/day)
                                                           │
Telnyx usage_reports ──► messages sent, per day/number/carrier ──► SUBTRACT ──► what's left
                                                           │
                                              telnyx_usage_daily ──► Reports tab
```

**The short answer:** Telnyx tells you the ceiling and never the remainder. There is no
consumption endpoint and no "remaining quota" field anywhere in the API. The only route to a
remaining figure is to count what we sent and subtract it ourselves — which is what this does.

---

## 1. Where the cap actually comes from

There is no endpoint that returns "40,000 per day". Telnyx returns a **vetting score**, and the
carriers publish a band table that turns that score into two limits.

```
GET /v2/10dlc/brand/{brandId}/externalVetting  ──►  vettingScore: 63
                                                          │
                                            band 50–74  ──┴──►  AT&T 2,400 TPM
                                                                T-Mobile 40,000/day
```

| Vetting score | AT&T SMS TPM | T-Mobile daily | |
|---|---|---|---|
| 75–100 | 4,500 | 200,000 | |
| 50–74 | 2,400 | **40,000** | ← us, score 63 |
| 25–49 | 240 | 10,000 | |
| 1–24 | 240 | 2,000 | ← us until June 2026 |
| unvetted | 240 | 2,000 | ← NYC Basketball brand |

Source: Telnyx, *Improve 10DLC Rate Limits With Better Trust Scores*.

**The score moves, and nothing used to notice.** Ours went 16 → 63 on 2026-06-09 after a re-vet
with the IRS letter, which took the daily cap from 2,000 to 40,000 — a 20× change that lived
only in a Slack thread. `api/telnyx-usage-sync.js` now re-reads the score on every run for
exactly this reason.

Worth knowing: the 63 came from **WMC Global**, not Aegis. Aegis scored us 16 twice, including
on the ENHANCED class. Highest active score wins, so if anyone proposes re-running Aegis to lift
the tier, that's the vendor that already failed us twice.

## 2. Which carrier limits what

Four separate limits get conflated constantly, because "rate limit" means four different things
depending on who set it. **Only one of them is a daily quantity that can run out.**

| Limit | Kind | Set by | Ceiling | Applies to |
|---|---|---|---|---|
| T-Mobile daily volume | **quantity** | T-Mobile, via TCR | 40,000/day per brand | T-Mobile-bound messages only |
| Account rate limit | speed | Telnyx | 3,000/min | Everything, every number, combined |
| AT&T throughput | speed | AT&T, via TCR | 2,400 segments/min | AT&T-bound segments only |
| Unregistered long code | speed | Telnyx / industry | 0.1/sec ≈ 6/min | Any number on no campaign |

A quantity fills up and empties at midnight UTC. A speed never runs out — you either exceed it in
a given minute or you don't. **Nothing here is nested inside anything else**: a single T-Mobile
message is counted by the daily cap *and* by the account rate limit, and neither contains the
other.

**The carrier is the recipient's, not ours.** We don't choose it — it's whoever the person we're
texting has service with. That's why `normalized_carrier` is a *dimension* in usage_reports:
it's discovered per message, not configured. Across 30 days our traffic was only **15.9%**
T-Mobile.

**Two different failure modes.** Breach a *speed* and Telnyx queues the overflow and releases it
gradually; that queue holds about **1 hour** (the portal's figure — public docs say 4), then it
refuses with error `40318`. Breach the *daily* limit and there's no queue at all: T-Mobile stops
accepting until midnight UTC. The daily one is harsher, which is why the report watches it and
not the speeds.

Account and per-number rate limits are visible only in the portal
(**Messaging → Programmable Messaging → Rate Limits**) — there is no API for them. Long code has
no row there, because a long code's rate comes from its 10DLC campaign registration rather than
a Telnyx setting.

## 3. Per brand, not per account

**The cap is a brand-level limit**, shared across every campaign and number under that brand. We
have two live brands with very different allowances:

| Brand | Entity | TCR | Vetting | Cap | Campaigns |
|---|---|---|---|---|---|
| Playbook | Playbook AI Solutions Inc. | `BDOF01M` | 63 | 40,000/day | 11 (9 with no numbers) |
| NYC Basketball | Social City LLC | `B95W6JI` | **unvetted** | 2,000/day | 1 (`CV6C53O`, 47 of 49 numbers) |

A third, "Playbook Test", is a failed mock registration (invalid EIN) and is ignored.

**This is not cosmetic.** An earlier cut of `api/telnyx-usage.js` compared all volume to the
*lowest* cap on the account and read Playbook's 1,416 T-Mobile messages against NYC Basketball's
2,000 ceiling — **70.8% of allowance consumed, when the real figure against Playbook's own
40,000 was 3.5%.** A cap alarm that cries wolf at 3.5% is worse than no alarm.

`usage_reports` has no brand or campaign dimension, so the join is ours to maintain:

```
usage_reports (tn) ──► /10dlc/phone_number_campaigns/{tn} ──► brandId ──► telnyx_brands.cap
```

That lookup also returns `assignmentStatus` and the per-carrier `tmobileNumberMappingStatus` /
`attNumberMappingStatus`. A **404 means the number is on no campaign at all.**

## 4. Data model

Migrations [`068`](../migrations/068_telnyx_usage_daily.sql) and
[`069`](../migrations/069_telnyx_sender_brand.sql). All three tables are RLS-on with no anon
policy — the browser reads through `/api/telnyx-usage`, which holds the service role.

| Table | What |
|---|---|
| `telnyx_usage_daily` | One row per day / sending number / carrier / direction. `msg_count` + `segments` + `cost`. A cache of usage_reports aggregates, not a per-message log. |
| `telnyx_senders` | Sending number → inbox label, plus its current `brand_id` / `tcr_campaign_id` / `assignment_status`. |
| `telnyx_brands` | Per-brand vetting score and the two limits derived from it, with `checked_at`. |

`telnyx_senders.brand_id` is a cache of the **current** assignment, not history — a number can
move between brands (`+1 609 360 2796` moved from `CV6C53O` to Playbook's `C8LB7XX` on
2026-08-10). Over a 30-day rolling window that's the right trade; if per-day historical
attribution is ever needed, `brand_id` belongs on `telnyx_usage_daily` instead.

Segments are stored separately from message count because **AT&T rate-limits segments, not
messages**: 160 GSM-7 characters is one segment, so a 320-character blast burns the allowance
twice as fast as its message count suggests. usage_reports calls this `parts`.

## 5. The two endpoints

**[`api/telnyx-usage-sync.js`](../api/telnyx-usage-sync.js)** — nightly cron, 13:10 UTC (ten
minutes ahead of `cakemail-sync`). Pulls volume, discovers every sending number in the traffic
and resolves its brand, then re-reads each brand's vetting score. Upserts on the natural key, so
a missed night repairs itself on the next run with no catch-up job. `?days=90` for a one-off
backfill.

Needs `TELNYX_API_KEY` and `CRON_SECRET` in the environment. **Without them the cron 500s while
the Reports tab keeps rendering the data it already has** — it looks fine and goes quietly stale.

**[`api/telnyx-usage.js`](../api/telnyx-usage.js)** — read path. Does the subtraction and the
per-brand attribution, and returns `by_day`, `by_brand`, `by_carrier`, `by_inbox`.

Both are gated by `lib/auth.js` (`CRON_SECRET` bearer, or a signed-in Playbook account).

## 6. API gotchas

Every one of these was found by hitting it. All verified against the live API, September 2026.

| Gotcha | Symptom |
|---|---|
| **31-day maximum** on any interval | `date_range=last_31_days` → 400 `10006`; explicit start/end over 31 days → 400 `10004`. Backfills walk 30-day windows. |
| **`filter[x]` needs x already in `dimensions`** | `dimensions=date` + `filter[direction]=outbound` → 400 `10007 Invalid dimensions_filter value`. Direction is a dimension; filtering happens in code. |
| **`end_date` is exclusive** | Passing `...T23:59:59Z` silently drops the final second of each day. The bound is midnight on the *following* day. |
| **The dimension is `profile_id`** | `messaging_profile_id` → 400. `tn` is also a dimension, which is what makes per-number attribution possible. |
| **Default `page[size]` is 20** | A sync ignoring `meta.total_pages` doesn't fail — it silently reports a fraction of the volume. |
| **`tcr_campaign_registered` is a *billing* flag** | Not a registration flag. Numbers demonstrably `ASSIGNED` with `tmobileNumberMappingStatus=ADDED` still report `false`, and all 89,552 messages came back `false`. Use `/10dlc/phone_number_campaigns/{tn}` for registration status. |

The authoritative dimension list is `GET /v2/usage_reports/options?product=messaging` — the docs
page is incomplete and omits `tn` and `profile_id`.

**A managed sub-account key is enough.** Ours 403s on `/v2/managed_accounts` and
`/v2/number_lookup` (`10010`), but every 10DLC endpoint and `usage_reports` returns 200. No owner
key is needed for any of this.

## 7. The Reports tab

`ui/index.html`, last tab. One collapsible panel per report; adding another is one `<details>`
sibling. Contents, in order:

1. **Sent today** (all carriers), then a separately-labelled *"Against the only cap — T-Mobile"*
   block with used / left / % of cap.
2. **Where messages went** — carrier chips, toggling Today / Last 14 days. Only T-Mobile has a
   denominator; the rest are running totals with no ceiling behind them.
3. **Messages per day** — 14 stacked bars. Full bar is everything sent; the coloured foot is the
   T-Mobile portion. Scaled to the busiest day, coloured by cap pressure.
4. **1 · By brand** — each brand against its *own* ceiling.
5. **2 · By inbox** — per sending number, split T-Mobile / AT&T / Verizon / Other, with
   unregistered numbers badged.
6. **3 · The rules** — the four limits from §2, two read live and two recorded from the portal.

Everything below the headline is a **rolling 14 days**, not today. Only the cap resets, at
midnight UTC — which is mid-morning in Manila, so "today" flips during the working day.

The panel is deliberately **not** called "SMS volume". It answers a compliance question, and its
numbers will not agree with Market History, which also counts CakeMail and Salesmsg.

## 8. Where we actually stand

Read from the API, 30 days to 2026-09-10.

- **89,552 outbound**, of which **14,225** to T-Mobile — a 15.9% share, not the ~⅓ national
  average an early estimate assumed.
- **Busiest day 8 Sep: 7,618 sent, 1,416 T-Mobile = 3.54% of the cap.**
- AT&T's heaviest day was 4,640 segments — and that's a *daily* total against a *per-minute*
  ceiling of 2,400.
- The n8n bulk workflow sends at `batchSize 5 / 1100ms` ≈ **273/min**, about 9% of the account's
  3,000/min. A 12,000-message blast takes ~44 minutes instead of ~4.

**We are nowhere near any ceiling.** Neither appealing for a higher vetting score nor opening a
second campaign under another entity is needed to unblock current volume.

**~88% of all volume is one number**, `+1 315 998 8112` (Ticketblast), on the shared Playbook
brand. Any cap alarm has to count it — a SendBlaster-only counter would watch a fraction of a
percent of the traffic and report all-clear while the brand filled up.

## 9. Not covered, and open items

**Salesmsg is invisible here.** The `salesmsg:<team>:<phone>` sender route in
[`api/queue-tick.js`](../api/queue-tick.js) never touches Telnyx and runs under Salesmsg's own
10DLC brand. It cannot appear in this report at any date range, and its volume doesn't consume
the Telnyx cap.

Open items, none of them blocking the report:

- **`+1 615 805 0766` is on no 10DLC campaign** — 404 from the assignment endpoint, while it has
  still sent traffic. SendBlaster's hardcoded sender in
  [`n8n/bulk-send-workflow.json`](../n8n/bulk-send-workflow.json). Unregistered long codes are
  carrier-filtered and throttled to ~6/min regardless of brand tier. **Own ticket.**
- **Nine ACTIVE campaigns with zero numbers** on the Playbook brand. Telnyx caps a brand at five;
  we hold eleven, each carrying recurring TCR fees.
- **`CV6C53O` is 47 of 49 numbers**, with 39 dead `FAILED_ASSIGNMENT` rows alongside.
- **The NYC Basketball brand is unvetted** — 2,000/day on its own allowance. Fine while almost
  nothing sends from it; worth vetting before anything does.
- **`unidentified` was 13% of traffic** (5,346 messages) — Telnyx returned no carrier, usually
  landlines or VoIP. Possibly a list-quality problem rather than a cap one.
- **The send log disagrees with Telnyx.** Telnyx reported 100 outbound from the SendBlaster
  number in 30 days; `telnyx_messages` records 11 outbound ever. Something sends on that number
  without being logged.
