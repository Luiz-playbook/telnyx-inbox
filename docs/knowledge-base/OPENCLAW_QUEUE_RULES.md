# Campaign Queue — Decision Rules for OpenClaw

Instruction sheet for the **Campaign Agent (OpenClaw)** when it decides which events
go into the campaign queue.

This replaces the OpenAI `gpt-4o` re-rank step currently in `api/trigger-decide.js`.
Everything below is what that endpoint does today, plus the new **Cole directives**
layer (§4), which does not exist in code yet.

Queueing does not send. The agent proposes/enqueues **placeholder** rows
(`is_placeholder = true`), and the scheduled **cron** owns delivery. The one
exception is a **manual send on explicit user request** — see §7: if a user tells
the agent to send a specific queued blast now, the agent may fire that one row.
Absent such a request, the agent never sends; the cron does.

---

## Test mode — queue the REAL market (2026-07-31)

While `send_allowlist` (migration 023) is non-empty, only the listed codes resolve
recipients: `market_phones` / `market_emails` return **zero rows** for every other
market. That is the only recipient-resolution path for the send cron *and* for a manual
"Send now", so **a real market in the queue cannot reach anybody.** Read the live list
with `send_test_mode()`; today it holds `ZZ` alone.

Therefore: **queue the market the decider actually picked.** Keep its real
`state_code`, `state_name`, `event_id` and reach counts. Do **not** rewrite picks to the
test market — the whole point of a test run is to see which markets the decider chose
and why, and retargeting throws that away. Annotate the row instead (`[TEST — will NOT
send] … Sending is blocked — only ZZ resolves recipients.`).

`ui/index.html` did retarget to `ZZ` and no longer does. Two consequences worth
knowing:

- Every queued row used to carry `state_code = 'ZZ'`, so the §2 additive guard's
  market de-dupe only ever saw `ZZ` and never blocked a real market from being picked
  again while it sat in the queue. Real codes restore it.
- Queueing no longer writes blast history — see §7.

---

## 0. Data sources

Supabase (`SUPABASE_URL`, anon key). All are RPCs — `POST /rest/v1/rpc/<name>` with `{}`.

| RPC | Returns | Used for |
|---|---|---|
| `rpc_event_recommendations()` | one row per upcoming game with `decision` = `send`/`skip` + `reason_code` | the candidate set — **the safety floor** |
| `market_recipient_counts()` | `market_key`, `state_code`, `phone_count`, `email_count` | reach per market |
| `get_campaign_queue()` | current queue rows | what is already scheduled |
| `queue_plan(p_from, p_to)` | per-day `queued` count + `event_ids` / `market_codes` already taken | day-by-day gaps |
| `market_cooldowns()` | last blast date per **market × segment**, keyed by `market_code` + `segment` (`CA` + `ICP`) | send-time guard — ⚠ **not** the floor's cooldown, see below |
| `send_test_mode()` | allowlisted codes; empty = normal mode | which markets can resolve recipients at all |
| `queue_enqueue_test(p_rows jsonb)` | inserted rows | **write** — add placeholders |

> ⚠ **Two blast logs, and they do not agree.** The §1 cooldown floor inside
> `rpc_event_recommendations()` reads `ticketblaster_market_blasts_log` (keyed by
> `market_key`, e.g. `san_francisco`). `market_cooldowns()` — used by `api/queue-tick.js`
> at send time — reads a *different* table, `market_blast_log` (keyed by `market_code`,
> e.g. `CA`). Nothing writes both. So `market_cooldowns()` is **not** a way to audit the
> floor the agent is working under; to see what the floor sees, read `reason_code =
> 'cooldown'` off `rpc_event_recommendations()` itself. See Open items.

> **Cooldown is per market × segment** (migration 049). Blasting Ontario ICP leaves Ontario
> SCP and Other open — otherwise ICP, which goes first because it is the primary target,
> would lock the other two out for the whole cooldown window and they would effectively
> never send. A log row with `segment = null` was a whole-market send and cools **all three**;
> that is also what every row written before 049 is. The floor inside
> `rpc_event_recommendations()` still returns one row per *event*, so it cannot say "ICP is
> cooled but SCP is not" — it therefore ignores segment-scoped sends entirely and lets
> `market_cooldowns()` refuse at send time. When that function is rebuilt to return
> event × segment, the per-segment floor belongs in its `sends` CTE.

