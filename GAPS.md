# System gaps

> **ACTIVE CHANGE — 2026-08-12: the hourly auto-send cron is DISABLED.**
>
> `{ "path": "/api/queue-tick", "schedule": "0 * * * *" }` was removed from `vercel.json` so
> the system can run with test mode off — appearing live — without anything sending on its
> own. This is the ONLY control preventing automatic sends once `send_allowlist` is empty:
> the cron needs no human, so "nobody will press send" does not cover it.
>
> Manual "Send now" still works for anyone holding `SEND_SECRET`, and CakeMail / Telnyx
> credentials remain configured. This is a stop on automation, not a disconnection.
>
> **Restore by putting that line back and redeploying** — and do restore it, because with the
> cron off, scheduled blasts silently never go out. That failure is quiet: rows simply sit in
> the queue looking scheduled.


Findings from the 2026-08-12 review, written while standing up the send-test harness. Most
were found by reading the code and querying the live database rather than by testing, so
each is tagged with how strongly it is established:

- **Verified** — confirmed against the live database or by direct execution
- **Read** — read in the code or the exported n8n JSON; not observed running
- **Inferred** — reasoned from how the pieces fit; would need checking

The ranking is by what happens if it bites, not by how hard it is to fix.

---

## 1. Nothing can see whether an SMS was delivered — **Verified** (partly fixed 2026-08-12)

**Fixed:** the send request never asked for delivery receipts. `n8n/bulk-send-workflow.json`
posted `{from, to, text}` to Telnyx with no `webhook_url`, so receipts depended entirely on
whatever is configured on messaging profile `40019f22-…` — and evidently nothing is. The send
body now carries an explicit
`webhook_url: https://playbooksports.app.n8n.cloud/webhook/telnyx-inbound`, which is the same
endpoint the inbound workflow already parses correctly.

**Still open:** receipts update `telnyx_messages.status` per message, but nothing links a
message back to the blast that sent it — `telnyx_send_outbound(p_from, p_to, p_body,
p_telnyx_message_id)` records no queue id. So "how many of blast X actually landed" is still
unanswerable except by time-window guesswork. Needs a `queue_id` on `telnyx_messages`, a
matching RPC parameter, and the workflow passing it.

**REQUIRES RE-IMPORT.** The files in `n8n/` are exports, not the running workflows. Editing
them changes nothing until the workflow is re-imported into n8n Cloud.

## 1b. Original diagnosis — **Verified**

Every outbound message ever sent is still at status `queued`. All 11 of them. Not one has
moved to `delivered` or `failed`.

The wiring exists: `n8n/inbound-workflow.json` has a `message.finalized` branch that calls
`telnyx_update_status`, and the RPC is present in the database. But no message has ever been
updated by it, so either the webhook is not configured on Telnyx's side for messaging profile
`40019f22-ee12-4a37-a3d8-c4255ed71c03`, or the branch is not matching the payload.

`BACKLOG.md` item 7 describes this as parked, and says the workflow branch needs wiring —
that branch is now present, which narrows the problem to the Telnyx-side configuration.

**Why it ranks first:** every other SMS question — throughput, carrier limits, whether a
blast worked — is unanswerable until this works. It is also the cheapest thing on this list
to fix.

## 2. A failed SMS blast is recorded as a successful one — **Verified** (partly fixed 2026-08-12)

**Fixed:** the recorded string no longer claims delivery. `api/queue-tick.js` wrote
`SMS 1200`, which reads as a delivered count; it now writes
`SMS 1200 handed off (delivery unconfirmed)`. The Telnyx node also gained
`retryOnFail` (3 tries, 2s apart) and `onError: continueRegularOutput`, so a single failed
message no longer risks halting the run and abandoning the rest of the batch.

**DEMONSTRATED LIVE, 2026-08-18.** A QA send was rejected outright by Telnyx —
`400 Source and destination cannot be the same number` — and the failure was completely
invisible from our side:

| What happened | What we saw |
| --- | --- |
| Telnyx refused the message with a hard 400 | `HTTP 200 {"message":"Workflow was started"}` |
| Workflow halted at the failing node | nothing |
| No message sent | no row in `telnyx_messages` |
| — | no error anywhere |

