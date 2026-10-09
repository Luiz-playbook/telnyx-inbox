# PlayClaw CSM Book-a-Meeting Sequences

Source: `book-a-meeting-sequences/` in the PlayClaw export. Verbatim. Back to [[10-06-2026]].


---

<!-- file: README.md -->
# Book-a-Meeting Escalation Sequences v2.0

## Philosophy (from Josh)

This isn't a DMV reminder system. We're genuinely excited to show clients what we've built for them. Every message should feel like it's from someone who actually cares about their business.

### Core Principles

1. **Urgency + Excitement Upfront** — First email and SMS go out together, high energy
2. **Reference Their Story** — Pull from last 3 meetings: their sports, their struggles, their wins
3. **Own Our Issues** — If they had product problems: "We've been working hard on your feedback. Really excited to show you the progress."
4. **Escalate Meaningfully** — Not just "following up" but "I spoke with our product team about X"
5. **Always Include CTA** — 100% of messages have booking link + question about availability
6. **Human BTWs** — Add value-adds that sound like a friend: "BTW saw you guys had a tournament this weekend!"
7. **Acknowledge the Noise** — "I know how busy you must be. Sorry for all the messages."
8. **Team Escalation** — Tomas/Spencer jump in after 1-2 days stall; BDA assigned if still dark after 2 more

### What to Research Per Client

- [ ] Sports/league type (basketball, volleyball, etc.)
- [ ] Why they switched to Playbook
- [ ] How long they've been with us
- [ ] Risk status (churn score trends)
- [ ] Processing trends (going up/down/stalled?)
- [ ] Health score
- [ ] Key issues from transcripts
- [ ] What they care about (speed? simplicity? mobile?)

### Booking Link
All sequences use: `https://calendly.com/playbook-csm/client-check-in`

---

## Sequence Flow

```
Day 0: Email #1 + SMS #1 (simultaneous, high energy)
Day 2: Email #2 (add value, reference something specific)
Day 3: SMS #2 (casual check-in)
Day 5: Tomas/Spencer Email (escalation to senior person)
Day 7: SMS #3 (apologetic, persistent)
Day 9: If still no response → Alert BDA/AE, assign daily call task
```

---

## Client Mockups

See individual files:
- `slay-basketball.md`
- `next-gen-sports.md`
- `team-esface.md`


---

<!-- file: slay-basketball.md -->
# SLAY Basketball — Book-a-Meeting Sequence

## Client Profile

| Field | Value |
|-------|-------|
| **Company** | SLAY Basketball |
| **Sport** | Basketball (youth/AAU) |
| **Tenure** | 17+ meetings in system |
| **Risk Status** | Medium-High (fluctuating 5-8/10 churn scores) |
| **Recent Issues** | Mobile app stability, Team Builder usability ("working harder not smarter"), reporting trust issues ("different number every time") |
| **What They Care About** | 300-member growth goal, roster management, reliable reporting |
| **Processing Trend** | Active but experiencing friction |
| **CSM** | [Assigned CSM name] |

## Key Insights from Transcripts

1. **March 13:** CSM abruptly ended call without booking follow-up; mobile app stability issues raised
2. **March 10:** High frustration — "working harder and not smarter" with Team Builder; don't trust reporting ("different number every time")
3. **February 13:** Wanted automated lead integration (rejected), disclosed critical bug preventing team invites

**Emotional State:** Frustrated champion trying to make it work, needs visible wins

---

## Day 0: Email #1 + SMS #1

### Email #1
**From:** CSM
**Subject:** Quick update + some stuff I'm excited to show you

Hey [First Name],

Hope you're doing well! I know things got a little choppy on our last few calls — the Team Builder frustrations, the reporting numbers not lining up, and that team invite bug we were dealing with.

I wanted to reach out because we've actually made some solid progress on the stuff you flagged. The engineering team specifically worked on the team invite issue and I'd love to walk you through what's changed. I think you'll like it.

Also want to make sure we're on track for that 300-member goal — I've got some ideas on how we can use the system to actually help get there instead of creating more work.

Can you grab 15-20 min this week or early next?

