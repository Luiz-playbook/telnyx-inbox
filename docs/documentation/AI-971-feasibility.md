# AI-971 — performance data on Market History: what is attainable

Investigation against live CakeMail, HubSpot and Supabase on **2026-09-08**, before building,
as the ticket asks. Every number below was measured, not estimated.

Short version: **opens and clicks are already captured and just need showing**; **replies are
attainable for email via HubSpot with a stated method, and not attainable for SMS**; **recipients
are retrievable from CakeMail and carry a HubSpot contact id**, so demos join on an exact key
rather than a fuzzy name match — the remaining approximation is about WHEN, not WHO.

Per-recipient opens and clicks exist in CakeMail's API but are blocked by the PAT's scope (§3);
a token with the logs scope would unlock them.

---

## 1. Email engagement — already captured, never surfaced

All 22 CakeMail report fields are already synced into `blast_templates` and populated for
**302 of 303 campaigns** (the 303rd is a production test campaign that returned no report):

| stored | |
|---|---|
| volume | `sent_emails`, `active_emails` |
| opens | `opens`, `unique_opens`, `unopens`, `implied_opens` |
| clicks | `clicks`, `unique_clicks`, `forwards` |
| failure | `bounces` + 8 sub-types (hard, soft, dns_failure, full_mailbox, mail_blocked, transient, address_changed, challenge_response) |
| complaints | `spams`, `unsubscribes` |
| rates | `open_rate`, `click_rate`, `clickthru_rate`, `unopen_rate`, `bounce_rate`, `unsubscribe_rate`, `spam_rate`, `sent_rate` |

Rates are CakeMail's own definitions, stored verbatim: `open_rate` is against `active_emails`
and `clickthru_rate` is clicks-over-opens. `v_market_performance` already weights on those exact
definitions, so they must not be recomputed. Scale is consistent across the seeded and synced
eras (median open rate 15.8% vs 16.7%), so there is no unit mismatch to correct.

**Work needed: display only.** No new capture, no migration.

### What CakeMail does NOT expose

Dumped the live report payload for campaign 15452062. There is **no reply field of any kind** —
no replies, no responses, no conversation count. Opens, clicks, bounces, unsubscribes, spam and
forwards is the complete set. Any reply number must come from elsewhere.

---

## 2. Reply count — attainable for email, not for SMS

### Email: yes, via HubSpot, matched on subject line

Blast sender is `Josh Marcus <Josh.marcus@callplaybook.com>` with **no `reply_to_email` set**, so
replies go to Josh's own mailbox. That mailbox is connected to HubSpot: **19,320 incoming emails
logged**, associated to contacts.

Verified end to end on a real blast:

| | |
|---|---|
| blast | Atlanta, **2026-08-04**, subject `tickets to see Messi & quick call`, 3,444 sent |
| HubSpot | **7** incoming emails, subject `Re: tickets to see Messi & quick call`, 2026-08-04/05 |

Subject and timing both match. The same holds for `Final Call for Packers Tickets` (Wisconsin,
2026-07-10).

**Proposed method.** Strip a leading `Re:` / `RE:` / `Fwd:` / `[External]` from the incoming
subject, match it to `blast_templates.subject`, and scope to a window opening at
`scheduled_for`.

**Known limit, stated rather than hidden.** 289 of 303 subjects are distinct (95%); **9 subjects
are reused across markets** — `Catch Messi live with a quick call` was sent to Miami, Columbus
Ohio and Illinois on the same day, and to Miami again in July. Subject alone cannot say which of
those a reply belongs to. Two disambiguations, in order:

1. match the replying contact's email or organisation to the market's audience (§3);
2. failing that, attribute to the nearest preceding send.

For the ~5% that stay ambiguous, the honest options are to split the count across the candidate
blasts or mark it ambiguous. **Recommend marking it**, since a split figure invites being summed.

### SMS: no, and the reason is not fixable here

- `telnyx_messages` holds **22 rows across 3 counterparties, all July 2026** — it is the 1:1
  inbox, with no blast concept in it at all.
- **Zero inbound Telnyx messages** fall within 7 days of any recorded SMS blast.
- SMS blasts stopped **2026-06-23** (Textable), before Telnyx traffic began.

There is nothing to count. This is the same gap AI-970 left open: until the Telnyx path records a
blast-level send, SMS has neither a send history nor a reply count. **Needs Charles.**

---

## 3. Recipients — retrievable, and they carry a HubSpot key

**Added 2026-09-08 after probing the CakeMail API directly.** This supersedes the market-based
reconstruction described in the first draft of this section, which is no longer the best method.

### What a recipient record contains