This is the easiest class of failure there is: an explicit, immediate vendor rejection. It
still vanished without trace. Had it come from `queue-tick` on a real blast, the row would
have been marked **sent** and the market locked for 14 days with nothing delivered.

**Still open — the important half.** The row is still marked sent and the market still cools
for 14 days on the strength of that handoff. Closing that properly needs the reconciliation
described in gap 1, then a rule for what to do when delivered ≪ handed off. That is a
business decision as much as a technical one, since it collides with the existing rule that
one send cools both channels.

## 2b. Original diagnosis — **Verified (code) / Inferred (impact)**

The Telnyx route is fire-and-forget. `api/queue-tick.js` POSTs the whole message array to the
n8n webhook, which is configured `responseMode: onReceived` — it returns `200` the instant it
receives the payload, before contacting Telnyx at all.

`queue-tick` treats that `200` as success. It then:

- marks the blast **sent** (`queue_mark_sent`)
- writes `log_market_blast`, putting the market on a **14-day cooldown**

So if Telnyx rejected all 12,000 messages, the app would show a completed blast and refuse to
retry that market for two weeks. Combined with gap 1, there is currently **no point anywhere
in the SMS path where a failure becomes visible.**

## 3. The whole safety model rests on one table being non-empty — **Verified**

`send_allowlist` is the only thing preventing sends to real customers. While it is non-empty,
`market_emails` / `market_phones` resolve to zero rows for every market not listed. This is
genuinely robust — enforced in SQL, `SECURITY DEFINER`, and it is the only recipient-resolution
path in the codebase. Confirmed empirically: `CA` displays 2,586 contacts and resolves to 0.

The gap is that `truncate public.send_allowlist` re-arms all 45 markets in one statement, with
no confirmation, no staging, and no alert. There is no "arm one market" step.

It is also load-bearing in a second, less obvious way: `api/queue-tick.js` allows an
**unauthenticated** "Send now" for a single row *because* test mode bounds the damage. That
path closes automatically when the allowlist empties — which is good design, but it means
emptying the table changes two security properties at once.

**Worth adding:** a guard that refuses to empty the allowlist without an explicit override, or
a scheduled check that alerts if it ever becomes empty unexpectedly.

## 4. The site is public and leaks 25,425 prospect records — **VERIFIED 2026-08-18**

Confirmed end to end during the QA sweep. This is the most serious finding in this document
and it outranks everything above it.

The full chain, each step verified:

1. `https://telnyx-inbox.vercel.app/` serves **HTTP 200 with no authentication**
2. `/config.js` is served publicly and **hands the Supabase anon key to any visitor**
3. That key, used from an unrelated machine, reads production tables directly

What an anonymous caller can read today, with exact row counts measured:

| Table | Rows exposed |
| --- | --- |
| `enriched_prospects` | **25,425** |
| `events_master` | 2,449 |
| `blast_templates` | 140 |
| `telnyx_messages` | 22 (SMS bodies) |
| `telnyx_conversations` | 3 |

`enriched_prospects` carries a `contacts` column containing `contacts_list` — this is the
prospect database, including contact details. 25,425 records of business contact data
readable by anyone who views source on the page.

Migration 052 did work, partially: `market_contacts` now returns **401**, and
`campaign_queue`, `send_allowlist` and `contact_intel` return zero rows to anon. The lockdown
was real but incomplete — `enriched_prospects` was missed, and it is the largest dataset here.

**Sending is NOT exposed.** With test mode off, `api/queue-tick.js` requires `SEND_SECRET`
for the no-credential path, so an anonymous visitor cannot trigger a blast. The exposure is
read-only — which is the lesser half, but 25,425 contact records is not a small lesser half.

**Fix:** RLS on `enriched_prospects` (and re-audit every other table against anon), then move
the site behind real authentication. Note that revoking anon on `enriched_prospects` may break
UI features that read it — check before applying.

## 5. Recipient counts shrink silently — **Verified (partially fixed)**

