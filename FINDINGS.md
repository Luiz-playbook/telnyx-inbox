# Telnyx 2-Way Inbox (n8n) — Build Notes

## What was built
- **Supabase storage** (project *Playbook n8n* `snfmggrnyjayuuxafats`): tables
  `telnyx_conversations` + `telnyx_messages` with RLS + realtime, plus three atomic
  RPC functions (`telnyx_ingest_inbound`, `telnyx_record_outbound`,
  `telnyx_update_status`). **Applied to the live DB and tested** — upsert, insert,
  dedupe-on-retry, and outbound-record all verified with dummy data.
- **n8n inbound workflow** (`n8n/inbound-workflow.json`, importable): Webhook (fast 200
  ack + raw body) → Ed25519 verify Code node (`${timestamp}|${rawBody}`, 5-min replay
  guard) → IF `message.received` → RPC store; `message.finalized` → RPC status update.
  Not yet imported/activated (needs the Telnyx account + n8n UI).
- **n8n reply workflow** (`n8n/reply-workflow.json`, importable): secret-protected
  Webhook → validate → look up conversation → loop guard → Telnyx `POST /v2/messages`
  → RPC record outbound → respond. Not yet imported/activated.
- **Static inbox UI** (`ui/`): conversation list + thread + reply box, Supabase realtime,
  anon key. Data path verified against live Supabase (anon reads OK, anon writes 401).
  Host URL: TBD by operator.
- **Telnyx inbound webhook wired to n8n:** operator step (needs the Production URL after
  the workflow is activated).

## End-to-end test
- Inbound received + verified + stored + shown live: **not yet** — blocked on operator
  wiring (n8n credentials, activate, paste Production URL into Telnyx). The DB + UI read
  path and the exact Telnyx signature format are proven; the untested seam is the live
  n8n → Telnyx handshake.
- Reply sent + delivered + stored: **not yet** — same reason.

## Effort + verdict
- Actual effort: schema + functions + both workflow JSONs + UI + docs built and the
  data layer verified in one pass. Remaining is ~30–60 min of operator clicking in n8n +
  Telnyx (no more coding).
- Recommendation: **ship this 2-way inbox** — the plumbing is real, additive, and low-risk
  (dedicated prefixed tables on the n8n project, service-role writes, anon-read UI). Keep
  Salesmsg only until the operator completes the wiring + first live round-trip test.

## Decisions made this build
- **Storage:** Playbook n8n project (operator choice), not Production. Fits existing
  `telnyx_`-prefixed convention; no existing objects touched.
- **Auth:** none for now — testing spike with dummy numbers. UI is open; reply webhook is
  guarded by a shared secret. Cole-specific/team auth deferred (see README "Hardening").
- **Signature format corrected:** the skill notes said `timestamp + "." + rawBody`; Telnyx
  actually uses a **pipe** `` `${timestamp}|${rawBody}` ``. Verified via Telnyx docs and
  encoded in the Code node. (Worth fixing in the skill.)
- **RPC-based writes:** n8n calls one atomic Postgres function per event instead of
  chaining multiple Supabase nodes — simpler workflow, dedupe + upsert handled in SQL.

## Open items
- 10DLC / number registration status: unchanged — a new number won't A2P-send until its
  brand/campaign is approved (handled by `pb-telnyx-request-mngr`).
- Auth model for the UI + reply-webhook secret: shared secret in browser for the spike;
  move behind real auth before Cole uses it.
- Un-run verification: the live n8n → Telnyx → phone round trip (needs the Telnyx account).
- Nice-to-haves deferred: assignment/routing to Cole, search, read receipts, MMS rendering
  in the UI (media is stored, just not displayed yet).
```
