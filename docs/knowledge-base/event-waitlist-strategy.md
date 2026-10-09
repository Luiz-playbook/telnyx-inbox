---
name: event-waitlist
description: Event Waitlist blast strategy for SendBlaster. Manufactures demand in markets where no event exists yet. Triggers on mentions of waitlist, untouched markets, new state expansion, or opening a market.
---

# Event Waitlist Strategy

*One of four SendBlaster strategies. Chief of Staff working doc.*

## Philosophy (from Josh)

Ticket, suite and Teammate AI all sell against an event that is already on the calendar. Event Waitlist is the only strategy that runs where there is no event yet. It is not a blast, it is a demand instrument. We are not asking people to buy, we are asking them to raise a hand so Dan has a number to point at when he decides where to put a date.

### Core Principles

1. **No event means no pitch** - The ask is interest, not tickets. The second this reads like a sale into a market that has never heard of us, it is dead.
2. **Shared history or it does not ship** - Same log as ticket, suite and Teammate. The skill must see last blast this market same strategy, last blast this market any strategy this brand, last blast this market any strategy at all.
3. **Exhaustive queue, always** - Every untouched market appears in priority order. Never a partial list.
4. **Cooldown is global** - Minimum 25 days since the last blast to that market, regardless of which strategy sent it.
5. **Suppression binds everything** - A contact suppressed under any Playbook brand or strategy, Teammate included, is suppressed here. No exceptions.
6. **Personalization is earned** - ICPs get it. SCP and below never do.
7. **Nothing auto-sends unblessed** - Cole quarterbacks every send through the review UI. Snoozes carry feedback into the Learning tab.
8. **Threshold converts, not the calendar** - The waitlist stays open until the market hits the number. Then it flips to a ticket blast against a real date.

### What to Research Per Market

