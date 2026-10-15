# SendBlaster ↔ bulk sender (AI-965)

How SendBlaster's Telnyx SMS blasts go out through the bulk sender. For what the bulk sender
itself is, see [bulk-sender.md](bulk-sender.md).

**Goal (Charles, 2026-10-13):** SendBlaster uses our phone numbers with **no UX change**. Users
pick one of our numbers in the existing sender dropdown and press Send now, or let the hourly
cron send, exactly as before. Only what happens after the send changed.

## The flow

```
Queue row (campaign_queue), confirmed + due, or Send now
        │  api/queue-tick.js (hourly cron, or POST {id})
        ▼
SMS sender?  ── Salesmsg ──────────────► Salesmsg (unchanged)
        │
        └─ Telnyx ── smsPathFor({configured, from, routes}) ─┐
                                                             ├─ 'bulk'    → stage with the bulk sender (below)
                                                             ├─ 'webhook' → FAIL: "SMS not sent: … not one of the bulk sender's numbers"
                                                             └─ 'unknown' → FAIL: could not read the route list (retry next run)

stageCampaign() ── POST /api/campaigns/external {key, name, body, from_inbox, recipients:[{phone}], auto_send}
        ▼
bulk sender: HubSpot match + consent census ──► draft
        ├─ auto_send && SendBlaster's secret && production && 1 ≤ eligible ≤ 2,000
        │      → ARMED (running), armed_by 'sendblaster', first send in 3 min (deferred_until)
        └─ otherwise → stays a DRAFT; a person approves it in the Operator App
        ▼
reply {campaign:{status}, auto_armed, why, census…}  →  queue-tick records it on the row
```

- **`lib/bulk-sms.js`** is the client: `bulkSmsConfigured`, `autoSendRequested`, `listRoutes`,
  `smsPathFor`, `stageCampaign`, `findCampaignByKey`, `listCampaigns`, `campaignKeyFor`,
  `startsCooldown`, `draftHolds`, `heldByDraft`. Its tests are in `scripts/bulk-sms.test.mjs` (32), run with
  `node --test scripts/bulk-sms.test.mjs`. The repo has no `package.json`.
- **`api/queue-tick.js`, bulk branch:** reads the route list once per run, stages each row, records
  `bulk_campaign_id` and `bulk_census` on the row, and decides the market cooldown.

## Which rows go to the bulk sender

| Row's SMS sender | Path |
|---|---|
| One of the bulk sender's numbers (`GET /api/routes`) | **bulk**. A listed number that is not sendable still goes to bulk, so it fails visibly rather than texting around the consent gate |
| Any other Telnyx number (e.g. "2-way 1" `+14422300850`, "Main" `+16158050766`), or a blank sender | **fails**: `SMS not sent: <number> is not one of the bulk sender's numbers — Telnyx blasts send only through the bulk sender's consent gate` |
| Bulk sender not configured (previews, laptops) | **fails**: `SMS not sent: the bulk sender is not configured here …` |
| Route list unreadable | **fails** for this run, and the next run asks again |
| Salesmsg | Salesmsg. This integration does not change it |

The **n8n SMS webhook branch was removed** from `queue-tick.js` on 2026-10-14. It texted every
number in `market_phones`, a list with no `sms_opt_in` filter.

History: before 10-06, every Telnyx row went to n8n. Luiz's `770bd27` (10-06) sent every Telnyx row
to the bulk sender, which refused non-route numbers. PR #4 settled it as above.

## Auto-send (2026-10-14)

- SendBlaster sets `auto_send: true` **only when `VERCEL_ENV === 'production'`** (`autoSendRequested`).
  `BULK_SMS_ALLOW_NONPROD=1` does **not** enable it, because a preview calls the bulk sender's
  **production** and would text real people.
- The bulk sender arms only when **all** of these hold. Anything else stays a draft, which is the safe direction:
  - the request was authenticated with **SendBlaster's own secret**, not the operator `API_SECRET`;
  - it is running in production (`canSend()`);
  - `1 ≤ eligible ≤ EXTERNAL_AUTO_ARM_MAX`, which defaults to **2,000** and counts *eligible* recipients, not the market size;
  - the arm `UPDATE` matches the row, so it is still an undiscarded, unheld draft with someone pending.
- An auto-armed campaign waits **3 minutes** before its first text (`deferred_until`), then sends within quiet hours.
  The Operator App shows it as "from SendBlaster · no approval needed · Sending". **Stop** works there.
- A `sendingNotice` goes through `HOLD_NOTIFY_WEBHOOK_URL`. That is unset on purpose, so today it is a log line.
- SendBlaster reads the **real** `campaign.status` from the reply, never what it asked for.

## What the Queue row says

| Note on the row | Meaning |
|---|---|
| `SMS sending to N of M (<number>)` | Armed. N eligible out of M numbers in the audience |
| `SMS already sending — campaign is <status> (<number>)` | A retried run found its campaign already running (409, adopted) |
| `SMS staged for N of M — awaiting approval in the Operator App (<why>)` | Draft. `why` is `above ceiling`, `not production`, `not requested` or `arm failed` |
| `0 of M eligible (<reasons>) — nothing was staged` | 422. Nobody in the audience is an opted-in HubSpot contact. The cron skips the row; Send now retries |
| `this blast was discarded in the Operator App — re-queue it as a new row` | The draft was discarded. The key belongs to that row for good |
| held: `out of time in this run — the next run sends it` | The run had less than 250 s of its 300 s left. The **whole row** waits, email included |

