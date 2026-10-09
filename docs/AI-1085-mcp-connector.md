# AI-1085 — SendBlaster Claude connector (MCP)

A Claude project that can see what Cole sees, so his daily instructions run there instead of
through the OpenClaw agent on the VPS. Read-only. Nothing in it sends or edits.

## What was built

`api/mcp.js` — one Vercel function, no dependencies, speaking MCP over HTTP (Streamable HTTP,
JSON responses only). It wraps the same Supabase RPCs and tables the site reads.

| Tool | Answers | Reads |
|---|---|---|
| `list_queue` | what is queued / confirmed / sent / rejected, by status or state | `get_campaign_queue()` |
| `get_queue_row` | one row in full — the copy as it will be sent | `get_campaign_queue()` |
| `recommend_events` | what the decider would blast next, with reason codes | `rpc_event_recommendations()` |
| `list_offers` / `list_strategies` | strategy-generated offers and the strategy codes | `offers`, `offer_strategies` |
| `market_performance` | opens, clicks, unsubs, best template per market | `rpc_market_performance()` |
| `market_history` | the blast log the cooldown rule reads | `ticketblaster_market_blasts_log` |
| `send_status` | what left in the last N days, failures, what is waiting for the tick | `get_campaign_queue()` |
| `list_templates` | Cole's email/SMS templates | `message_templates` |
| `decider_rules` | cooldown, windows, allowlist, Cole's directives | `get_decider_rules()`, `campaign_directive_active()` |
| `inbox_demo_bookings` | demo-booking emails from Cole's Gmail (AI-1102) | `inbox_emails` |

Not exposed, on purpose: `queue_confirm`, `queue_set_*`, `queue_enqueue_test`, `/api/queue-tick`,
`/api/queue-draft`, CakeMail, the bulk sender, `do_not_contact`, contact lists. The connector
cannot send, cannot change a row, and never returns a recipient's email or phone.

## Auth

Shared secret `MCP_SECRET` (Vercel env), accepted as `Authorization: Bearer` or as `?key=` on
the URL. Fails closed when unset.

Why a URL key: claude.ai's *custom connector* dialog takes a URL and, optionally, OAuth client
credentials — it cannot set a header. The alternatives are a full OAuth 2.1 server (dynamic
client registration, PKCE, token endpoint — about two days) or a Supabase-auth bridge. For the
POC the key-in-URL is the right trade; rotating it is one env change. The key is never written
to the repo or `ui/config.js`.

## Connecting

**claude.ai project** (Cole's path): Settings → Connectors → *Add custom connector* →
URL `https://telnyx-inbox.vercel.app/api/mcp?key=<MCP_SECRET>` → add. Then enable it in the
project and paste Cole's daily instructions as the project's system prompt.

**Claude Code / API**: `claude mcp add --transport http sendblaster https://telnyx-inbox.vercel.app/api/mcp --header "Authorization: Bearer <MCP_SECRET>"`.

**Dev deployment** for testing: `https://telnyx-inbox-git-dev-mgimutao-3747s-projects.vercel.app/api/mcp`
(the key must be set on the Preview environment too).

## Cost comparison

| | OpenClaw today | Claude project |
|---|---|---|
| Runtime | VPS (always on) + gateway credits per turn | nothing — Vercel function, pennies |
| Model spend | per-token through the OpenClaw gateway | included in a Claude Team/Pro seat, or API per-token |
| A seat for Cole | — | Claude Pro $20/mo or Team $25–30/mo per seat |
| Ops | SSH, `openclaw cron`, device pairing, key rotation on the VPS | one env var |

Daily use is a handful of tool calls with small JSON results — on the API it would be well
under $5/month; on a seat it is covered. The credits the VPS burns today are the number to
put beside that; they are on the OpenClaw gateway dashboard, not in this repo.

## What it does not do yet (phase 2, if the POC holds)

1. **Edits without sends** — queue a market, set copy/sender/schedule, snooze. Each is an
   existing RPC with `log_run_edit`; exposing them is ~1 line per tool, but they want their own
   flag (`MCP_ALLOW_EDITS`) and `armed_by`-style attribution so a Claude edit is traceable.
2. **Unattended runs** — a project is interactive; "run this every morning" needs either the
   OpenClaw cron kept for that one job, or a Vercel cron calling the API with the same prompt.
3. **Proper OAuth** — if the connector outlives the POC, replace the URL key.

## Effort

Built in one session. Phase 2 edits: half a day. OAuth: two days.
