# Mailhook — the deliverability testing tool

_Last updated 2026-09-29._

> **NOT THE PRODUCTION REPLY PATH ANY MORE.** Production replies come back through Gmail
> plus-addressing and n8n — see **[email-replies.md](email-replies.md)**. Mailhook is kept for one
> job it is genuinely good at: proving a CakeMail campaign really lands, by sending a real one to a
> disposable inbox and reading back what arrived.
>
> **Why it was dropped as the reply path.** Webhooks are **Pro-only** (`POST /api/v1/webhooks` →
> `403 {"code":"pro_required"}` on free, $18/month), and Pro caps you at **10 email addresses**
> while the design needed one per blast. Plus-addressing has no cap, no cost, no API call in the
> send path, and needs no DNS change, because `callplaybook.com` already receives mail through
> Google Workspace. `api/email-reply.js` still accepts Mailhook's payload and HMAC, so this path
> keeps working if it is ever wanted again.

## The problem this solves

CakeMail cannot give us replies and never could. It is an **outbound** ESP: when a recipient
hits Reply, their mail client sends to the `From`/`Reply-To` header, which is a real mailbox
somewhere. CakeMail never sees that message, so there is no CakeMail endpoint to poll.

Until now no blast set a `Reply-To`, so every reply went to the CakeMail sender's own mailbox
(`josh.marcus@callplaybook.com` for the production sender). `email_replies` was created by
migration 079 and **stood empty from then until this was wired** — 0 rows, confirmed against the
live database on 2026-09-29.

Something has to own an address and hand us what arrives at it. That is Mailhook.

## The path

```
blast send (api/queue-tick.js)
  └─ lib/mailhook.js  mints ONE address per blast, metadata { queue_id, market_key, segment, provider }
       └─ CakeMail campaign goes out with reply_to_email = that address
            └─ recipient replies  →  Mailhook receives it
                 └─ POST /api/email-reply  (HMAC-signed)
                      └─ public.email_replies
                           └─ reply_inbox('email', …)  →  Replies tab
```

### How a reply knows which blast it belongs to

Not by parsing subject lines — those collide the moment two markets share one. Mailhook has no
plus-addressing, but **metadata attached when the address is created comes back on the inbound
webhook**. One address per blast carrying the queue row's id makes attribution exact and
parser-free. `data.metadata` is the whole mechanism.

## Operator setup

Replies will not appear until all four of these are done. Steps 1–3 are Vercel env vars
(Settings → Environment Variables → **Redeploy**); step 4 is in the Mailhook dashboard.

| # | Variable / action | Where to get it |
|---|---|---|
| 1 | `MAILHOOK_AGENT_ID` | app.mailhook.co → API keys |
| 2 | `MAILHOOK_API_KEY` | app.mailhook.co → API keys |
| 3 | `MAILHOOK_WEBHOOK_SECRET` | invent a long random string; paste the same value into Mailhook's webhook config |
| 4 | Point Mailhook's inbound webhook at `https://<app>/api/email-reply` | app.mailhook.co → webhook settings |

`MAILHOOK_DOMAIN_ID` is **optional** — see the domain note below.

### The API needs BOTH halves of the credential

`X-Agent-ID` **and** `X-API-Key` go on every request. An API key alone gets a **401 with an empty
body** — verified 2026-09-29, and indistinguishable from a revoked key, which makes this an easy
hour to lose. Registration returns the pair together:

```json
{ "agent_id": "mh_XXXXXXXXXXXXXXXXXXXXXXXX", "api_key": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }
```

Note the shapes, because they are **not** what you would guess: the agent id is the `mh_`-prefixed
value and the api key has **no prefix at all**. A dashboard-issued key of the form
`mh_live_…` is an **api key**, not an agent id — do not paste it into `MAILHOOK_AGENT_ID` because
it looks `mh_`-shaped. The agent id is displayed next to the key in app.mailhook.co → API keys.