Three places drop recipients without reporting how many:

1. ~~`limit 1000` in both resolvers~~ — **fixed 2026-08-12**, migration 054
2. Deduplication (`new Set`) in `api/queue-tick.js` and `lib/cakemail.js`
3. Malformed-address filtering (`validEmail` / `validPhone`)

The cap was the big one: 16 of 45 markets exceeded it, 10,725 addresses beyond it, while the
UI displayed the true figure because `market_recipient_counts()` is neither capped nor gated.
A blast reaching 39% of a market looked flawless on every screen.

The remaining two are smaller but the same shape — resolved count and submitted count can
still disagree with nobody told. **Worth reporting both numbers on the blast record.**

**Measured 2026-08-18.** The display-vs-resolve gap is genuinely closed: across all 31
distinct market codes, `market_recipient_counts()` now matches what `market_emails()` actually
returns. Removing the cap fixed that half completely.

The JS-side shrinkage is still real and still unreported. On `ZZ`: **6 addresses resolve, 5
survive deduplication** — one silently lost, and nothing anywhere reports it. Phones were
clean (121 in, 121 out). The equivalent measurement on `CA` (2,713 addresses) timed out when
paging through the REST API and remains **unmeasured** — worth running directly in SQL.

## 6. The Telnyx sender is hardcoded — **Verified**

`n8n/bulk-send-workflow.json` builds its request body with a literal:

```
from: "+16158050766"
```

`queue-tick` passes the row's chosen `sms_from` on every message, and n8n discards it.

Harmless today — `telnyx_numbers` holds exactly one number and it is that one. But the UI has a
sender picker, and `ui/index.html` has repair logic that writes `sms_from` onto rows so they
send from the "right" number. For Telnyx rows all of that is decorative. Add a second number
and it will silently send from the first while the UI insists otherwise.

## 7. We send at 11% of our carrier allowance — **Verified**

Registered 10DLC limits: **AT&T 2,400/min** (Class D), **T-Mobile 40,000/day** (UPPER_MID tier).

The n8n workflow sends at `batchSize: 5` / `batchInterval: 1100ms` — about **273/min**. Roughly
a ninth of what AT&T already permits.

A 12,000-message blast therefore takes ~44 minutes instead of ~5. The setting looks like a
cautious default from before the campaign was vetted, not a decision made against these
numbers.

Raising it should wait for gap 1: exceed the registered rate and Telnyx queues or rejects the
overflow, and right now nothing would tell us.

## 8. No retries, and it DOES halt on error — **VERIFIED LIVE 2026-08-18**

Confirmed by a QA send. Telnyx rejected one message with
`400 Source and destination cannot be the same number`, and the "Record Outbound (RPC)"
node never ran — no row was written to `telnyx_messages` at all. The workflow stopped at the
failing node, exactly as n8n's default `stopWorkflow` behaviour implies.

**Consequence at scale:** in a 1,200-message batch, one rejection at message 200 abandons the
remaining 1,000 — and, per gap 2, reports success while doing it. Undelivered messages leave
no record, so there is nothing to retry from either.

Fixed in the repo copy (`retryOnFail`, 3 tries, 2s apart, plus
`onError: continueRegularOutput`) but **NOT YET LIVE** — the workflow must be re-imported into
n8n Cloud before any of that applies.

## 8b. Original diagnosis — **Read**

The Telnyx node has no `retryOnFail` and no `onError` configured, so a transient failure loses
that message permanently. n8n's default behaviour on a node error is to stop the execution,
which would abandon **every remaining message in the batch** — a single failure at message 200
of 12,000 could drop the other 11,800.

Read from the exported JSON, not observed. **Needs confirming against the live workflow**,
since the export may lag what is running.

## 9. Single number, single point of failure — **Verified**

One number (`+1 615 805 0766`), one messaging profile, one 10DLC campaign. If it gets blocked,
rate-limited, or flagged, all SMS stops and there is no fallback. Re-registering a new number
under 10DLC takes days to weeks.

