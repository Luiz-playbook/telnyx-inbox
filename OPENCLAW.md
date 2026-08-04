# OpenClaw Integration

How the Campaign Agent chat panel talks to a self-hosted OpenClaw agent, what the
agent can do, and how to operate it.

> **TL;DR** — The chat panel on the site is a thin front end over an OpenClaw AI
> agent running on our VPS. The browser → a Vercel function → a WebSocket to the
> gateway (device-authenticated) → the `main` agent. The agent can do everything
> the site can do to the campaign data, including **sending a specific queued blast
> when a user explicitly asks**; unattended/scheduled sending is still the cron's.
> Each chat is a separate agent session with its own persistent memory.

---

## ⚠ ACTION REQUIRED ON THE VPS (2026-08-04)

The app moved off the published anon key. **Two files on the VPS have to change**, and
one of them is already causing failures. Nothing in this repo can fix either — they
live on the box.

**1. `/api/*` calls — send `Authorization: Bearer <CRON_SECRET>`.**
**BROKEN AS OF NOW.** Every route used to accept `x-inbox-secret: <REPLY_SECRET>`, but
`REPLY_SECRET` is written into `ui/config.js` and served to every visitor, so it proved
nothing about the caller. `lib/auth.js` now takes either a real `CRON_SECRET` bearer or a
signed-in user's Supabase token. The agent has neither, so its `/api/queue-draft` calls
return **401** until the skill sends the bearer. Wherever the skill posts to `/api/`,
replace the `x-inbox-secret` header with `Authorization: Bearer <CRON_SECRET>` (same
value as the Vercel env var).

Exception: `/api/queue-tick` is unchanged — it still takes `x-send-secret: <SEND_SECRET>`
and has its own auth, described in that file.

**2. `~/.openclaw/supabase.env` — swap `SUPABASE_ANON_KEY` for the service-role key.**
Not broken yet, and it is the prerequisite for **migration 052**, which revokes `anon`'s
execute on all 43 of this app's RPCs. Apply 052 before this change and the agent loses
its entire capability set at once: `daily-campaign-queue`, `daily-price-refresh`, and
every queue edit it makes.

The agent gives up no safety by holding the service-role key. Its guardrails — cooldown,
the send allowlist, validation — live **inside the RPC bodies**, not in RLS, so they
apply to any caller. The api/ routes in this repo made the same move in `7c17ca8`.

Once both are done, tell whoever is running the migrations that 052 is unblocked.
Background: `migrations/052_auth_revoke_anon.sql` header, and §9 below.

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
  replay them filtered by runId.** A *mismatched* runId is never ours. A
  **missing** runId is ambiguous, and both simple rules fail: accepting it lets
  replayed history end the turn (`(no reply)`); rejecting it drops live frames
  the gateway didn't stamp and hangs the turn to the hard timeout. The
  discriminator is arrival time — history replay lands *before* the ack, so an
  unstamped event from the pre-ack buffer is history, an unstamped event arriving
  after the ack is ours.
- **Premature completion:** the parallel `agent` lifecycle `end` event fires
  *before* the last `chat` delta + the `chat` `final`. Finishing on it truncated
  replies. Fix: **finish only on the `chat` `final`**; ignore the `agent.*` stream
  (it just repeats the same text).

**Completeness beats latency.** A slow reply is fine; a truncated one that reads
as finished is not. Every fallback is sized accordingly: the quiet-timer is 45s
(it must clear the longest mid-turn tool pause, not merely a network hiccup) and
the per-turn hard timeout is 280s against a 300s `maxDuration`. Don't shrink
these to make the UI feel snappier — the only correct end-of-turn signal is the
`chat` `final`. When a turn ends on the quiet timer instead, the client logs
`turn ended on quiet timer … may be incomplete`; treat that line as a bug to
chase, not as normal operation.

The client also has fallbacks: the quiet-timer and socket-close both resolve
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
| `OPENCLAW_ALLOWED_ORIGIN` | Optional. Origin allowlist for `/api/agent-chat`. Never was real auth; since `1c22734` that route also runs `lib/auth.js`, which is. |
| `CRON_SECRET` | Server-to-server credential for `/api/*`. What the VPS must now send as `Authorization: Bearer …` — see the action block at the top. |

On the **VPS** (`~/.openclaw/`):

| File | Purpose |
|---|---|
| `openclaw.json` | Gateway + agent config (`gateway.auth.token`, model, etc.). |
| `identity/device.json` | The gateway's own device identity. |
| `devices/paired.json` | Approved devices + their scopes. |
| `supabase.env` | `SUPABASE_URL` + the key the agent uses for RPCs. Holds `SUPABASE_ANON_KEY` today; **must become the service-role key** before migration 052 — see the action block at the top. |
| `workspace/skills/campaign-queue/SKILL.md` | The campaign skill (see §6). |

> Actual secret values are **not** recorded here. They live in Vercel and on the
> VPS. Treat `OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_DEVICE_KEY` like passwords.

---

## 6. What the agent can and cannot do

The agent's reach is defined by the **`campaign-queue` skill**, which points it at
the **same Supabase RPCs the website uses**. So its capability set equals the site's —
and every guardrail already baked into those RPCs (cooldown, send-allowlist, validation)
applies automatically.