→ Here's my link: https://calendly.com/playbook-csm/client-check-in

Or just reply with a couple times that work and I'll send an invite.

Talk soon!

Best,
[CSM Name]

---

### SMS #1 (same time as email)
**From:** CSM

Hey [First Name]! Just sent you an email — we've made some progress on the Team Builder stuff you mentioned and I'd love to show you. Got 15 min this week? https://calendly.com/playbook-csm/client-check-in

---

## Day 2: Email #2 (Add Value)

**Subject:** re: Quick update + some stuff I'm excited to show you

Hey [First Name],

Just wanted to bump this — I know you're probably in the middle of tryouts/season prep madness.

BTW, I was thinking about your 300-member target and wanted to share something a few other basketball programs have been doing. They're using automated follow-up emails after registration abandonment and seeing like 15-20% recovery. Could be a quick win for you.

Happy to walk through that setup when we connect. What does your week look like?

→ https://calendly.com/playbook-csm/client-check-in

[CSM Name]

---

## Day 3: SMS #2

Hey! Following up on my email. I know the numbers not matching up was frustrating — we fixed some stuff and I want to make sure you see it. Any time work this week?

---

## Day 5: Tomas Email (Escalation)

**From:** Tomas Borba
**Subject:** Checking in from the Playbook team

Hey [First Name],

Tomas here from Playbook — I work closely with [CSM Name] and wanted to personally reach out.

I know you've had some friction with the Team Builder and reporting lately, and I wanted you to know we've been actively working on those issues. [CSM Name] mentioned you're pushing toward a 300-member goal and I'd love to make sure we're actually helping you get there, not getting in the way.

Would you have 15-20 minutes this week to connect? I can join the call if helpful, or it can just be you and [CSM Name] — whatever works best.

→ https://calendly.com/playbook-csm/client-check-in

I know how busy this time of year gets. Really appreciate you making the time.

Best,
Tomas Borba
Customer Success Lead, Playbook

---

## Day 7: SMS #3 (Apologetic, Persistent)

Hey [First Name] — I know I've sent a few messages, sorry for the inbox noise. We really did make some improvements I think will help and don't want you to miss them. Even 10 min works: https://calendly.com/playbook-csm/client-check-in

---

## Day 9: Escalation to BDA/AE

**Internal Email to BDA + AE:**
**Subject:** 🔴 SLAY Basketball — No response, need daily follow-up

Team,

SLAY Basketball hasn't responded to CSM outreach in 9 days despite multiple attempts. This is a medium-high risk account with:

- 17+ meetings/transcripts in system (established relationship)
- Recent frustrations: Team Builder usability, reporting accuracy, mobile bugs
- Working toward 300-member goal
- Churn risk fluctuating 5-8/10

**Action needed:**
- BDA: Please add to daily call list starting today
- AE: Consider joining next successful connection for relationship reinforcement

Key talking points:
- We've addressed the team invite bug
- Reporting improvements shipped
- Want to help them hit 300 members

Calendly link for reference: https://calendly.com/playbook-csm/client-check-in

Thanks,
[CSM Name]


---

<!-- file: next-gen-sports.md -->
# Next Gen Sports and Rec — Book-a-Meeting Sequence

## Client Profile

| Field | Value |
|-------|-------|
| **Company** | Next Gen Sports and Rec |
| **Sport** | Multi-sport facility (likely basketball + more) |
| **Tenure** | 12+ meetings in system |
| **Risk Status** | Medium (4-6/10 churn scores, trending stable) |
| **Recent Issues** | App missing features (announcements, tournaments "wonky"), variable pricing gaps, staff assignment bug, group chat visibility bug |
| **What They Care About** | Consolidating everything into one app, small group training pricing, moving away from GameChanger |
| **Processing Trend** | Active, pushing for full adoption |
| **CSM** | [Assigned CSM name] |

## Key Insights from Transcripts

1. **March 4:** "Majority of things encountered are app related" — features missing, tournaments wonky; risk of reverting to GameChanger
2. **February 24:** Found staff assignment bug ("a bug for sure"); group chat visibility issue unresolved; no follow-up booked at end of call
3. **February 18:** Adult League needs manual Excel workarounds; invitation emails failing; had to manually email parents from Gmail

