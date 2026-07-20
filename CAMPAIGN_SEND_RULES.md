# Campaign Send Rules

Decision rules for the **daily cron agent** that decides which events get an
automated **bulk SMS blast**. This file is the single source of truth:

- If the agent is **deterministic** (a fixed checklist in the n8n workflow), this
  is the spec it implements.
- If the agent is an **LLM** (Claude reasoning in the workflow), this is the
  instruction sheet it is given.

The UI **Campaigns tab** (`ui/campaigns.html`) shows the *same* decision as a
preview/audit, so a human can see what the agent will do or has done.

> Values marked **`DEFAULT — confirm`** are placeholders. Replace them with the
> real business numbers before go-live.

---

## Data the agent reads

| What | Table / column |
|---|---|
| The event | `icp_events` — `id`, `team_name`, `opponent`, `event_date`, `filled_pct` |
| Fill / demand | `icp_events.filled_pct` (0 = empty suite, 100 = full) |
| Template library + past performance | `blast_templates` — `list_name`, `email_template`, `open_rate`, `clickthru_rate`, `scheduled_for`, `sent_emails` |
| Who to send to | `recipient_lists` — one list per market (phone recipients) |
| What was already sent (audit) | *(send log — see "Logging" below)* |

Market bridge: an event's `team_name` maps to a market/city, which maps to a
`recipient_lists` entry and to `blast_templates.list_name`. (Same mapping the UI
uses — keep them identical.)

---

## 1. Eligibility — send ONLY if ALL are true

An event qualifies for a blast today only when **every** check passes:

1. **Upcoming** — `event_date` is in the future (never send for a past event).
2. **In the send window** — `event_date` is between **`DEFAULT — confirm: 3`**
   and **`DEFAULT — confirm: 21`** days away. (Too far out = premature; too close =
   no time to act.)
3. **Not already full** — `filled_pct` is `NULL` or **< `DEFAULT — confirm: 90`**.
   A full suite doesn't need demand.
4. **Has an audience** — a `recipient_lists` entry exists for this market with at
   least **`DEFAULT — confirm: 1`** valid phone recipient.
5. **Has a template** — at least one `blast_templates` row matches this market.
6. **Not suppressed** — passes every rule in section 3 below.

If any check fails → **skip** and log the reason.

---

## 2. Prioritisation — when many events qualify

If more events qualify than the daily cap (section 3), send the highest-demand
ones first:

- **Priority = lower `filled_pct` first.** 0% filled is the most urgent.
- `NULL` fill (unknown) ranks as **medium**.
- Tie-break: sooner `event_date` first.

### Template choice
Among the market's `blast_templates`, pick the **best historical performer**:
highest `open_rate`, tie-broken by `clickthru_rate` (ignore rows with 0
`sent_emails`). Use its send timing (`scheduled_for` day/hour) as the preferred
send window.

---

## 3. Suppression & guardrails — what to look out for

These are the safety rails. **When in doubt, do NOT send.**

- **No duplicate sends per event** — never send more than once for the same
  `icp_events.id`, ever. (Dedupe against the send log.)
- **List cooldown** — do not blast the same `recipient_lists` list more than once
  every **`DEFAULT — confirm: 7`** days, even across different events.
- **No day-of / post-event sends** — never send on the event date or after it.
- **Daily volume cap** — send at most **`DEFAULT — confirm: 3`** blasts per day
  total (deliverability + review sanity).
- **Send-time window** — only trigger sends between **`DEFAULT — confirm: 9:00`**
  and **`DEFAULT — confirm: 17:00`** in the market's local time. Cron may run
  earlier; queue rather than send outside the window.
- **Per-recipient opt-outs** — never text a number that has replied STOP /
  unsubscribed. *(Requires a suppression list — `TBD: source not yet defined.`)*
- **Dry-run switch** — a config flag that logs the full decision **without
  sending**, for testing. Default **ON** until explicitly turned off.
- **Kill switch** — a config flag that halts all sends immediately.

---

## 4. Logging — every decision, every day

For **every** event evaluated (sent *and* skipped), record:

- `event_id`, market, `run_date`
- decision: `sent` | `skipped`
- reason (e.g. `suite 100% filled`, `no list`, `list cooldown`, `sent`)
- if sent: `recipient_list_id`, `template_id`, recipient count, timestamp

This is what the Campaigns tab reads back to show "what the agent did," and what
the dedupe/cooldown rules check against.

> Send-log table is **`TBD:`** not created yet. Proposed:
> `campaign_send_log(id, event_id, run_date, decision, reason,
> recipient_list_id, template_id, recipient_count, sent_at)`.

---

## Open items to confirm before go-live

- [ ] Real numbers for every **`DEFAULT — confirm`** value above.
- [ ] Source of the **per-recipient opt-out / STOP** suppression list.
- [ ] Create the **`campaign_send_log`** table.
- [ ] Populate **per-market recipient lists** (today only one junk list exists).
- [ ] Decide agent brain: **deterministic** vs **LLM** (this file serves both).