> **Key note.** The skill has always used the anon key, and the website no longer does:
> the browser now calls those RPCs as a signed-in user, and migration 052 revokes anon's
> execute entirely. The agent must move to the service-role key — see the action block at
> the top of this file. The guardrails above are unaffected, because they are enforced
> inside the functions rather than by RLS.

**Can (read + choose + edit):**
- Read the queue, events, markets, cooldowns, audience counts, send history.
- Choose what to blast: `rpc_event_recommendations`, `rpc_market_performance`.
- Edit rows: `queue_set_copy`, `queue_set_sender`, `queue_set_schedule`,
  `queue_set_channels`, `queue_snooze`, `queue_confirm`, `update_queue_row`.
- Stage test rows: `queue_enqueue_test` (placeholders; never auto-sent).
- Tune the decider/Cole rules: `get_decider_rules` / `set_decider_rules`.
- **Send one queued blast — only on an explicit user request.** `POST /api/queue-tick`
  with `{ "id": "<row>" }` (manual **Send now**), header `x-send-secret: SEND_SECRET`
  when out of test mode. Fires exactly that row, never a sweep. See §7 of
  `docs/OPENCLAW_QUEUE_RULES.md` for the rules (resolve to one row, relay
  `cooldown_overridden`/past-game, honour the allowlist).
- Every edit is logged via `log_run_edit`.

**Cannot (by design):**
- **Send on its own initiative.** No sweeping the queue (`POST {}` is refused without
  a secret), no sending a row nobody asked about, no send as a side effect of queueing.
  The scheduled cron owns all unattended delivery.
- **Mark things sent / write blast history by hand:** `queue_mark_sent`,
  `log_market_blast`, `upsert_salesmsg_broadcasts` — these are written by the send path
  (`api/queue-tick.js`) itself. Faking them corrupts the cooldown history that protects
  future blasts.

**The cron does the scheduled sending.** The agent's job is to get the right row, copy,
sender, channel, and date in place; the scheduled tick fires it — except when a user
asks the agent to send a specific row now.

### Queueing decision (the decider)

Choosing *which* markets/events get queued is a distinct procedure — spec in
`docs/OPENCLAW_QUEUE_RULES.md`, operationalized in the VPS `campaign-queueing`
skill: a SQL safety floor (`rpc_event_recommendations`, `decision='send'` only) →
additive top-up (never rewrite) → a per-day grid (`per_day` × `through`, one market
per window, ≤14-day window, ≤40 picks, self-healing `through` = today+3 default) →
Cole's durable **block/boost directives** (`campaign_directives` table +
`campaign_directive_active/add/revoke` RPCs, migration 041) → metric ranking. It
enqueues **placeholders** only.

Rows carry the **real** picked market, not the test market: while `send_allowlist` is
non-empty only the listed codes resolve recipients, so a real market in the queue
already reaches nobody, and retargeting the pick would only hide the decision. Queueing
writes **no** blast history — cooldown is earned by sending.

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

### Event schedule (the game list)

The agent can build/refresh `events_master` via the `campaign-events` skill — but
**only from official sources, never from memory** (an LLM once hallucinated games,
including 2027 ones). It runs the deterministic loader deployed on the VPS at
`~/.openclaw/tools/load-schedule.sh` (a copy of `scripts/load-schedule.js`):

```
sh ~/.openclaw/tools/load-schedule.sh --league <mlb|nhl|nfl|nba|ncaaf|ncaab> [--start … --end …] [--dry]
```

It fetches the official schedule (MLB StatsAPI, NHL api-web, NFL nflverse, ESPN for
the rest) and upserts idempotently via `upsert_events_master` (dedup + market
resolution). The skill requires a `--dry` preview first, and forbids hand-authoring
games — a human-named single game may be added only with real, confirmed details plus
an `external_id`/`source_url`. If you update `scripts/load-schedule.js`, re-copy it to
the VPS path above.

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
| "The agent took too long to respond." | Cold start / long turn exceeded the timeout — or reply events are being dropped by the runId filter, so nothing accumulates and the turn runs to the 240s hard timeout. | Retry (cold starts can be ~90s). If it repeats, check `vercel logs` for the `[agent-chat] … failed:` line and confirm reply frames are being attributed — see §4. |
| "The agent is unavailable right now." | Connect/socket error, bad device key, or the gateway is down. | Check the Funnel URL is reachable; check `OPENCLAW_DEVICE_KEY` decodes; check the gateway is running on the VPS. |
| Empty reply `(no reply)` | (Fixed.) A replayed-history `chat` `final` carrying **no** runId slipped past the runId filter and ended the turn before the real reply streamed. | The filter now fails closed — once our runId is known, an event counts as ours only if it says so; unstamped events are dropped (§4). Plus: never resolve on an empty `final`. If it recurs, confirm the fix is actually **deployed** — an uncommitted local change does nothing to the live agent. |
| Truncated reply | (Historical bug, fixed.) Finished on `agent` lifecycle `end`. | Finish only on `chat` `final` — see §4. |

**Manual end-to-end test (from a machine with the env vars set):**
```bash
node --input-type=module -e '
import { runAgentTurn } from "./lib/openclaw/gateway-client.js";
console.log(await runAgentTurn({ sessionKey:"blaster:test", text:"reply with: pong" }));
'
```