`GET /lists/{list_id}/contacts` returns, per person:

| field | example |
|---|---|
| `email` | `thefieldhouseyakima@gmail.com` |
| `custom_attributes.firstname` / `.lastname` | Lars / Ringsrud |
| **`custom_attributes.recordid`** | **51739921** |
| `status` | active, active_bounced, inactive_bounced, unsubscribed, spam |
| `bounces_count`, `last_bounce_type` | 0, none |
| `subscribed_on` | epoch seconds |

**`recordid` is the HubSpot contact ID.** Verified against HubSpot on three sampled contacts,
3/3 exact, with names and emails matching:

    38554155 -> Audrey Graves,  audro@live.com,                WA
    37211702 -> Zach Sutton,    zach@crosshealthcare.org,      ID
    51739921 -> Lars Ringsrud,  thefieldhouseyakima@gmail.com, WA (The Fieldhouse Yakima)

So the demo join is an **exact key lookup, not a fuzzy match on org name and email**. The ticket
assumed the latter and accepted approximation on that basis; it is not needed for identity.

    blast -> list_id -> /lists/{id}/contacts -> recordid (= HubSpot contact id)
          -> MEETING_EVENT with a demo activity type associated to that contact
          -> booked within N days of the send

These contacts do NOT join to our own `market_contacts`: 0/25 matched on either id or email. The
CakeMail lists were built from HubSpot, not from that table.

### The two real caveats — both about time, not identity

**Lists are reused across campaigns.** 303 campaigns share only **99 distinct lists**: the
Pennsylvania list has been sent to 7 times, Georgia 9. So a roster identifies the market's
audience, not which specific campaign a person received. Where two campaigns share a list,
attribute to the nearest preceding send and say so.

**Membership is current, not a send-time snapshot.** The Washington State list holds **2,684
contacts today** (2,073 active) against `sent_emails` 2,051 for the 2026-09-03 campaign. Someone
added since the send would be counted as a recipient; someone removed would be missed.

That second one is fixable going forward but not backwards: snapshot the roster at send time and
the attribution becomes exact. Worth doing in `lib/cakemail.js` at the schedule step regardless of
this ticket.

### Per-recipient engagement is blocked by token scope

`GET /logs/campaigns/{id}` is the endpoint that says **who** opened and **who** clicked. It
returns:

    403  {"msg":"Insufficient scope","type":"forbidden","code":3204}

Not an account or plan limit — the production sub-account's separate PAT returns the same 403,
as do `/logs/lists/{id}` and `/lists/{id}/segments`. **A PAT issued with the logs scope would
unlock per-person opens and clicks.** Worth asking Cole for, because it turns "247 people opened
this" into "these 247 people opened this", which is the version that feeds follow-up.

### What IS reachable today

| endpoint | gives |
|---|---|
| `/lists/{id}/contacts` | roster: email, first/last name, HubSpot recordid, status, bounce state |
| `/lists/{id}` | list metadata |
| `/reports/campaigns/{id}/links` | per-link clicks — unique and total, per URL |
| `/reports/campaigns/{id}` | the 22 aggregate metrics already synced |

The link report reconciles with the campaign totals: campaign 15452062 reports `unique_clicks` 10
and `clicks` 19, and its single link reports unique 10, total 19.

Contact `status` is per-person and cumulative, so **who has bounced or unsubscribed is knowable
today** — just not which campaign caused it.

### Replies are not in CakeMail at all

Confirmed in §2: no reply field on any campaign surface. Replies go to Josh's mailbox and are
visible through HubSpot, matched on subject line.

## Recommendation

Build in this order, because the value is very unevenly distributed against the effort:

1. **Show the CakeMail metrics.** Already captured, already correct. Display work only.
2. **Reply count by subject match.** One join, method documented above, ~95% unambiguous.
3. **Demos booked**, joined on the HubSpot contact id carried in each CakeMail recipient — an
   exact key, so the market bridge is no longer on the critical path for this. The bridge rows
   are still needed for the Market column and for the decider.
4. **Feed all three to the planning agent.** Straightforward once 1–3 land.

Not buildable: **SMS replies**, and **SMS engagement of any kind**, until the Telnyx path records
blast-level sends.

Two AC items cannot be met as written and should be amended on the ticket:

- *"Each blast shows a reply count"* — email only. SMS has no source.
- *"Blasts with no engagement show zero rather than a blank"* — correct for opens and clicks;
  wrong for demos on the 77 unmappable blasts, which must read unknown rather than zero.

The 10-blast demo spot check in the ACs should happen **after** the bridge rows are added, or it
will measure the mapping gap rather than the matching method.