**Emotional State:** Committed but hitting walls; wants to consolidate everything into Playbook but keeps finding gaps

---

## Day 0: Email #1 + SMS #1

### Email #1
**From:** CSM
**Subject:** App updates + a few things I want to walk you through

Hey [First Name],

Hope things are going well at Next Gen! I wanted to check in because I know you've been running into some stuff with the app — the announcement feature not being quite right, tournaments being a bit wonky, and that group chat visibility issue we couldn't figure out last time.

I've been digging into these with the product team and want to give you an honest update on where things stand. Some stuff we've fixed, some stuff is coming, and I want to make sure you know the real timeline.

Also, I've got a workaround idea for the variable pricing thing for small group training that might actually work until we ship the full feature. Want to show you.

Can we grab 15-20 min this week?

→ Book time here: https://calendly.com/playbook-csm/client-check-in

Or just throw me a couple times and I'll send the invite.

Looking forward to it!

Best,
[CSM Name]

---

### SMS #1 (same time as email)
**From:** CSM

Hey [First Name]! Just sent an email — got some updates on the app stuff you've been dealing with and a workaround for the small group pricing. Can you grab 15 min? https://calendly.com/playbook-csm/client-check-in

---

## Day 2: Email #2 (Add Value)

**Subject:** re: App updates + a few things I want to walk you through

Hey [First Name],

Bumping this up — I know you're juggling a ton running the facility.

BTW, I talked to another multi-sport facility owner recently who was in a similar spot with the Adult League tracking. They ended up using our export + a simple Google Sheet template to automate the standings calculation until we ship native support. Happy to share that setup if it would help you ditch the manual Excel work.

Let me know what your week looks like — even a quick 15 min helps.

→ https://calendly.com/playbook-csm/client-check-in

[CSM Name]

---

## Day 3: SMS #2

Hey! Just following up. I know the app gaps have been frustrating — really want to walk you through what we've shipped and what's coming. Got any time this week?

---

## Day 5: Spencer Email (Escalation)

**From:** Spencer Pascal
**Subject:** Want to help get Next Gen fully on Playbook

Hey [First Name],

Spencer here — I'm on the product side at Playbook and wanted to reach out directly.

[CSM Name] mentioned you've been working hard to consolidate everything into our app but keep running into gaps — announcements, tournaments, the group chat stuff. I wanted to personally connect because I want to make sure we're building the right things for facilities like yours.

Would you have 15-20 minutes to walk me through what's most critical for you right now? I can join the call with [CSM Name] and take notes directly back to the engineering team. Your feedback has already influenced some of what we've shipped, and I want to keep that loop tight.

→ https://calendly.com/playbook-csm/client-check-in

Really appreciate you pushing through the rough edges with us. I know it's not easy.

Best,
Spencer Pascal
Product Lead, Playbook

---

## Day 7: SMS #3 (Apologetic, Persistent)

Hey [First Name] — I know I've pinged you a few times, sorry about that. We genuinely want to help you get everything consolidated and working. Even 10 min would help: https://calendly.com/playbook-csm/client-check-in

---

## Day 9: Escalation to BDA/AE

**Internal Email to BDA + AE:**
**Subject:** 🔴 Next Gen Sports and Rec — Need daily outreach

Team,

Next Gen Sports and Rec hasn't responded in 9 days. This is a medium risk account we need to re-engage:

- 12+ meetings in system (solid relationship history)
- Goal: Consolidate everything into Playbook, move away from GameChanger
- Pain points: App feature gaps (announcements, tournaments), variable pricing for small groups, email delivery issues
- Churn risk: 4-6/10 (stable but frustrated)

**Action needed:**
- BDA: Add to daily call list
- AE: May need to join recovery call to reinforce commitment

Key talking points:
- Product team actively working on app gaps
- Have workarounds for pricing/Adult League tracking
- Want to help them fully migrate off GameChanger

Calendly: https://calendly.com/playbook-csm/client-check-in

