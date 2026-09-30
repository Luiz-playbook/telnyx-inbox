# Email replies → the Replies tab

_Written for whoever operates the sender. Last updated 2026-09-30._

## ⚠️ The mailbox is READ-ONLY

`john@callplaybook.com` catches replies and **nothing may ever send from it**. Never send from
`josh@` / `josh.marcus@callplaybook.com` either — that is the CakeMail production sender and a real
person's working mailbox. The Gmail credential used below is for **reading only**: no Gmail send
node, no draft-send, no auto-reply, ever.

## The problem this solves

CakeMail cannot give us replies and never could. It is an **outbound** ESP: when a recipient hits
Reply, their mail client sends to the `Reply-To`/`From` header, which is a real mailbox somewhere.
CakeMail never sees the message, so there is no CakeMail endpoint to poll.

Until this shipped no blast set a `Reply-To`, so every reply went to the CakeMail sender's own
mailbox. `email_replies` was created by migration 079 and **stood empty from then until now** — 0
rows, confirmed against the live database.

## The path

```
blast send (api/queue-tick.js)
  └─ lib/reply-address.js builds  Reply-To: john+q<queue_id>@callplaybook.com   ← no API call
       └─ CakeMail campaign goes out carrying it
            └─ recipient replies  →  Gmail delivers to john@callplaybook.com
                 └─ n8n Gmail trigger (query: to:john+q) → requires the tag → POST /api/email-reply
                      └─ public.email_replies  →  reply_inbox('email','cakemail')  →  Replies tab
```

### Why plus-addressing rather than a vendor

Gmail delivers anything before the `+` to the base mailbox, so the blast id is simply written into
the address. That means **no API call in the send path** — nothing to rate-limit, no per-address
cap, no retention window, no vendor account, and no way for it to fail halfway through a blast.
The earlier vendor-minting design could return nothing while a campaign was going out and send it
with no return address at all.

Attribution is exact and needs no subject parsing. `market_key` and `segment` are **not** carried in
the address: they are columns on the queue row the id already identifies, and `api/email-reply.js`
looks them up. One source of truth rather than a copy that can disagree.

## Operator setup

The workflow is **already built and sitting in n8n, inactive**:
[vrqDhZprQ0TgwPdS](https://playbooksports.app.n8n.cloud/workflow/vrqDhZprQ0TgwPdS), in the project
*John Luiz Gonzaga <john@callplaybook.com>*. Committed copy: `n8n/email-reply-workflow.json`.

**No Gmail filter or label is needed.** An earlier design used one; the trigger's own Gmail query
(`to:john+q OR deliveredto:john+q`) narrows it server-side instead, and the code node enforces the
tag as a second guard. One less thing to configure and one less thing to misconfigure.

Two things left, both outside n8n's reach from here:

### 1. Vercel — set `EMAIL_REPLY_SECRET`

A long random string. Then **redeploy**. Nothing works until this exists: with neither
`EMAIL_REPLY_SECRET` nor `MAILHOOK_WEBHOOK_SECRET` set, the route returns 503 and refuses
everything rather than accepting anonymous writes into an inbox a human reads and acts on. That is
deliberately *not* the "open when unset" pattern the cron routes use.

Optionally `REPLY_MAILBOX` to move the catching mailbox (default `john@callplaybook.com`).

### 2. n8n — create the one credential, then activate

The `POST /api/email-reply` node needs a **Header Auth** credential named
*Telnyx Inbox x-reply-secret*, with two fields:

| Field | Value |
|---|---|
| Name | `x-reply-secret` |
| Value | the same string as `EMAIL_REPLY_SECRET` in Vercel |

Then **Activate** the workflow.

> Pick **Header Auth**, not "Custom Auth". They are different credential types
> (`httpHeaderAuth` vs `httpCustomAuth`) and only the first attaches to this node. Header Auth is
> also just a name/value pair — no JSON template to mistype.

> **The Gmail credential is already pointed at John's mailbox** (`My_Gmail`). Check it is really
> `john@callplaybook.com` before activating — n8n's credential auto-assignment twice attached a
> *different* colleague's Gmail account on its own, and the wrong one here would pull a third
> party's mail into the app. **It is READ ONLY: never add a Gmail send, reply or draft node.**

## What is verified, and what is not

Verified against the live database on 2026-09-29:

- plus-address round trip, including display-name wrapping and mixed case
- the tag found on `To`, `Delivered-To` or `Cc`
- a real queue row enriched to `market_key: baltimore`, `segment: SCP` from the id alone
- Gmail epoch-millis `internalDate` stored correctly, **not** as a year-56000 date
- nested `multipart/alternative` → `multipart/related` bodies decoded
- a personal email with no tag **dropped** by the workflow guard
- replay of the same Gmail message id reconciling instead of duplicating
- wrong shared secret → 401; Mailhook's HMAC path still working

**Not verified:** a real reply arriving through Gmail and n8n end to end. That needs the secret and
the n8n credential in place, plus one real send to reply to. In particular the exact shape n8n's
Gmail trigger emits is handled defensively rather than observed — `addrText()` in the code node
covers string, `{text}` and `{value:[{address}]}` forms because getting that wrong drops every
reply silently.

## What will not appear in the tab

- **Replies to blasts sent before this shipped** — they went to the sender's own mailbox and stay
  there. The tab's empty state says so rather than implying nobody answered.
- **Blasts sent through the n8n fallback** (`EMAIL_SEND_WEBHOOK_URL`, used only when a row has no
  CakeMail sender) — that path carries no `Reply-To`. Production rows use CakeMail.
- **A reply whose `+` was stripped by a relay.** Rare, and the trade is deliberate: the workflow
  requires the tag so a stranger's mail can never reach the app. Those replies still sit in Gmail.

## Testing deliverability

`scripts/mailhook-test.js` sends a **real** CakeMail campaign to a disposable inbox and reads back
what arrived. See [mailhook.md](mailhook.md) — Mailhook is kept as a *testing* tool only; it is no
longer in the production reply path.