This is why a volume test against fake numbers is a bad trade: a ~100% failure rate is the
classic signature carriers watch for, and the number now carries an UPPER_MID tier worth
protecting.

## 10. The bulk paths have never run at size — **Verified**

- SMS: **11 outbound messages, ever**, to 1 distinct recipient, on 2026-07-02
- Email: `lib/cakemail.js` notes claim verification at ~1,800 addresses

Both paths hand their entire list over in **one request** — CakeMail gets every address in a
single `import-contacts` body, Telnyx gets every message in a single n8n webhook payload.
Neither has been exercised near the volumes now possible after migration 054 removed the cap.

This is the one gap that is genuinely a *testing* gap rather than a defect, and it is testable
safely: run the pipeline up to the handoff without sending.

## 11. Email delivery is unverifiable from our side — **Verified**

CakeMail is list-based: one blast is five API calls, and CakeMail does the fan-out. We cannot
observe per-recipient delivery, and an SMTP sink cannot intercept an HTTPS API client — which
is why the Mailpit harness built this session cannot measure the email path at all.

Our only visibility is CakeMail's own reporting, synced by `api/cakemail-sync.js`. That is
reasonable — it is what they are paid for — but it has never been reconciled against what we
submitted. **Worth doing once:** does their reported sent count match the list we handed over?

## 12. Failed email sends leave debris — **Verified (deliberate)**

`lib/cakemail.js` throws on any step and deliberately leaves the half-built campaign in place
for inspection in the CakeMail UI. Sensible for debugging, but it means repeated failures
accumulate orphaned lists and campaigns in the account, and "nothing was sent" does not mean
"nothing happened." No cleanup exists.

## 13. List-Unsubscribe is unverified — **Verified (as a gap)**

We never set the header ourselves. `lib/cakemail.js` sets `default_unsubscribe_link: true` and
CakeMail's MTA injects `List-Unsubscribe` at send time. Nobody has confirmed it actually
arrives on a delivered message. Requires receiving a real CakeMail-sent email — not checkable
by inspection.

Compliance-relevant (CAN-SPAM / CASL), so worth closing properly rather than assuming.

## 14. Undocumented identifiers — **Verified**

The 10DLC **campaign ID** and **brand ID** are recorded nowhere — not in the repo, not in any
table. `telnyx_numbers` stores `messaging_profile_id` and nothing else. Both exist only in the
Telnyx portal, and both are needed to reason about carrier limits.

`BACKLOG.md` item 8 is also stale: it lists 10DLC registration as outstanding, but the campaign
is now qualified on both carriers at UPPER_MID.

---

## Test-harness infrastructure (2026-08-12)

Standing up the Mailpit harness introduced gaps of its own, recorded here so they are not
forgotten:

- **Port 1025 is open to the internet** on the Contabo box (`94.72.117.9`) — an SMTP sink whose
  only guard is the `@example\.test$` recipient allowlist. Deliberate, to allow external
  delivery. Currently unreachable from outside anyway, which is itself unexplained: the host
  firewall is clean and the box reaches its own public IP, so the block is upstream (Contabo
  cloud firewall, most likely).
- **Root SSH password was shared in plaintext** and has not been rotated. A dedicated key is
  installed; `PermitRootLogin prohibit-password` would close the password path.
- **The harness measures nothing today.** It was built for a per-recipient SMTP fan-out that
  this system does not have. Its one live use is spam-scoring the blast template via
  SpamAssassin, which needs no sending.

---

## Suggested order

1. **Fix delivery receipts** (gap 1) — everything SMS depends on it, and it is small
2. **Confirm the public-access position** (gap 4) — may already be fixed; if not it is first
3. **Make a failed blast fail loudly** (gap 2) — stop marking un-sent blasts as sent
4. **Reconcile CakeMail's numbers once** (gap 11) — cheap, and it is our only email visibility
5. **Test the pipeline to the handoff at 12,000** (gap 10) — safe, and the cap is now lifted
6. **Then** tune throughput (gap 7), with receipts working so the effect is observable

Gaps 3, 6, 8, 12, 13 and 14 are small and can be picked up alongside any of the above.