A typical market sees about 65% of its numbers eligible (10-09 sample of 100). Scraped numbers that
are not in HubSpot show up as `not_in_hubspot` and are never texted.

## Market cooldown (14 days)

- **Sending:** `log_market_blast` runs in the same run. The row's `bulk_census.cooldown` is written
  `deferred` and flips to `at_send` only after the log succeeds. If the log fails, `reconcileBulk`
  logs it on the next run. The in-memory cooled set is updated right away, so a second row for the
  same market in the same run is held.
- **Draft:** the cooldown stays `deferred` until `reconcileBulk` sees the campaign approved and sending.
  Meanwhile the draft **holds its market** (cron reason `awaiting_approval`), so a second draft
  cannot text the same people. The bulk sender does not de-duplicate a person across campaigns.
- Send now overrides cooldowns and holds, as it always has. That can text a cooled market again.

## Keys

`campaignKeyFor(row)` builds `<ASCII title, ≤ 72 chars> #<first 6 hex of row id>`. A person types it to
approve a draft. It is deterministic per row, so a retried run gets a 409 and adopts the existing campaign
instead of creating a second one. The ` #hex` suffix keeps it apart from stamp keys. `<`, `>` and backticks are
stripped, because the key is posted into chat.

## Settings

**SendBlaster** (Vercel team `mgimutao-3747s-projects`, which only Luiz can see):

| Variable | Scope | Value |
|---|---|---|
| `BULK_SMS_API_URL` | Production | `https://hubspot-telnyx-integration.vercel.app` |
| `BULK_SMS_API_SECRET` | Production | the same value as the bulk sender's `SENDBLASTER_API_SECRET` |
| `BULK_SMS_ALLOW_NONPROD=1` (+ the two above) | **Preview only, for testing** | Makes the client active off production. It still never auto-sends |

**Bulk sender** (Vercel team `playbook-ai-agents`, Production): `SENDBLASTER_API_SECRET`, which must
**differ** from `API_SECRET` (verified 2026-10-14). `EXTERNAL_AUTO_ARM_MAX` is optional, default 2,000.
`HOLD_NOTIFY_WEBHOOK_URL` is optional and unset.

The readable copy of the secret is Charles's `../hubspot_telnyx_integration/.superpowers/rollout/sendblaster-secret.txt`,
which only he can read. Vercel marks it Sensitive, so it cannot be read back. A local `.env` may hold
`BULK_SMS_API_URL` / `BULK_SMS_API_SECRET`, but **never** `VERCEL_ENV=production`, which would
make a laptop auto-send.

## Testing safely

- Unit tests: `node --test scripts/bulk-sms.test.mjs`. `queue-tick.js` has no test harness. Changes were
  checked with a throwaway, fully mocked script (every `fetch` stubbed), and `node --check api/queue-tick.js`.
- **Never** stage from a laptop against production on purpose. Any staging from a preview or laptop
  creates a **draft in the bulk sender's production database**. It never sends, but discard it in the
  Operator App afterwards.
- Test numbers only in the `555-0100`–`555-0199` range. They are refused before HubSpot (422 `unusable_phone`).
  A real end-to-end test needs a person's own opted-in number.
- Read-only checks:
  - `GET /api/routes` with the secret returns 200 and the 7 routes;
  - `GET /api/campaigns` with the secret lists **only SendBlaster's** campaigns;
  - with no secret, both return 401.

## Rules that do not bend

- **Consent:** never build anything that sets, defaults or infers SMS consent, or that texts numbers not
  held by a HubSpot contact with `sms_opt_in = true`, on the bulk path. Charles asked about an
  override on 10-12; it was declined. It would not raise throughput, because HubSpot inbox logging is the
  ceiling, and it risks TCPA and the shared 10DLC campaign.
- Only SendBlaster's secret may skip approval. The operator secret still arms only through the typed-key arm route.
- Don't deploy the bulk sender during a blast.

## Known limits

- If the bulk sender arms but SendBlaster's write of `bulk_campaign_id` fails, and someone then edits
  the row's title before the retry, a second campaign could be staged and auto-sent. It is rare: the
  end-of-run guard makes a killed run unlikely.
- A 2,000-person blast takes several minutes at about 4–8 texts/s, and T-Mobile's brand cap is about
  2,000 a day, so `40016` halts can happen on big days.
- The sender dropdown still offers non-route Telnyx numbers. They fail with a clear message.
- The legacy `confirmSend` in `ui/index.html` still posts to the n8n SMS webhook. Nothing reaches it
  today. Delete it, along with the `BULK_SEND_WEBHOOK_URL` config key, in a follow-up.

## History

| Date | What |
|---|---|
| 2026-09-21 | AI-965 architecture brief (option A: stage, then arm) |
| 2026-10-09 | #131 (bulk sender) + #2: SendBlaster stages drafts and a person approves every one. Migration 0026 |
| 2026-10-12 | #3: promoted to SendBlaster `main` via `dev-charles` |
| 2026-10-14 | #134 (bulk sender) + #4: auto-send at most 2,000 from production, 3-minute delay, only our numbers go to bulk, no Telnyx SMS to n8n, whole-row end-of-run guard |
