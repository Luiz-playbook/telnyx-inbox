# Bulk send webhook payloads (SMS + email)

How the app actually fires blasts, the exact JSON payloads we send, and how those
payloads evolved. All sending goes to **n8n webhooks** on
`https://playbooksports.app.n8n.cloud/webhook/...` (except CakeMail — see below).

Config values live in `ui/config.js` (generated from Vercel env by
`scripts/gen-config.js`). Endpoints referenced here:

| Purpose | config key | default URL |
|---|---|---|
| SMS bulk send | `BULK_SEND_WEBHOOK_URL` | `.../webhook/telnyx-bulk-send` |
| Email bulk send (Gmail mail merge) | `EMAIL_SEND_WEBHOOK_URL` | `.../webhook/gmail-bulk-send` |

**Auth:** every webhook call sends header **`x-inbox-secret: <REPLY_SECRET>`**
(`REPLY_SECRET` = `"playbook"`), plus `Content-Type: application/json`.

---

## SMS — `telnyx-bulk-send`

**Payload we send:**
```json
{
  "from": "+16158050766",
  "messages": [
    { "from": "+16158050766", "to": "+15551234567", "text": "Hey, it's Josh from Playbook…" }
  ]
}
```
- One object per recipient in `messages`.
- `to` numbers are normalized to E.164 (`+1XXXXXXXXXX`) and de-duplicated before sending.
- `from` is the Telnyx number chosen in the Queue's **Text from** column (`sms_from`).
- Per the n8n workflow comment the *minimal* shape it needs is just
  `{ "messages": [{ "to", "text" }] }` — the sending node can set `from` itself —
  but we include `from` (top-level and per-message) so the number is explicit.

## Email — `gmail-bulk-send`

**Payload we send:**
```json
{
  "from": "john@callplaybook.com",
  "messages": [
    { "from": "john@callplaybook.com", "to": "rion@callplaybook.com",
      "subject": "Angels vs Astros — tickets", "html": "Hi,<br><br>…" }
  ]
}
```
- `html` is the blast copy with newlines converted to `<br>` (`nl2br`).
- **`from` drives an n8n Switch node** that routes to the right Gmail account
  (`john@callplaybook.com` vs `rion@callplaybook.com`). Send with the wrong/blank
  `from` and the Switch won't match → nothing sends. This is why we always set it
  from the Queue's **Send from** column (`email_from`).

---

## Email routing: mail merge vs CakeMail

Added when CakeMail was introduced (`api/queue-tick.js` + `lib/cakemail.js`):

- If a row's **`email_from` is shaped `cakemail:<account_id>:<sender_id>`**, the send
  goes **straight to the CakeMail API** (one campaign for the whole market, a few API
  calls total) — it does **not** hit the n8n webhook.
- Any other `email_from` → the **Gmail mail-merge webhook** above.

Keep the sender list in `ui/index.html` (`EMAIL_SENDERS` / method dropdown) in sync
with this routing.

---

## What changed over time

1. **Original** (manual Queue "Confirm", `ui/index.html` `confirmSend`): sent
   `{ from, messages: [{ from, to, text }] }` (SMS) and
   `{ from, messages: [{ from, to, subject, html }] }` (email).
2. **Auto-send** (`api/queue-tick.js`): same shapes, built server-side per queued
   blast — pulls recipients per market (`market_phones` / `market_emails` RPCs),
   sets `from` from the row's `sms_from` / `email_from`.
3. **Email split** (CakeMail): `email_from` now also encodes the *method* —
   `cakemail:…` bypasses the webhook and calls the CakeMail API directly; everything
   else stays on the Gmail webhook.

## Health check (no sends)

To confirm a webhook is live/active **without sending anything**, POST an empty
`messages` array:
```bash
curl -s -X POST "$BULK_SEND_WEBHOOK_URL" \
  -H "Content-Type: application/json" -H "x-inbox-secret: playbook" \
  -d '{"messages":[]}'
# -> 200 {"message":"Workflow was started"}
```
Zero recipients = zero sends, but a `200 "Workflow was started"` proves the workflow
is registered and accepting the payload. (Both SMS and email webhooks verified this
way 2026-07-25; a single real test email was sent john@ → vhea@/john@callplaybook.com.)

## Where this lives in code

- `api/queue-tick.js` — builds and sends both payloads (SMS webhook, Gmail webhook,
  or CakeMail API), on the auto-send cron / on-demand.
- `lib/cakemail.js` — the CakeMail send path (`sendCampaign`, `parseCakemailFrom`).
- `ui/index.html` — the Queue's **Send from** / **Text from** sender selection that
  populates `email_from` / `sms_from` on each row.
- `scripts/gen-config.js` — where the webhook URLs + `REPLY_SECRET` come from (env).
