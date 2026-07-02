# Telnyx 2-Way SMS Inbox (n8n route)

A working inbox on top of a Telnyx number: inbound texts land in Supabase and show
up **live** in a web page; replies go back out through Telnyx. No server to run —
n8n does the receiving/sending, the UI is a static page.

```
Person's phone ──► Telnyx ──► n8n INBOUND (verify + store) ──► Supabase ──► UI (live)
Person's phone ◄── Telnyx ◄── n8n REPLY (send + store)     ◄── UI (reply box)
```

## What's in this repo

| Path | What it is |
|------|-----------|
| `migrations/001_telnyx_inbox.sql` | Tables `telnyx_conversations` + `telnyx_messages`, RLS, realtime. **Already applied** to the *Playbook n8n* Supabase project. |
| `migrations/002_telnyx_inbox_functions.sql` | Atomic RPC functions n8n calls (`telnyx_ingest_inbound`, `telnyx_record_outbound`, `telnyx_update_status`). **Already applied.** |
| `n8n/inbound-workflow.json` | Import into n8n → receives + verifies + stores inbound texts. |
| `n8n/reply-workflow.json` | Import into n8n → sends + stores replies (secret-protected). |
| `ui/index.html`, `ui/config.js` | Static inbox page (conversation list, thread, reply box, realtime). |

**Storage target:** Supabase project **Playbook n8n** (`snfmggrnyjayuuxafats`). The two
tables are `telnyx_`-prefixed and additive — nothing else in that project was touched.

## Status: what's done vs. what the operator must do

**Done (verified against the live database):**
- ✅ Schema + RPC functions applied; upsert / insert / dedupe / outbound tested with dummy data.
- ✅ anon key **reads** both tables; anon key **writes are blocked** (401) by RLS.
- ✅ Confirmed Telnyx signature format is `` `${timestamp}|${rawBody}` `` (pipe), Ed25519, 5-min replay window — the verify Code node uses exactly this.

**Operator to-do (needs the Telnyx account + n8n UI — can't be done from code):**
1. **n8n credentials** (Settings → Credentials):
   - **Supabase API** — host `https://snfmggrnyjayuuxafats.supabase.co`, key = the **service_role** key (Supabase → Project Settings → API). This is god-mode; it stays in n8n only.
   - **Telnyx API** — the v2 API key (Bearer).
2. **Import both workflows** (`n8n/*.json`). In each, open the nodes that say `REPLACE_WITH_..._CREDENTIAL_ID` and pick the credentials from step 1.
3. **Fill the two Config nodes:**
   - Inbound → `telnyx_public_key` = the messaging profile's **public key** (Telnyx portal → the messaging profile / Keys & Credentials). Not secret, but required.
   - Reply → `reply_secret` = any long random string; `messaging_profile_id` optional.
4. **Activate both workflows.** Copy each Webhook node's **Production URL** (not the Test URL — test URLs die when the editor closes and you'll silently lose texts).
5. **Telnyx portal → Messaging → Programmable Messaging → your messaging profile → Inbound:** paste the **inbound** Production URL. (Optional: set a Failover URL.)
6. **UI config** (`ui/config.js`): set `REPLY_WEBHOOK_URL` = the **reply** Production URL and `REPLY_SECRET` = the same string as step 3. (Supabase URL + anon key are already filled in.)
7. **Host the UI** as a static site (Vercel / Netlify / Supabase Storage) — or preview locally, below.

## Preview the UI locally (10 seconds)

```bash
cd ui
npx serve .        # or:  python -m http.server 8080
# open the printed URL
```

There's one dummy conversation seeded in the DB so the list isn't empty on first open;
delete it whenever (`delete from telnyx_conversations where contact_number='+15557774444';`).

## End-to-end test (Phase 5)

1. Text the Telnyx number from your phone.
2. Check: signature verified (n8n execution is green), a conversation + inbound message
   appear in Supabase, and the message shows up **live** in the UI.
3. Reply from the UI → your phone receives it; an `outbound` row appears with a status.
4. Screenshot the round trip — that's the proof.

## Hardening before this goes to a real user (Cole)

This build is a **testing spike** (dummy numbers, no login). Before real use:
- **Auth-gate the UI** (Supabase Auth / SSO) and replace the permissive anon read
  policies in `001_...sql` with owner/team-scoped policies (`assigned_to = auth.uid()` etc.).
- The **reply secret currently sits in `config.js`** (browser) — it only deters random
  traffic, not someone who views source. Once the UI is authed, move the send behind the
  user's session instead of a shared secret.
- **10DLC**: a new Telnyx number won't send A2P until its brand/campaign is registered and
  approved (that's what the `pb-telnyx-request-mngr` project handles).

## Secrets — where each one lives

| Secret | Home | Never in |
|--------|------|----------|
| Telnyx API key | n8n credential (Telnyx API) | node literals, UI, git |
| Supabase **service_role** key | n8n credential (Supabase API) | the browser, ever |
| Supabase **anon** key | `ui/config.js` (safe — RLS governs it) | — |
| Telnyx public key | inbound Config node (public by nature) | — |
| Reply shared secret | reply Config node + `ui/config.js` (spike only) | git if you fork this public |