Thanks,
[CSM Name]


---

<!-- file: team-esface.md -->
# Team Esface — Book-a-Meeting Sequence

## Client Profile

| Field | Value |
|-------|-------|
| **Company** | Team Esface (Basketball Academy) |
| **Sport** | Basketball |
| **Tenure** | 6+ meetings in system |
| **Risk Status** | Higher risk — scores dropped to 7-9/10 churn (note: higher = worse in this scale), one NPS of 0 |
| **Recent Issues** | Scheduler CSV export failed during demo, Google Analytics integration delayed, confirmation email misconfiguration, mobile app not showing full program schedules, $0 pricing bug on live camp page |
| **What They Care About** | Marketing ROI tracking (Google Analytics), reliable parent experience, spring registration launch |
| **Processing Trend** | Active but trust is fragile |
| **CSM** | [Assigned CSM name] |
| **Key Stakeholders** | Dele (unable to access meeting recordings), Taylor, Jamal |

## Key Insights from Transcripts

1. **January 22:** Scheduler CSV export failed live on call ("absolutely incorrect"); Google Analytics status unknown; CSM couldn't answer confidently
2. **January 15:** Clock-in issue caused "scrambling" and manual rework; client said system "creates more work"; Google Analytics request starting to feel like a "cop-out"
3. **December 18:** Critical bug — child's full program schedule not visible on mobile app (only first session shown); $0 pricing displayed on live summer camp page; Dele can't access recordings

**Emotional State:** Losing patience with recurring issues; needs visible progress on Google Analytics and mobile app reliability

---

## Day 0: Email #1 + SMS #1

### Email #1
**From:** CSM
**Subject:** Google Analytics update + some fixes I want to show you

Hey [First Name],

I hope you're doing well! I wanted to reach out because I know things have been bumpy lately — the scheduler export issue on our last call, the clock-in stuff that caused extra work, and I know the Google Analytics question has been hanging out there for a while.

I don't want to give you another "we're working on it" without substance, so here's where we actually are:

**What's fixed:**
- The clock-in sync issue that was causing duplicate work
- Confirmation email configuration (should be solid now)
- Some mobile app schedule display improvements

**Still in progress:**
- Google Analytics integration — I've escalated this internally and want to give you an honest timeline

Can we grab 15-20 minutes so I can walk you through what's live and give you a real update on Analytics? I also want to make sure Taylor and Jamal are looped in if that's helpful for your team.

→ Book here: https://calendly.com/playbook-csm/client-check-in

What times work this week or early next?

Thanks for sticking with us on this. I know it hasn't been smooth.

Best,
[CSM Name]

---

### SMS #1 (same time as email)
**From:** CSM

Hey [First Name]! Just sent you an email with a real update on Google Analytics and the fixes we've shipped. Would love to walk you through it — got 15 min this week? https://calendly.com/playbook-csm/client-check-in

---

## Day 2: Email #2 (Add Value)

**Subject:** re: Google Analytics update + some fixes I want to show you

Hey [First Name],

Just bumping this — I know spring registration is coming up and want to make sure you're feeling good about the setup before you start promoting.

BTW, I also wanted to flag something: one of our other basketball academies just started using our automated waitlist feature for their spring programs and it's been a game changer for managing overflow. Happy to set that up for you if it would help with registration pressure.

Let me know when you can grab a few minutes.

→ https://calendly.com/playbook-csm/client-check-in

[CSM Name]

---

## Day 3: SMS #2

Hey! Following up on my email. I know the Analytics thing has been dragging — I have a real update and some stuff we've fixed. Can you grab time this week?

---

## Day 5: Tomas Email (Escalation)

**From:** Tomas Borba
**Subject:** Team Esface — wanted to connect personally

Hey [First Name],

Tomas here from Playbook. [CSM Name] mentioned you've had some frustrating experiences lately — the scheduler export failing, the clock-in confusion, and the Google Analytics integration taking longer than expected.

I wanted to personally apologize for the rough patches and let you know we're taking it seriously. I've been working directly with our product team on the Analytics timeline and want to give you an honest update in person.

