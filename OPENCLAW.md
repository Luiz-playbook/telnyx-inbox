# OpenClaw Integration

How the Campaign Agent chat panel talks to a self-hosted OpenClaw agent, what the
agent can do, and how to operate it.

> **TL;DR** — The chat panel on the site is a thin front end over an OpenClaw AI
> agent running on our VPS. The browser → a Vercel function → a WebSocket to the
> gateway (device-authenticated) → the `main` agent. The agent can do everything
> the site can do to the campaign data **except send** — the cron still owns
> sending. Each chat is a separate agent session with its own persistent memory.

---

## Contents
1. [Architecture](#1-architecture)
2. [Components](#2-components)
3. [Auth model (device pairing)](#3-auth-model-device-pairing)
4. [The request/reply protocol](#4-the-requestreply-protocol)
5. [Environment variables](#5-environment-variables)
6. [What the agent can and cannot do](#6-what-the-agent-can-and-cannot-do)
7. [Chats, sessions & memory](#7-chats-sessions--memory)
8. [Operating the gateway (SSH)](#8-operating-the-gateway-ssh)
9. [Security posture & follow-ups](#9-security-posture--follow-ups)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Architecture

```
Browser (ui/index.html)
  │  POST /api/agent-chat  { message, sessionKey }
  ▼
Vercel function (api/agent-chat.js)
  │  runAgentTurn({ sessionKey, text })
  ▼
lib/openclaw/gateway-client.js  ── wss:// (Tailscale Funnel) ──►  OpenClaw Gateway
                                                                   (VPS, 127.0.0.1:18789)
                                                                        │
                                                                        ▼
                                                                  `main` agent
                                                                   ├─ persistent memory / workspace
                                                                   └─ campaign-queue skill
                                                                        │  Supabase RPCs (anon key)
                                                                        ▼
                                                                   Marketing Blaster data
                                                                   (project snfmggrnyjayuuxafats)
```

- The gateway is **bound to loopback** on the VPS and never exposed directly.
  **Tailscale Funnel** publishes it at `wss://<host>.ts.net/` (the value of
  `OPENCLAW_GATEWAY_URL`). Port 18789 stays closed to the internet.
- The Vercel function is the only thing that holds the write credential; the
  browser never sees it.

---

## 2. Components

| Piece | Path / location | Role |
|---|---|---|
| Chat panel | `ui/index.html` (Campaign Agent rail) | Multi-chat UI; posts to `/api/agent-chat`; stores history in `localStorage`. |
| Serverless bridge | `api/agent-chat.js` | `POST { message, sessionKey } → { reply, runId }`. Buffered (waits for the full turn). Interim origin gate. `maxDuration: 300`. |
| Gateway client | `lib/openclaw/gateway-client.js` | Node WebSocket client. Device-signed connect → `chat.send` → collects the streamed reply. No npm deps (Node ≥22 global `WebSocket` + `node:crypto`). |
| Gateway | VPS, OpenClaw `2026.7.x`, `127.0.0.1:18789` | Runs the agent loop; exposed via Tailscale Funnel. |
| Agent | OpenClaw agent id `main` | The brain. Model configured on the VPS (currently an OpenAI model). |
| Agent skill | VPS `~/.openclaw/workspace/skills/campaign-queue/SKILL.md` | Teaches `main` the campaign RPCs + guardrails. **Not in this repo** (lives in the agent's workspace). |

---

## 3. Auth model (device pairing)

The gateway grades every connection:

- **Loopback** (a process on the VPS, e.g. the `openclaw` CLI) → fully trusted →
  `operator.write`.
- **Remote** (our Vercel function via Funnel) → with just the shared gateway
  token it only earns `operator.read`. `chat.send` requires **`operator.write`**.

Write is granted **per approved device**. So our client presents a stable
**Ed25519 device identity** and signs the connect challenge exactly the way
OpenClaw's own control UI does. The device was approved once on the gateway with
`operator.read` + `operator.write`.

Key facts (from OpenClaw's `device-identity` module — we replicate it):

- `deviceId = sha256(raw 32-byte ed25519 public key).hex`
- `publicKey` on the wire = base64url of the raw public key
- **Signature payload (canonical string):**
  ```
  v2|<deviceId>|<clientId>|<clientMode>|<role>|<scopes csv>|<signedAtMs>|<token>|<nonce>
  ```
  signed with the PKCS8 Ed25519 private key, encoded **base64url**.
- `nonce` comes from the `connect.challenge` event the gateway sends first.
- Connect params:
  ```json
  { "minProtocol":4, "maxProtocol":4, "client":{"id":"cli","mode":"cli", ...},
    "role":"operator", "scopes":["operator.read","operator.write"],
    "device":{ "id":"<deviceId>", "publicKey":"<b64url>", "signature":"<b64url>",
               "signedAt":<ms>, "nonce":"<nonce>" },
    "caps":["tool-events"], "auth":{ "token":"<gateway token>" } }
  ```

The private key lives **only** in the `OPENCLAW_DEVICE_KEY` env var (base64 of the
PEM). The public key + deviceId are derived from it at runtime — nothing else to
store. Losing/rotating the key means re-pairing (see §8).

---

## 4. The request/reply protocol

WebSocket v4, JSON frames. One `runAgentTurn` call = one fresh socket = one turn.

1. Socket opens → gateway sends `event: connect.challenge` with a `nonce`.
2. Client sends `req connect` (device-signed, see §3) → gateway replies `hello-ok`
   with the granted scopes and available methods.
3. Client sends `req chat.send`:
   ```json
   { "sessionKey":"agent:<agentId>:<name>", "agentId":"main",
     "message":"<user text>", "idempotencyKey":"<uuid>" }
   ```
   `sessionKey` **must** encode the agentId (`agent:main:<name>`) or it's rejected.
   Ack: `{ "runId":"<uuid>", "status":"started" }`.
4. The reply streams as `event: chat` frames for that `runId`:
   - `state:"delta"` → `deltaText` (increment) **and** a cumulative `message`
     snapshot.
   - `state:"final"` → the complete `message.content[].text` + `stopReason`.

### Two subtleties the client handles (learned the hard way)

- **History replay:** on connect the gateway replays the session's recent history
  — including old `chat` `final` events with **different** runIds — *before* the
  new run streams. So we filter reply events by **our** `runId`. But the server's
  runId is only known from the `chat.send` ack, which under real latency can land
  *after* the first reply events. Fix: **buffer reply events until the ack, then
  replay them filtered by runId.**
- **Premature completion:** the parallel `agent` lifecycle `end` event fires
  *before* the last `chat` delta + the `chat` `final`. Finishing on it truncated
  replies. Fix: **finish only on the `chat` `final`**; ignore the `agent.*` stream
  (it just repeats the same text).

The client also has fallbacks: an 8s quiet-timer and socket-close both resolve
with whatever text accumulated, and a hard `timeoutMs`.

---

## 5. Environment variables

Set on **Vercel** (server-side; a change requires a redeploy to take effect):

| Var | Purpose |
|---|---|
| `OPENCLAW_GATEWAY_URL` | `wss://<host>.ts.net/` — the Tailscale Funnel URL. |
| `OPENCLAW_GATEWAY_TOKEN` | Shared gateway token (authenticates the connection). |
| `OPENCLAW_DEVICE_KEY` | **base64 of the approved device's PKCS8 Ed25519 private-key PEM.** The write credential. Never in the browser bundle. |
| `OPENCLAW_AGENT_ID` | Agent to talk to. Default `main`. |
| `OPENCLAW_ALLOWED_ORIGIN` | Optional. Interim origin allowlist for `/api/agent-chat` (**not** real auth). |

On the **VPS** (`~/.openclaw/`):

| File | Purpose |
|---|---|
| `openclaw.json` | Gateway + agent config (`gateway.auth.token`, model, etc.). |
| `identity/device.json` | The gateway's own device identity. |
| `devices/paired.json` | Approved devices + their scopes. |
| `supabase.env` | `SUPABASE_URL` + `SUPABASE_ANON_KEY` the agent uses for RPCs. |
| `workspace/skills/campaign-queue/SKILL.md` | The campaign skill (see §6). |

> Actual secret values are **not** recorded here. They live in Vercel and on the
> VPS. Treat `OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_DEVICE_KEY` like passwords.

---

## 6. What the agent can and cannot do

The agent's reach is defined by the **`campaign-queue` skill**, which points it at
the **same Supabase RPCs the website uses** (same anon key). So its capability set
equals the site's — and every guardrail already baked into those RPCs (cooldown,
send-allowlist, validation) applies automatically.

**Can (read + choose + edit):**
- Read the queue, events, markets, cooldowns, audience counts, send history.
- Choose what to blast: `rpc_event_recommendations`, `rpc_market_performance`.
- Edit rows: `queue_set_copy`, `queue_set_sender`, `queue_set_schedule`,
  `queue_set_channels`, `queue_snooze`, `queue_confirm`, `update_queue_row`.
- Stage test rows: `queue_enqueue_test` (placeholders; never auto-sent).
- Tune the decider/Cole rules: `get_decider_rules` / `set_decider_rules`.
- Every edit is logged via `log_run_edit`.

**Cannot (by design):**
- **Send anything.** No `/api/queue-tick`, no CakeMail route, no n8n webhooks.
- **Mark things sent / write blast history:** `queue_mark_sent`,
  `log_market_blast`, `upsert_salesmsg_broadcasts` — these are owned by the cron.
  Faking them corrupts the cooldown history that protects future blasts.

**The cron does the sending.** The agent's job is to get the right row, copy,
sender, channel, and date in place; the scheduled tick fires it.

### Queueing decision (the decider)

Choosing *which* markets/events get queued is a distinct procedure — spec in
`docs/OPENCLAW_QUEUE_RULES.md`, operationalized in the VPS `campaign-queueing`
skill: a SQL safety floor (`rpc_event_recommendations`, `decision='send'` only) →
additive top-up (never rewrite) → a per-day grid (`per_day` × `through`, one market
per window, ≤14-day window, ≤40 picks, self-healing `through` = today+3 default) →
Cole's durable **block/boost directives** (`campaign_directives` table +
`campaign_directive_active/add/revoke` RPCs, migration 041) → metric ranking. It
enqueues **placeholders** only.

A daily gateway cron job **`daily-campaign-queue`** (8am ET, session
`agent:main:scheduler`) runs it unattended with the defaults; a human still confirms
each row before the send cron fires. Manage it on the VPS with
`openclaw cron list|get|run|disable daily-campaign-queue`.

### Ticket pricing (the decider's price input)

The agent also keeps `events_master.best_price` current, via the VPS
`campaign-pricing` skill: `price_targets()` (migration 042) returns the games that
need a price — decider-eligible, inside the price window, stale or never priced —
each with a **precomputed `listing_url`** (SeatGeek team page). The agent web-searches
the get-in price (single seat, listed-before-fees, USD, ignore `<=0` or `>250`) and
writes with `set_event_prices(p_rows)`, then logs with `record_price_run(p)`.

**AI‑845 rule:** the price lookup must never fetch or invent a URL — asking a model
for a link alongside the price wrecked accuracy. The `listing_url` is built in SQL and
passed straight through.

A daily gateway cron **`daily-price-refresh`** (7am ET, before the queue run) does
this unattended. It never sends.

> **Overlap to resolve:** the old Vercel crons `/api/price-refresh` (Gemini, every
> 12h) and `/api/decide` (gpt-4o re-rank, daily) now duplicate the agent's pricing and
> queueing. `/api/queue-tick` (hourly) is the **sender** and must stay. Retire the
> first two (remove from `vercel.json` crons) once the agent runs are trusted, to stop
> double work + Gemini spend.

To change what the agent can do, edit the `SKILL.md` on the VPS (§8). Introspect
the live RPC surface with:
```sql
select p.proname, pg_get_function_arguments(p.oid)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute');
```

---

## 7. Chats, sessions & memory

- Each **chat** in the panel is a separate OpenClaw **session**. The panel sends
  `sessionKey = "blaster:<chatId>"`; the client rewrites it to
  `agent:main:blaster-<chatId>`. Distinct sessionKey → **distinct persistent
  memory** on the agent, so chats don't bleed into each other.
- The panel stores the chat list + messages in `localStorage` (`blaster_chats_v1`)
  so history renders instantly on reload. This is **per-browser**, not synced
  across devices. Deleting a chat removes it locally; the agent's server-side
  memory for that session persists until cleared on the VPS.
- The previous single session migrates into "Chat 1" (its `blaster_session_id`
  becomes the chat id), preserving the agent's server-side memory of it.

---

## 8. Operating the gateway (SSH)

Access is via SSH to the VPS with an authorized key (host/credentials held by the
team, not in this repo).

**List / approve / manage devices:**
```bash
openclaw devices list [--json]
openclaw devices approve --latest          # or: approve <requestId>
openclaw devices rotate --device <id> --role operator --scope operator.read operator.write
openclaw devices remove <deviceId>
```
A new remote device first appears under `pending`; approve it once, and it's
granted its requested scopes.

**Re-pair a fresh device (e.g. after rotating `OPENCLAW_DEVICE_KEY`):**
1. Generate an Ed25519 keypair; derive `deviceId = sha256(raw pubkey)`.
2. Set `OPENCLAW_DEVICE_KEY` in Vercel = base64 of the PKCS8 PEM; redeploy.
3. Send one message from the panel → the connect creates a pending pairing.
4. `openclaw devices approve --latest` on the VPS.
5. Retry — it now has write.

**Edit the agent's capabilities:** edit
`~/.openclaw/workspace/skills/campaign-queue/SKILL.md`. The agent re-reads it on
the next turn — no restart needed. Keep a timestamped `.bak` before large edits.

**Change the model / gateway config:** `~/.openclaw/openclaw.json`
(`agents.defaults.model`, `gateway.*`). Config writes are audited in
`~/.openclaw/logs/config-audit.jsonl`.

---

## 9. Security posture & follow-ups

Known gaps to close (flagged in code headers too):

1. **`/api/agent-chat` is gated only by an origin check — not real auth.** Anyone
   who reaches the endpoint can drive the agent. Add per-user session auth so
   `sessionKey` maps to a real identity.
2. **The web panel drives the shared `main` agent**, which has a shell and shares
   memory with the operator's own use. The agent can't *send*, but it can *edit*
   the queue/copy/rules. A dedicated web agent (separate from `main`) would
   contain the blast radius.
3. **Rotate any secret that has been pasted into a chat/transcript** —
   `OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_DEVICE_KEY` especially. Rotating the
   device key = re-pair (§8); rotating the token = update `gateway.auth.token` on
   the VPS and `OPENCLAW_GATEWAY_TOKEN` in Vercel, then redeploy.
4. **Gateway hardening:** set `allowedOrigins` / `trustedProxies` and disable the
   `controlUi.allowInsecureAuth` / `dangerouslyAllowHostHeaderOriginFallback`
   flags once the above is in place.

---

## 10. Troubleshooting

| Symptom (panel says…) | Cause | Fix |
|---|---|---|
| "Agent is not configured yet." | An `OPENCLAW_*` env var is missing at runtime. | Check the vars are set in Vercel **and** that a redeploy happened after setting them. |
| "This device is awaiting one-time approval…" | The device isn't approved (or the key changed). | `openclaw devices approve --latest` on the VPS (§8). |
| "The agent took too long to respond." | Cold start / long turn exceeded the timeout. | Retry; cold starts can be ~90s. |
| "The agent is unavailable right now." | Connect/socket error, bad device key, or the gateway is down. | Check the Funnel URL is reachable; check `OPENCLAW_DEVICE_KEY` decodes; check the gateway is running on the VPS. |
| Empty reply `(no reply)` | (Historical bug, fixed.) Reply-event/runId race. | Ensure `lib/openclaw/gateway-client.js` buffers events until the ack — see §4. |
| Truncated reply | (Historical bug, fixed.) Finished on `agent` lifecycle `end`. | Finish only on `chat` `final` — see §4. |

**Manual end-to-end test (from a machine with the env vars set):**
```bash
node --input-type=module -e '
import { runAgentTurn } from "./lib/openclaw/gateway-client.js";
console.log(await runAgentTurn({ sessionKey:"blaster:test", text:"reply with: pong" }));
'
```