- [ ] Has any Playbook event ever run here (Dan's list)
- [ ] Target sport org count from the scrape pipeline
- [ ] ICP and SCP density in the market
- [ ] BDA and AE who own the territory
- [ ] Last and next suite anywhere nearby
- [ ] Nearest market where we have run a successful event
- [ ] Days since last blast, this market, any strategy, any brand
- [ ] Whether a metro is obvious or the state needs splitting

### Waitlist Link

All sequences use: `[waitlist_link]`

---

## Target Markets

Dan's answer to "what states have we never done an event in", 16 Sep 2026:

| State | Note |
|-------|------|
| **Hawaii** | Cold |
| **Alaska** | Cold |
| **New Mexico** | Cold |
| **Maine** | Cold |
| **New Hampshire** | Cold |
| **Delaware** | Cold |
| **Alabama** | Cold |
| **Idaho** | Boise presence, no date run. Warm start. |
| **Iowa** | Cold |
| **Arkansas** | Cold |
| **Massachusetts** | Cold |
| **Mississippi** | Cold |
| **Montana** | Cold |
| **North Dakota** | Cold |
| **South Dakota** | Cold |
| **Rhode Island** | Cold |
| **Vermont** | Cold |
| **Wyoming** | Cold |

Eighteen states. Idaho is the only warm entry.

**PROPOSED:** run state level to start, break to metro the moment signups cluster. A waitlist for Montana is not actionable. A waitlist for Billings is.

---

## Queue Fields

Every row in the Event Waitlist queue carries:

| Field | Source |
|-------|--------|
| **Market** | Dan's untouched list |
| **Days since last blast, this strategy** | Shared history log |
| **Days since last blast, this brand** | Shared history log |
| **Days since last blast, any strategy** | Shared history log |
| **Last suite in market** | Suite master sheets |
| **Next suite in market** | Suite master sheets |
| **BDA** | Territory map |
| **AE / rep** | Territory map |
| **Signups to date** | [waitlist_store] |
| **Signups to threshold** | Calculated |

**PROPOSED prioritization for cold markets.** Open and click history does not exist in a market we have never touched, so the usual ranking inputs are unavailable. Rank on: target org density, ICP and SCP density, whether a BDA or AE already covers it, proximity to a proven market, and whether a suite is scheduled nearby.

---

## Segmentation

| Tier | Copy | Channels | Framing |
|------|------|----------|---------|
| **ICP** | Personalized | iMessage first (roughly 2x response), Mailmeteor, LinkedIn | Premium, first look, VIP |
| **SCP** | Templated, market-level personalization only | CakeMail, Telnyx SMS | Standard |
| **Non-ICP / non-SCP** | Fully templated | CakeMail | Standard, never personalized |

---

## Sequence Flow

**PROPOSED.** The record does not set a cadence for this strategy.

```
Day 0:  Email #1 (the ask)
Day 3:  SMS #1 (ICP + SCP only, one line)
Day 10: Email #2 (social proof from a comparable market)
        --- market hits threshold ---
Day X:  Email #3 + SMS #2 (date announced, converts to ticket blast)
        --- market still below threshold ---
Day 45: Email #4 (dormant re-ask)
```

**PROPOSED threshold:** enough signups in one metro to justify a date. Dan and Cole set the number.

---

## Day 0: Email #1

**From:** BDA or AE who owns the territory
**Subject (ICP):** Bringing a [Sport] event to [State]
**Subject (SCP / non-ICP):** [Sport] event in [State]?

### ICP version

Hey [First Name],

We run [Sport] events across [N] states and [State] is not one of them yet. That is a gap, not a decision.

I am building a list of [State] organizations who would want in if we brought a date to [Metro]. No commitment on your side. If enough interest comes back I take it to our events team, we schedule it, and you get first look at dates and pricing before it goes public.

[Personalization hook: their program, their season, something specific]

Worth a spot on the list?

Best,
[Sender Name]
[Sender Title]

### SCP / non-ICP version

Hi there,

We host [Sport] events around the country and have not run one in [State] yet.

We are gauging interest before committing to a date. If you would want early access to dates and pricing for a [State] event, add your organization here:

→ [waitlist_link]

No obligation. We only move forward if there is real demand in the market.

Best,
[Sender Name]
Playbook

---

## Day 3: SMS #1

**From:** BDA or AE
**Send to:** ICP and SCP only

Hey [First Name], [Sender Name] at Playbook. Building a waitlist for a [Sport] event in [State]. Want me to put [Org Name] on it? [waitlist_link]

---

## Day 10: Email #2 (Social Proof)

**Subject:** re: [original subject]

Hey [First Name],

Bumping this on the [State] waitlist.

[Comparable Market] was in the same spot last year, nothing on the calendar. We ran a date there once enough orgs raised their hand. [Proof point: turnout, orgs represented, what came out of it]

Still building the [State] list:

→ [waitlist_link]

Best,
[Sender Name]

---

## Threshold Hit: Email #3 + SMS #2

Fires the moment the market clears the signup threshold. This is the handoff point where Event Waitlist converts into a ticket blast against a real date.

### Email #3

**Subject:** [State] is happening: [Event Date]

Hey [First Name],

You are on the [State] waitlist, so you are hearing this first.

[Event Name] is confirmed for [Event Date] at [Venue].

Waitlist pricing is [Price] and holds until [Deadline]. After that it goes to general release at [Public Price].

→ [registration_link]

Best,
[Sender Name]

### SMS #2 (same time as email)

[First Name], the [State] event is confirmed: [Event Date], [Venue]. Waitlist pricing holds until [Deadline]. [registration_link]

---

## Day 45: Email #4 (Dormant Re-ask)

Only fires if the market is still below threshold.

**Subject:** Still interested in a [State] event?

Hey [First Name],

We have not hit the number we need to put a [State] date on the calendar. Keeping the list open.

If anything has changed on your end, or you know other [State] organizations who would want in, just reply and let me know.

Best,
[Sender Name]

---

## OPEN QUESTIONS FOR JOSH

1. What signup threshold triggers scheduling a date, and is it per state or per metro?
2. Does Event Waitlist get its own 25 day cooldown, or share the global market cooldown with ticket and suite?
3. Where do signups land: HubSpot lifecycle stage, Supabase table, or suite master sheets?
4. Do all 18 states run at once, or in priority batches?
5. Teammate strategy is the other half of the original ask and is not covered here.

---

*Reconstructed from the email record, not pulled from OpenClaw. Sources: Event waitlist strategy thread (16-21 Sep), building blaster tool thread (9-21 Jul), SendBlaster working notes. Sections marked PROPOSED are filled where the record is silent and need a call from Josh, Cole or Dan.*