I also want to make sure Dele, Taylor, and Jamal have what they need — including access to meeting recordings if that's still an issue.

Would you have 15-20 minutes to connect this week? I can join the call with [CSM Name] or we can do a quick 1:1 if that's easier.

→ https://calendly.com/playbook-csm/client-check-in

I know trust has to be earned back. Hoping we can start there.

Best,
Tomas Borba
Customer Success Lead, Playbook

---

## Day 7: SMS #3 (Apologetic, Persistent)

Hey [First Name] — I know we've sent a few messages. Really sorry for the noise. We've genuinely made progress on the stuff that's been frustrating you and I don't want you to miss it. Even 10 min helps: https://calendly.com/playbook-csm/client-check-in

---

## Day 9: Escalation to BDA/AE

**Internal Email to BDA + AE:**
**Subject:** 🔴 Team Esface — Critical: No response, need immediate engagement

Team,

Team Esface (Basketball Academy) hasn't responded in 9 days. This is a HIGHER RISK account:

- 6+ meetings, but trust is fragile
- Churn risk scores: 7-9/10 (one meeting had NPS of 0)
- Key blocker: Google Analytics integration (feels like a "cop-out" to them)
- Additional issues: Mobile app schedule display, CSV export failures
- Multiple stakeholders: Dele, Taylor, Jamal (some have access issues)

**Why this matters:**
- They explicitly said the system "creates more work for them"
- Spring registration is coming — if they launch frustrated, churn risk spikes

**Action needed:**
- BDA: Daily calls starting now
- AE: Recommend joining first successful connection — this one needs relationship reinforcement
- Consider executive touchpoint if BDA calls don't land in 3 days

Key talking points:
- Honest Google Analytics timeline (escalated internally)
- Mobile app fixes shipped
- Waitlist feature for spring registration

Calendly: https://calendly.com/playbook-csm/client-check-in

Let's not lose this one.

[CSM Name]


---

<!-- file: ebc-training-centers.md -->
# EBC Training Centers — Book-a-Meeting Sequence (Example from Josh)

## Client Profile

| Field | Value |
|-------|-------|
| **Company** | EBC Training Centers |
| **Sport** | Basketball (Training + Tournaments) |
| **Tenure** | 2+ meetings in system |
| **Risk Status** | HIGH — Churn score 7/10, NPS dropped to 1 on recent call |
| **Recent Issues** | Private training feature blocked ($25K/mo revenue!), tournament bracket automation missing, pool play visualization absent |
| **What They Care About** | Private training automation (115 clients/week), tournament scheduling, January 1st launch deadline |
| **Processing Trend** | Stalled on high-value streams |
| **CSM** | Nicholas |
| **Key Quote** | "It doesn't feel like things have changed. Have progressed really at all." |

## Key Insights from Transcripts

1. **November 20:** CRITICAL — Client explicitly said feature development feels stalled, "really really long time" waiting. Private training = $25,000/month revenue blocked. Manually entering 113 tournament games at "Saturday night at f****** midnight"
2. **March 5:** Reactive call, no agenda set, CSM didn't book follow-up, promised delivery "before end of today"

**Emotional State:** Frustrated, feels deprioritized, sitting on $25K/mo revenue they can't run through Playbook

---

## Day 0: Email #1 + SMS #1

### Email #1
**From:** Nicholas (CSM)
**Subject:** Private training update + tournament stuff — need to talk

Hey [First Name],

I've been thinking about our last conversation and I owe you a real update.

I know you've been waiting on the multiple-people-per-booking feature for private training for a while now. You told me straight up it feels like nothing has changed, and I heard that. You're managing 115 private training clients a week manually and that's $25,000 a month you can't run through our system efficiently yet. That's not okay.

I went back to Josh and the product team directly after our call. I want to walk you through exactly where things stand — no BS, just the real timeline and what we can do in the meantime to make your life easier.

Same goes for the tournament bracket stuff. I know you're entering 100+ games manually on Saturday nights and that's brutal. We've got some ideas.

Can we grab 20-30 min this week? I'll come prepared.