### Two things that fail closed, on purpose

- **`/api/email-reply` returns 503 when `MAILHOOK_WEBHOOK_SECRET` is unset.** It refuses
  unauthenticated inbound mail rather than accepting anonymous writes into an inbox a human
  reads and acts on. Six cron routes in `api/` do take the "open when unset" shortcut; this one
  deliberately does not.
- **Signature is HMAC-SHA256 over the RAW body**, hex, header `X-Webhook-Signature`. The route
  turns Vercel's body parser off (`bodyParser: false`) because re-serialising a parsed object
  produces different bytes — different key order, different whitespace — and the HMAC would
  never match.

### The send path no longer calls this at all

`api/queue-tick.js` builds its `Reply-To` with `lib/reply-address.js` — string concatenation, no
network call. `lib/mailhook.js` is only reached by `scripts/mailhook-test.js` now.

`createReplyAddress()` still returns `null` rather than throwing, which is why the bug below was
survivable-but-invisible: a send using it could go out with no return address and say nothing.
Removing the call from the send path removed that failure mode entirely, which is a large part of
why plus-addressing won.

## Mailhook speaks JSON:API — the trap that cost a silent failure

Every response is `{ data: { id, type, attributes: {…} } }`, or an array of those. **The useful
fields live under `attributes`**:

```json
{ "data": { "id": "ea_113d2fb4dbb25d74", "type": "email_address",
            "attributes": { "email": "xpczyowox5@…tail.me", "metadata": { "queue_id": "…" } } } }
```

Reading `data.email` gives `undefined`. Because `lib/mailhook.js` fails soft, the first version of
this client surfaced that as a plain `null` and a blast sent **with no return address** — the exact
outcome the module exists to prevent. Three places read these payloads and all three assumed a flat
shape; the `flat()` helper in `lib/mailhook.js` and `scripts/mailhook-test.js` is the fix. Worth
knowing because it fails quietly rather than loudly.

Also: `domain_type` is nested the same way, so a naive domain lookup never finds the existing shared
domain and creates a new one every run. The free tier allows **3 domains**, so that wedges on the
fourth send.

## The domain trade-off

By default `lib/mailhook.js` finds or creates a Mailhook **shared** domain, so the return address
reads as a random string at Mailhook's own domain rather than at `callplaybook.com`. That is
visible to recipients and is the honest cost of having replies at all today.

A **custom** domain fixes the cosmetics and needs MX records on a **dedicated subdomain** —
for example `reply.callplaybook.com`. **Never the apex**, which would take company mail down with
it. Once that domain exists, set `MAILHOOK_DOMAIN_ID` and no code changes.

## What still will not appear in the tab

- **Replies to blasts sent before this was switched on.** They were answered into the sender's
  own mailbox and stay there. The Replies tab says so in its empty state rather than implying
  nobody answered.
- **Blasts sent through the n8n fallback** (`EMAIL_SEND_WEBHOOK_URL`, used only when a row has no
  CakeMail sender). That path posts `{from, to, subject, html}` and carries no reply-to, so it
  gets no return address. Production rows use the CakeMail path.
- **A reply with no metadata** — it still lands in the inbox and is readable, but it is
  unattributed. The endpoint flags that as `unattributed: true` in its response so it shows up
  in the logs.

## Testing it end to end

`scripts/mailhook-test.js` sends a **real** CakeMail campaign through the same `lib/cakemail.js`
the queue uses, from the production sender, to a disposable Mailhook inbox — then reads back what
arrived: sender, subject, HTML size, time to deliver, and whether a marker string survived. The
only fake thing is the recipient.

```bash
node scripts/mailhook-test.js
node scripts/mailhook-test.js --wait 180
node scripts/mailhook-test.js --address someone@example.com   # skip Mailhook, real inbox
```

It also prints the `From` address, which is the answer to "where have our replies been going" —
they have been going there this whole time.