Tunable knobs live in one row: `decider_rules` where `id = 1`.

Current live values (2026-07-31):

| Knob | Value | Effect |
|---|---|---|
| `forward_window_days` | 30 | game further out than this = `too_early` |
| `cooldown_floor_days` | 14 | market blasted inside this = `cooldown` |
| `cross_strategy_fatigue_days` | 10 | **warning only**, not a block |
| `optout_ceiling_pct` | 0.4 | **warning only**, not a block |

---

## 1. The safety floor — SQL decides, agent may not override

`rpc_event_recommendations()` already applies every hard rule in SQL. An event is
`decision = 'send'` only when **all** of these pass:

1. **Upcoming** — `event_date >= current_date` (spine is `events_master`).
2. **Has history** — the market exists in `v_market_performance`. No prior blast to
   learn from = `no_history` = skip.
3. **Not full** — `filled_pct < 90`. A game with no booking row counts as 0% (sellable).
4. **Inside the window** — `event_date - today <= forward_window_days` (30). Else `too_early`.
5. **Past cooldown** — `today - last_blast >= cooldown_floor_days` (14). Else `cooldown`.
   `last_blast` = newest `ticketblaster_market_blasts_log` row for that `market_key`.
   **Currently inert:** that table's only writer was the Trigger Blast button logging
   picks it never sent, which was removed and the 12 phantom rows deleted (2026-07-31).
   It is now empty, so no event comes back `cooldown` until a real send writes to it —
   which today nothing does. Cooldown is earned by **sending**, not by being queued or
   picked; a market already in the queue is protected by §2 instead.

> **HARD RULE.** The agent works **only** from rows where `decision = 'send'`.
> It may never add an `event_id` that is not in that set, never invent an `event_id`,
> and never enqueue a market that came back `skip`. If Cole asks for a market that the
> floor rejected, say so and name the `reason_code` — do not enqueue it.

Two flags come back that are advisory, not blocks. Treat them as strong negative
signals when ranking:

- `fatigue_warning` — market got a blast within 10 days (a different strategy's send).
- `optout_warning` — market unsub rate above 0.4.

---

## 2. Additive rule — never rewrite the queue

The queue is not rebuilt on every run. It is **topped up**.

Before picking anything, read `get_campaign_queue()` and treat every row whose
`status` is **not** `sent` and **not** `sending` as **live**. Then:

- Drop any candidate whose `event_id` is already live in the queue.
- Drop any candidate whose `state_code` is already live in the queue.
- Count live rows per `scheduled_for::date`. A day already at capacity gets nothing.

`queue_enqueue_test` de-dupes server-side as a second net (migration 030), but the
agent should not rely on that — it should not propose the duplicate at all.

**Same input twice must produce zero new rows.**

---

## 3. Spreading across days

Input: `per_day` (default 4, clamp 1–10) and `through` (a date).

- Window = today .. `through`, inclusive, clamped to **14 days** max.
- Per day: `need = max(0, per_day - live_rows_already_on_that_day)`.
- Total picks this run capped at **40**.
- **One market per market per window.** A second game in a market inside the same
  window is a duplicate blast, not a second pick.
- Each pick carries a `slot_date`; that becomes `scheduled_for`.

Days that are already full are left alone entirely — do not touch, reorder, or
reschedule existing rows.

---

## 4. Cole directives — human feedback the agent must obey

Cole logs feedback in the Campaign Agent chat. Examples:

- "don't send to Nashville for 4 days"
- "skip Dallas until after the 12th"
- "push Columbus to the front, they asked for it"
- "stop all sends to Canada this week"

These are **operator directives**. They are not suggestions, and they persist beyond
the conversation that created them — a directive Cole gave on Monday must still apply
on Thursday's run, in a fresh session, with no chat history.

### 4.1 Two directive types

| Type | Meaning | Power |
|---|---|---|
| `block` | do not queue this market until the directive expires | **absolute** — overrides everything, including a `send` from the SQL floor |
| `boost` | prefer this market when ranking | **advisory** — moves it up the order, but can never bypass §1 |

A `block` can only make the agent **more** restrictive. A `boost` can only reorder
within the already-approved set. There is no directive that unlocks a market the SQL
floor rejected.

### 4.2 Recording a directive

When Cole says something that reads as a standing instruction about a market, the
agent must:

1. Resolve the market he named to a `market_key` / `state_code` (use
   `market_recipient_counts()` / `market_label()`). If it is ambiguous, ask — do not guess.
2. Convert relative time to an absolute date. "for 4 days" said on 2026-07-31 means
   `effective_until = 2026-08-04`. "until after the 12th" means `2026-08-12`.
   No stated duration on a `block` = default **7 days**, and say so back to him.
3. Persist it (see §4.4).
4. Confirm back in one line: *"Blocked NASHVILLE through 2026-08-04. Noted."*

### 4.3 Applying directives on every run

Before ranking, load all directives where `effective_until >= today` and
`revoked_at is null`. Then:

- Any candidate whose market has an active `block` → **remove from the candidate set**.
  Report it in the run summary as held by an operator directive, with Cole's own
  wording and the expiry date. Never silently drop it.
- Any candidate whose market has an active `boost` → rank it first, ahead of the
  metric ordering, as long as it still passed §1.
- Expired directives are ignored. Do not extend one on your own — if a block lapses
  and the market is still a bad idea, that is a ranking decision, not a directive.
- If Cole revokes ("Nashville is fine now"), set `revoked_at` and confirm.

### 4.4 Where directives live — BUILT (migration 041)

`public.campaign_directives` + RPCs now exist
(`migrations/041_campaign_directives.sql`), matching the naming below:

```sql
create table public.campaign_directives (
  id              uuid primary key default gen_random_uuid(),
  market_key      text not null,
  state_code      text,
  kind            text not null check (kind in ('block','boost')),
  note            text not null,         -- Cole's own words, verbatim
  created_by      text not null default 'cole',
  effective_from  date not null default current_date,
  effective_until date not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index on public.campaign_directives (market_key, effective_until);
```

RPCs (SECURITY DEFINER, granted to `anon`): `campaign_directives_active()` returns the
unexpired, unrevoked rows; `campaign_directive_add(p jsonb)` records one (a new
directive for the same market+kind supersedes the prior; a `block` with no stated
duration defaults to +7 days); `campaign_directive_revoke(p_id uuid)` soft-revokes.

The agent now has **durable memory of Cole's feedback across runs and sessions.** The
`campaign-queueing` OpenClaw skill (on the VPS) loads `campaign_directives_active()`
before every run and records directives when Cole gives a standing instruction.

---

## 5. Ranking — how to order what survives

Within the candidates that passed §1, §2, and §4:

1. Active `boost` directives first.
2. Then strongest opportunity:
   - **Proven performance** — higher `open_rate_w` / `ctr_w` over more `n_blasts`.
     A market with 3 blasts of real numbers beats one with 1.
   - **Low fill** — lower `filled_pct` = more seats to move = more urgent.
   - **Urgency** — fewer `days_until` = more urgent.
   - **Healthy list** — penalise `optout_warning` and `fatigue_warning`.
   - **Reach** — `email_count` / `phone_count`; a market with almost no recipients is
     a weak use of a slot.
3. Tie-break on sooner `event_date`.

The agent may **veto** a candidate it thinks is a poor use of a send right now — but
only from the given list, and only with a written reason citing the actual numbers.

---

## 6. Output

Every pick needs a one-sentence reason built from **concrete numbers it was handed** —
e.g. *"18% open / 8% CTR over 3 blasts, only 20% filled, 6 days out."* No vague
justification, no invented statistics.

Per run, report:

- `picks` — `event_id`, market, `slot_date`, reason
- `vetoed` — `event_id`, market, reason
- `blocked_by_directive` — market, Cole's note, expiry
- `already_queued` — candidates dropped because the queue already holds them
- `skip_by_reason` — counts per `reason_code` from the SQL floor
  (`no_history`, `nearly_full`, `too_early`, `cooldown`)
- the per-day plan: date, already queued, gap filled

### Enqueue payload

`queue_enqueue_test(p_rows)` takes a JSON array. Per row:

```json
{
  "title": "Nashville Predators vs Dallas Stars",
  "state_code": "TN",
  "state_name": "Tennessee",
  "event_id": "uuid-from-recommendations",
  "email": true,
  "sms": false,
  "email_count": 1240,
  "phone_count": 0,
  "sms_count": 0,
  "email_copy": null,
  "sms_copy": null,
  "scheduled_for": "2026-08-02T14:00:00Z"
}
```

Rows land as `status = 'pending'`, `is_placeholder = true`. Rows already live are
skipped and not returned — so the return value is exactly what was **added**.

---

## 7. Guardrails

- **Do not send on your own initiative.** Queueing a placeholder is the default; the
  scheduled cron owns delivery. The agent must never sweep the queue, never send a row
  nobody asked about, and never send as a side effect of a queueing run.
- **Manual send — only when a user explicitly asks.** If a user tells the agent to send
  a specific queued blast now ("send the Nashville one", "blast Columbus now"), the agent
  may fire **that one row** by calling the manual **Send now** path:
  `POST /api/queue-tick` with body `{ "id": "<queue_row_id>" }` and, when out of test
  mode, header `x-send-secret: <SEND_SECRET>` (in test mode the `{id}` body alone is
  accepted). Rules for a manual send:
  - **One named row per request.** Resolve the user's words to exactly one queue row
    (use `get_campaign_queue()`; if it's ambiguous, ask — never guess). Never post `{}`
    (that's a queue-wide sweep, which is the cron's job and is refused without a secret).
  - It is fine that the row is a placeholder — the manual path sends placeholders
    deliberately; the user's request *is* the confirmation the cron would otherwise wait for.
  - The endpoint reports `cooldown_overridden` and a past-game "!" back; **relay that to
    the user** rather than hiding it, and confirm what was sent (or why it didn't — the
    response's `held` / `errors`).
  - It still cannot reach a real market while `send_test_mode()` is non-empty — only the
    allowlisted market resolves recipients. Say so if the user sends a non-allowlisted market.
- **Never write blast history.** Do not call `log_market_blast` (either overload),
  `queue_mark_sent`, or `upsert_salesmsg_broadcasts`. Queueing is not sending. The
  14-day cooldown is written by `api/queue-tick.js` when a blast actually delivers, and
  by nothing else — logging a pick puts a market on cooldown for a send that never
  happened and eats into the next run's candidate pool.
- **Never retarget a pick to the test market.** Queue the market that was chosen; the
  allowlist is what stops the send (see Test mode).
- **Never edit an existing queue row** as part of a queueing run. Copy, sender,
  schedule edits, and confirmations are the human's.
- **Never invent an `event_id` or a market.**
- **A `block` directive always wins.** When a directive and the metrics disagree,
  the directive wins and the disagreement gets reported, not resolved.
- **When in doubt, queue fewer.** An empty slot costs nothing. A wrong blast burns a
  list and a 14-day cooldown.

---

## Open items

- [x] Build `campaign_directives` + RPCs (§4.4) — done, migration 041.
- [x] Direct vs endpoint — **direct**: the OpenClaw `campaign-queueing` skill calls the
      Supabase RPCs itself. `api/trigger-decide.js`'s gpt-4o step is superseded and can
      be retired.
- [x] Execution — the agent auto-enqueues on a daily cron (`daily-campaign-queue`,
      8am ET, defaults per_day=4 / through=today+3, placeholders only). A human still
      confirms before the send cron fires.
- [ ] **Pick one canonical blast log.** `rpc_event_recommendations()` takes its cooldown
      from `ticketblaster_market_blasts_log` (`market_key`); `api/queue-tick.js` writes
      real sends to `market_blast_log` (`market_code`) via the other `log_market_blast`
      overload. Nothing bridges them, so once sending opens up **a real send will never
      register as a cooldown with the decider** and it will keep re-picking a market it
      just blasted. `market_cooldowns()` still catches it at send time, so no double-send
      — but every slot would be wasted. Was masked until 2026-07-31 because the test
      writes were the only thing populating the decider's table.
- [ ] `campaign_send_log` exists but is not written by the current path — wire it or
      drop it from the audit story.
- [ ] `CAMPAIGN_SEND_RULES.md` is stale (3–21 day window, 90% fill, daily cap 3,
      dry-run flag). It does not match shipped code. Retire it in favour of this file.