→ https://calendly.com/playbook-csm/client-check-in

What times work for you?

Thanks for being patient with us. I know it hasn't been easy.

Nicholas

---

### SMS #1 (same time as email)
**From:** Nicholas

Hey [First Name]! Just emailed you. I talked to Josh and the product team about the private training feature — want to give you a real update. Can you grab time this week? https://calendly.com/playbook-csm/client-check-in

---

## Day 2: Email #2 (Add Value + Acknowledge)

**Subject:** re: Private training update + tournament stuff — need to talk

Hey [First Name],

Just bumping this. I know you're probably buried in client sessions and tournament prep.

BTW — while we work on the native solution, I've been thinking about a workaround for the private training scheduling that might save you some manual work. It's not perfect but a couple other high-volume trainers are using it and getting by until we ship the real thing. Want to walk you through it.

Also happy to talk through how to make the tournament setup less painful for your next event. I know 113 games at midnight is not sustainable.

→ https://calendly.com/playbook-csm/client-check-in

Let me know what works.

Nicholas

---

## Day 3: SMS #2

Hey! Following up on my email. I know you're swamped. Really want to show you the workaround for private training scheduling and give you a real update on the feature. Any time work this week?

---

## Day 5: Tomas Email (Escalation)

**From:** Tomas Borba
**Subject:** EBC — wanted to personally follow up on product feedback

Hey [First Name],

Tomas here from Playbook — I work closely with Nicholas and wanted to reach out directly.

I heard you've been waiting a while for the multiple-people-per-booking feature for private training, and I completely understand the frustration. Managing 115 clients a week manually while sitting on $25K/month in revenue that should be flowing through our system — that's a real problem we need to solve.

I've been in touch with our product team specifically about your use case. I'd love to connect and give you a transparent update on where this sits on our roadmap, what the realistic timeline looks like, and what we can do to bridge the gap until then.

Your feedback has genuinely influenced our priorities. I want to make sure you see that.

Would you have 20 minutes this week or early next?

→ https://calendly.com/playbook-csm/client-check-in

I know how busy you must be running training and tournaments. Really appreciate you taking the time.

Best,
Tomas Borba
Customer Success Lead, Playbook

---

## Day 7: SMS #3 (Apologetic, Persistent)

Hey [First Name] — I know we've been in your inbox a lot. Sorry for all the messages. We really have been working on the stuff you raised and don't want you to miss the update. Even 15 min helps: https://calendly.com/playbook-csm/client-check-in

---

## Day 9: Escalation to BDA/AE

**Internal Email to BDA + AE:**
**Subject:** 🔴 EBC Training Centers — CRITICAL: $25K/mo at risk, no response

Team,

EBC Training Centers has not responded to outreach in 9 days. This is a **CRITICAL** account:

**Why this is urgent:**
- Private training = $25,000/month revenue NOT running through Playbook
- 115 private training clients/week managed manually
- Client explicitly said it "doesn't feel like things have changed" — trust is damaged
- Churn risk 7/10, NPS dropped to 1 on last call
- Manually entering 100+ tournament games at midnight

**History:**
- Client has been waiting for multiple-people-per-booking feature for "a really really long time"
- Tournament bracket automation is also a pain point

**Action needed:**
- BDA: Daily calls starting immediately — this is high priority
- AE: Consider executive touch — this account needs relationship repair at a higher level
- If no contact in 3 more days, escalate to Josh

Key talking points:
- Product team update on private training feature (be honest about timeline)
- Workaround solutions for immediate relief
- Genuine acknowledgment of their frustration

Calendly: https://calendly.com/playbook-csm/client-check-in

We cannot afford to lose this one.

Nicholas

---

## Notes for Implementation

1. **This is the model** — reference client's exact pain points, quote them if possible
2. **Own the delays** — "I know you've been waiting" not "sorry for any inconvenience"  
3. **Name the revenue** — $25K/mo makes it real and shows we understand the stakes
4. **Escalation is genuine** — Tomas email adds credibility, not just "another follow-up"
5. **Final escalation is urgent** — BDA/AE email makes it clear this is high priority internally

