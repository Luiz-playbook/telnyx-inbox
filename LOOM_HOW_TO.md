# Marketing Blaster — Loom walkthrough

Two things in one file:

1. **[Feature list](#part-1--feature-list)** — everything the project does today, so nothing gets left out of the recording.
2. **[Loom script](#part-2--loom-script)** — what to say and what to click, section by section, ~12 minutes.

Written against `main` as of 2026-08-05. Anything marked **⚠** is a gotcha worth saying out loud on camera.

---

## Part 1 — Feature list

### The app

One page, `ui/index.html`, titled **Marketing Blaster**. Five tabs across the top plus a **Campaign Agent** rail down the left side that stays visible on every tab.

Sign-in is Google (`ui/login.html`) against Supabase Auth. There is no anonymous access — migration `052` revoked `anon` execute on every RPC this app uses.

### Tab 1 — Campaigns

The event board. Every upcoming game from `events_master`, resolved to the market/state it should sell into, one row per **market × segment**.

| Feature | What it does |
|---|---|
| Search | Free text over event and state |
| Filters | Sport, league, state (grouped US / Canada / Test), upcoming window (7 / 14 / 30 days), segment (ICP / SCP / Other), price (has / missing) |
| Cheapest column | Get-in ticket price, sortable. Games with no price sink to the bottom — an unknown price is not the cheapest |
| Reach columns | Companies, Emails, Phone #s — per segment, not per market |
| **Trigger Blast** | Fills the queue. Takes **Markets/day** and a **Through** date, so it plans multiple days in one press. Additive — it never rewrites what is already queued |
| **Refresh prices** | Runs the same job as the 12-hourly cron: an AI model looks up live get-in prices. **⚠ Costs money per run.** It shows the game count and estimated cost before spending, and the last run's real cost after |
| Pager | 25 / 50 / 100 / 250 / All |

### Tab 2 — Queue

What the agent thinks should go out, banded by send day.

| Feature | What it does |
|---|---|
| Filters | Status (with live counts painted onto each option), segment, sport, state, channel, send day |
| Row columns | Blast, Cheapest, Sport, Market/State, Emails, Phone #s, Schedule, Status, Actions |
| Expand a row | Two panels side by side — Email and SMS |
| Email panel | Sender picker, editable subject, editable body. Click straight into the text |
| SMS panel | Sender picker, editable bubble, live segment/credit counter |
| Sender pickers | Email: Gmail mail merge (john@, rion@) or CakeMail (josh.marcus@ production, pbtest@ test). SMS: Telnyx numbers plus every Salesmsg inbox, loaded live from the API. **Defaults are production CakeMail and Josh Marcus' Salesmsg inbox** |
| Turning a channel off | The "— Not sending email —" option in the same picker. Choosing a real sender turns it back on |
| Save copy | Writes the edited subject/body/SMS. **⚠ The copy that sends is the saved one, not what is on screen** |
| Confirm | Approves without changing the send time |
| Send now | Moves the slot to now and fires immediately |
| Snooze | Pushes the schedule out, keeps it queued and keeps the market held |
| Reject | Leaves the queue, frees the slot, and suppresses that game **for that segment** for 21 days. The optional reason is fed back to the decider as pattern context |
| Delete | For mistakes and test rows. Teaches the decider nothing |
| Archive / Restore | Hides a sent blast; the send record is kept. A sent blast cannot be deleted |
| Cooldown badge | 14-day per market × segment hold, shown per row |
| Past-game badge | A row whose game has already been played. The cron will not send it; Send now still can, with a warning |
| Schedule | `datetime-local` per row, edited in place |

**⚠ Approval is optional, not blocking.** An unactioned row still sends at its scheduled slot. Placeholder `[TEST]` rows never auto-send.

### Tab 3 — Market History

Every blast this business actually sent — Textable, CakeMail and Salesmsg in one list, newest first. This is the decider's memory of what worked.

Search, channel filter, source-platform filter, sent-within window (30 / 90 / 365 days / all). Expand a row to read the copy that went out. Refreshes on open, plus a **Sync now** button.

### Tab 4 — Templates

Cole's authored templates and the historical blast copy, in one searchable rail with a full-text detail pane. Filter by source: All / Cole's / Historical.

**⚠** Event Waitlist's real copy still lives in a HubSpot sequence — what is shown is an editable placeholder, not authored outreach copy.

### Tab 5 — Cole Rules

Three numbers that the decider reads on every run:

- **Cooldown floor** — days since last send to the same market/strategy
- **Forward-looking window** — days until the game
- **Opt-out ceiling** — flags markets whose unsubscribe rate is running hot

Save & Recompute Queue applies them. A cross-strategy fatigue warning fires under 10 days since *any* send to a market — a flag, not a hard block. Below the inputs is a dated revision log.

### The Campaign Agent rail

A chat panel on every tab, backed by a self-hosted OpenClaw agent (browser → Vercel function → WebSocket → agent). Multiple chats, each its own session with persistent memory. Replies stream token by token. Suggestion chips: what's ready today, suppressed markets, load a market, draft a suite invite, show templates, open the queue.

The agent can do everything the site can do to campaign data, **including sending a specific queued blast when explicitly asked**. Unattended sending stays the cron's job.

### What runs on its own

| Cron | Schedule | Job |
|---|---|---|
| `/api/queue-tick` | hourly | Sends any queued blast whose slot has arrived |
| `/api/decide` | daily 14:00 | The AI decider |
| `/api/price-refresh` | every 12h | Get-in price lookups |
| `/api/schedule-refresh` | monthly | Pulls newly released MLB games into `events_master` |

### Sending, end to end

- **Email → CakeMail.** One campaign per market blast: create list → accept policy → import contacts → create campaign → schedule. Five API calls regardless of recipient count, so an 1,800-address market finishes inside the function timeout. One PAT per sub-account, no cross-account fallback.
- **Email → Gmail mail merge.** Anything that is not a `cakemail:` sender goes to the n8n webhook.
- **SMS → Salesmsg.** Sends from a *team* (an inbox), fanned out per recipient.
- **SMS → Telnyx.** Anything that is not a `salesmsg:` sender goes to the n8n bulk webhook.
- **Routing is decided by the row's stored sender string**, in `api/queue-tick.js`.

### Safety rails

- **TEST MODE banner** — orange bar across the top while `send_allowlist` is non-empty. Markets off the list resolve to zero recipients, so nothing reaches a real lead. **⚠ Confirm this is on before recording anything that presses Send now.**
- 14-day cooldown per market × segment, enforced in SQL
- Reject suppression, 21 days per game × segment
- Placeholder rows never auto-send
- A blast that delivered on no channel is left queued and the market is *not* put on cooldown — a failed send is never recorded as a send
- Guardrails live inside the RPC bodies, not in RLS, so they apply to every caller including the agent

### Also in the repo

- `ui/lookup.html` — upload a spreadsheet of phone numbers, get mobile vs landline back via Telnyx Number Lookup, export the textable sheet
- The original Telnyx 2-way SMS inbox (n8n workflows + Supabase tables) this repo started as

---

## Part 2 — Loom script

**Target length:** 11–13 minutes. **Audience:** whoever is going to run blasts day to day.

### Before you hit record

- Sign in first — do not record the Google flow.
- Confirm the **TEST MODE** banner is showing.
- Have the Queue holding a few rows, at least one with both channels on.
- Open the Campaign Agent rail; drag it to a comfortable width.
- Close every other tab. Zoom to ~110% so text is readable in the Loom player.
- Pick one market to follow through the whole video — the same one every time makes the story land.

---

### 0:00 — Cold open (30s)

> "This is the Marketing Blaster. It decides which games are worth blasting, writes the copy, queues it by day, and sends it — email through CakeMail, SMS through Salesmsg. I'm going to walk one market from a game on a schedule all the way to a sent blast, and show you the places you can step in and change your mind."

*On screen: the app, Campaigns tab, Queue visible in the tab bar.*

Point at the orange bar:

> "That orange TEST MODE bar means only allowlisted markets resolve to real recipients. Nothing I press in this video reaches a real lead."

---

### 0:30 — The five tabs in one breath (45s)

> "Five tabs. **Campaigns** is every upcoming game and who we could reach. **Queue** is what's actually going out and when. **Market History** is everything we've ever sent. **Templates** is the copy library. **Cole Rules** is the three numbers that decide what's allowed to send. And this rail on the left is the Campaign Agent — it's on every tab, and it can do anything the buttons can do."

*Click each tab once, land back on Campaigns.*

---

### 1:15 — Campaigns: reading the board (2 min)

> "One row per market and segment — so a single game shows up three times, once for ICP, once for SCP, once for everything else, because the reach numbers are different for each."

*Point at Companies / Emails / Phone #s.*

> "Those three columns are that segment's reach, not the market's."

*Click the Cheapest header.*

> "Cheapest is the get-in ticket price. Sort by it. Games with no price yet sink to the bottom — an unknown price isn't the cheapest one."

*Use the filters: sport, then next-14-days, then a state.*

> "Filters across the top: sport, league, state, how far out, segment, and whether we've got a price yet."

**Refresh prices** — hover the tooltip:

> "This looks up live get-in prices. It costs money every run, so it tells you the game count and the estimate before it spends anything, and it shows you what the last run actually cost. Only games in the near horizon get priced — a price for a game months out will have moved long before the blast goes."

*Do not press it, or press it and let the estimate dialog be the whole demo.*

**Trigger Blast**:

> "This is what fills the queue. Markets per day, and a date to plan through — so one press can lay out a week. It's additive: it never rewrites what's already queued, it only adds."

*Press it. Let it finish. Then click through to the Queue.*

---

### 3:15 — Queue: the row (3 min)

> "This is the queue, banded by the day it goes out."

*Point at a day band, then a row.*

> "Same columns as Campaigns for the first half — so a blast reads the same on both tabs — then when it's scheduled, what status it's in, and the actions."

*Open the status filter.*

> "Each status carries its own live count, so you don't need a summary line."

**Expand a row.**

> "Two panels — email on the left, SMS on the right. Both always show, even for a channel that's off, because turning it back on should be one click."

*Click into the subject, type a word, click into the body.*

> "Subject and body are editable right here. This is exactly what sends."

*Point at the SMS counter.*

> "The SMS bubble is editable too, and this counter tells you how many segments — how many credits — the message costs. Two credits is the cap."

*Press **Save copy**.*

> "**⚠ The copy that sends is the saved copy, not what's on screen.** If you edit and walk away, you edited nothing."

**Sender pickers:**

> "Each panel owns its sender. Email defaults to the production CakeMail sender, josh.marcus@callplaybook.com. SMS defaults to Josh Marcus' Salesmsg inbox. Those defaults are what a real market blast should go out as, so most of the time you leave them alone."

*Open the email picker.*

> "You can switch to the Gmail mail merge, or to the pbtest sender if you're testing. And the first option here is 'not sending email' — that's how you turn a channel off. Picking a real sender turns it back on."

---

### 6:15 — Queue: the four decisions (2 min)

*Open the Actions menu on an unsent row.*

> "Four things you can do, and they mean different things."

**Confirm:**

> "Approves it. Doesn't change the time. And here's the important part — **approval is optional**. An untouched row still sends at its scheduled slot. Confirm is you saying 'yes, and I looked at it', not the thing that lets it go."

**Send now:**

> "Moves the slot to right now and fires. Only allowlisted markets resolve to recipients while test mode is on."

**Snooze:**

> "Pushes the date out and keeps it queued — and keeps the market held, so nothing else jumps into its place."

**Reject:**

> "This is the considered no. It leaves the queue, frees the slot, and this game won't be suggested again for this segment for twenty-one days. The reason box is the valuable part — it goes back to the decider as context, so it can generalise past this one game."

*Show the reason dialog, type something, cancel.*

**Delete:**

> "Delete is for mistakes and test rows. Unlike Reject it teaches the decider nothing, which is why it's the quiet one at the bottom."

*Point at a cooldown badge if one is visible.*

> "Fourteen-day cooldown per market and segment. Blasting Chicago ICP leaves Chicago SCP open."

---

### 8:15 — Market History (1 min)

*Switch tabs.*

> "Everything we've actually sent — Textable, CakeMail and Salesmsg in one list, newest first, because recency is the strongest signal we have."

*Expand a row.*

> "Expand any row to read the copy that went out. This is the decider's memory: when it picks a template for a market, this is what it's picking from."

*Point at Sync now.*

> "It refreshes when you open the tab, and Sync now pulls fresh send reports on demand."

---

### 9:15 — Templates and Cole Rules (1 min 30s)

**Templates:**

> "The copy library. Cole's authored templates and the historical blasts, searchable, full text on the right."

*Filter to Cole's, click one.*

> "**⚠** Event Waitlist's real copy still lives in a HubSpot sequence — what's here is a placeholder."

**Cole Rules:**

> "Three numbers, and they're not decoration — the decider reads them on every run. Cooldown floor is days since the last send. Forward window is how far out a game has to be. Opt-out ceiling flags a market whose unsubscribe rate is running hot."

*Point at Save & Recompute Queue.*

> "Change one, save, and the queue recomputes against it."

---

### 10:45 — The Campaign Agent (1 min)

*Click into the rail.*

> "The rail is a real agent, not a help widget. It can do everything the buttons do — queue a market, edit copy, and if you explicitly ask it, send a specific queued blast. What it won't do is send on its own; unattended sending is the cron's job."

*Type: "What's ready today?" — let it stream.*

> "It streams as it thinks, and every chat is its own session with its own memory, so you can keep one thread per market if you want."

---

### 11:45 — What runs without you, and the close (45s)

> "Four things run on their own. Every hour, anything whose slot has arrived gets sent. Once a day the decider proposes the queue. Every twelve hours prices refresh. Once a month the MLB schedule pulls in new games."

> "So the honest summary: the system will keep proposing and keep sending. Your job is the queue — read the copy, fix what's wrong, reject what shouldn't go, and snooze what's early. Everything else takes care of itself."

*End on the Queue tab.*

---

### Cut-down version (4 minutes)

If the full version is too long, keep: cold open → Trigger Blast → expand a queue row and edit copy → Save copy → the four actions → what runs on its own. Drop Campaigns filtering, Market History, Templates, Cole Rules and the agent.
