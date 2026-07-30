# Campaign Queue — Decision Rules for OpenClaw

Instruction sheet for the **Campaign Agent (OpenClaw)** when it decides which events
go into the campaign queue.

This replaces the OpenAI `gpt-4o` re-rank step currently in `api/trigger-decide.js`.
Everything below is what that endpoint does today, plus the new **Cole directives**
layer (§4), which does not exist in code yet.

Nothing here sends. The agent only proposes/enqueues **placeholder** rows
(`is_placeholder = true`). A human confirms; `api/queue-tick.js` never sends a
placeholder.

---

## 0. Data sources

Supabase (`SUPABASE_URL`, anon key). All are RPCs — `POST /rest/v1/rpc/<name>` with `{}`.

| RPC | Returns | Used for |
|---|---|---|
| `rpc_event_recommendations()` | one row per upcoming game with `decision` = `send`/`skip` + `reason_code` | the candidate set — **the safety floor** |
| `market_recipient_counts()` | `market_key`, `state_code`, `phone_count`, `email_count` | reach per market |
| `get_campaign_queue()` | current queue rows | what is already scheduled |
| `queue_plan(p_from, p_to)` | per-day `queued` count + `event_ids` / `market_codes` already taken | day-by-day gaps |
| `market_cooldowns()` | last blast date per market | cooldown audit |
| `queue_enqueue_test(p_rows jsonb)` | inserted rows | **write** — add placeholders |

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

### 4.4 Where directives live — NOT BUILT YET

No table exists for this today. Proposed, matching the existing naming:

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

Plus an RPC `campaign_directives_active()` returning the unexpired, unrevoked rows,
and `campaign_directive_add(p jsonb)` / `campaign_directive_revoke(p_id uuid)`.

Until that ships, the agent has **no durable memory of Cole's feedback across runs**.
Anything relying on §4 is chat-session-scoped only. This is the one gap that has to be
closed before OpenClaw can own the decision.

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

- **Never send.** The agent queues placeholders. A human confirms (`queue_confirm`),
  and `api/queue-tick.js` refuses to send anything with `is_placeholder = true`.
- **Never edit an existing queue row** as part of a queueing run. Copy, sender,
  schedule edits, and confirmations are the human's.
- **Never invent an `event_id` or a market.**
- **A `block` directive always wins.** When a directive and the metrics disagree,
  the directive wins and the disagreement gets reported, not resolved.
- **When in doubt, queue fewer.** An empty slot costs nothing. A wrong blast burns a
  list and a 14-day cooldown.

---

## Open items

- [ ] Build `campaign_directives` + RPCs (§4.4) — blocking for durable Cole feedback.
- [ ] Decide whether OpenClaw calls Supabase directly or through
      `api/trigger-decide.js` with the LLM step removed.
- [ ] `campaign_send_log` exists but is not written by the current path — wire it or
      drop it from the audit story.
- [ ] `CAMPAIGN_SEND_RULES.md` is stale (3–21 day window, 90% fill, daily cap 3,
      dry-run flag). It does not match shipped code. Retire it in favour of this file.
