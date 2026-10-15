# HubSpot SMS: the bulk sender and SendBlaster

SendBlaster sends Telnyx SMS blasts through a separate app that Charles's team owns. Internally
it is called **the bulk sender**, or "HubSpot SMS". The repo is
[`marchsl/hubspot-telnyx-integration`](https://github.com/marchsl/hubspot-telnyx-integration),
checked out next to this repo at `../hubspot_telnyx_integration`. Read these pages before
touching `lib/bulk-sms.js` or the bulk branch of `api/queue-tick.js`.

| Page | What it covers |
|---|---|
| [bulk-sender.md](bulk-sender.md) | What the bulk sender is, what it replaced, how it runs (crons, queue, consent, HubSpot logging, receipts), and its rules |
| [sendblaster-integration.md](sendblaster-integration.md) | How SendBlaster uses it: the API contract, which rows go to it, auto-send and the 2,000 ceiling, cooldowns, settings, failure messages, and how to test safely |

## In one minute

- A SendBlaster Queue row whose SMS sender is **one of the bulk sender's 7 numbers** is handed to
  the bulk sender. The bulk sender matches each phone number to a HubSpot contact and texts only
  contacts with **`sms_opt_in = true`** that are not opted out, within quiet hours (8–21 in the
  recipient's local time). It logs every text into the HubSpot inbox thread.
- From SendBlaster **production**, a blast with **at most 2,000 eligible** people sends with
  **no approval step**. The first text goes out about 3 minutes later. A larger blast, or any call
  from a preview or laptop, lands as a **draft** that a person approves in the bulk sender's
  Operator App.
- A blast on **any other Telnyx number** fails with a clear message. It never goes to the n8n
  webhook, because that path has no opt-in check. Salesmsg and email are separate paths, and
  this integration does not change them.
- Shipped 2026-10-14: marchsl/hubspot-telnyx-integration#134 and Luiz-playbook/telnyx-inbox#4
  (ticket AI-965).

## Where else context lives

- The bulk sender's own `README.md` and `AGENTS.md`, and its specs under `docs/superpowers/specs/`.
  The SendBlaster ones are `2026-10-09-sendblaster-external-staging-design.md` and
  `2026-10-14-sendblaster-auto-send-design.md`.
- Charles's private notes in this repo are in `docs/custom-agents/`, which is excluded locally and never committed.
