# Telnyx Inbox — Backlog / To circle back

_Last updated: 2026-07-13_

Status legend: **BLOCKED** (waiting on a credential/decision) · **READY-TO-WIRE**
(built, needs an n8n import/activate) · **PARKED** (deferred by choice) ·
**HARDENING** (do before real/wider use) · **POLISH** (nice-to-have).

---

## 1. Number Line-Type Checker (mobile vs landline) — BLOCKED
**Built & deployed:** `/lookup` tab (spreadsheet upload → pick number column →
classify → export CSV), the `/api/lookup` serverless function, and the inline
**Classify** button in the Lists add-contacts flow.

**Blocker:** Telnyx Number Lookup is **owner-account only**. Our key is a
**managed (sub) account** key — confirmed: `/v2/balance` works, but
`/v2/managed_accounts` and `/v2/number_lookup` both return 403
(`10010 · "Only account owner can perform number lookup"`).

**Next action (operator):**
1. Get an API key from Playbook's **parent/owner** Telnyx account (whoever
   originally set up Telnyx / can see a "Managed Accounts" section).
2. Set it as **`TELNYX_API_KEY`** in Vercel → Settings → Environment Variables →
   Redeploy.
3. No code change needed — lookup can check any number on the owner key.
   (Decision: staying on Telnyx, not switching to Twilio.)

---

## 2. Login / Auth — BLOCKED (parked)
**Built:** Google sign-in page (`/login`), domain lock to `@callplaybook.com`.

**Blocker:** OAuth redirect bounces to the **Client Pulse / Teammate AI** app,
because our app shares their Supabase project (`snfmggrnyjayuuxafats`) and its
**Site URL** points at their app. Adding `https://telnyx-inbox.vercel.app/**` to
the Redirect URLs didn't stick (likely no admin rights on the shared project).

**Not done yet:** auth gate on each page, sign-out button, RLS lockdown.

**Options to unblock:**
- Get the redirect URL saved on the shared Supabase project's allowlist, **or**
- Move this app to its **own Supabase project** (ends all Client Pulse collisions;
  requires migrating our tables + re-pointing n8n — see item 8).

---

## 3. Bulk send workflow — READY-TO-WIRE
**Built:** `n8n/bulk-send-workflow.json` (webhook → auth → split → Telnyx send →
record outbound). App wired to `BULK_SEND_WEBHOOK_URL`.

**Next action (operator):**
1. Import + attach Telnyx + Supabase credentials + **Activate**.
2. **Make `from` dynamic:** the Send tab now sends `from` in the payload (so the
   number switcher picks the sender). Set the Telnyx node body to
   `{ "from": "={{ $json.from }}", "to": "={{ $json.to }}", "text": "={{ $json.text }}" }`
   (currently hardcoded `+16158050766`).
3. Test-send to your own number.

---

## 4. Sync numbers workflow — READY-TO-WIRE
**Built:** `n8n/sync-numbers-workflow.json` (hourly schedule + Refresh webhook →
Telnyx list numbers → upsert into `telnyx_numbers`). App wired to
`SYNC_NUMBERS_WEBHOOK_URL`; 🔄 Refresh button in Inbox + Send.

**Next action (operator):** import + activate. Then adding a number to the Telnyx
profile shows up in the switcher (hourly, or instantly via Refresh).

**Later:** v1 only adds/updates numbers — it does **not** deactivate numbers
removed from the profile.

---

## 5. Company AI generation (HubSpot deal → profile) — PARKED
**Issue:** the scraper writes to `hubspot_company_scrapes`, but the Companies tab
now reads `enriched_prospects`. Also the "Generate from deal" button was removed
when the tab was repointed.

**To finish:** point the scraper's final DB insert at `enriched_prospects`
(identical schema) and re-add the Generate button. (Note: `enriched_prospects` is
a busy table — use search/refresh to find the new company, not live auto-append.)

---

## 6. Manual company creation — PARKED
Removed when Companies switched to the read-only `enriched_prospects` viewer.
If wanted back, decide: write to `enriched_prospects` (source='manual') via a
secret-gated path, or keep the standalone `companies` table.

---

## 7. Inbox delivery-status ticks — PARKED
Outbound messages show a single faint ✓ (status `queued`). To light up ✓✓
(delivered), route Telnyx `message.finalized` webhooks to
`telnyx_update_status`. (RPC already exists; just needs the inbound workflow's
finalized branch wired.)

---

## 8. HARDENING — before real / wider use
- **Auth lockdown:** the site is **fully public** — anyone with the URL can read
  the inbox + ~22k `enriched_prospects` and trigger sends. Enforce login (item 2)
  and switch RLS from permissive `anon` to signed-in `@callplaybook.com` only.
- **10DLC:** real bulk A2P sending needs the number's brand/campaign **registered
  and approved**, or carriers filter/block it. (Testing to your own number ≠ proof.)
- **Shared secret in browser:** `REPLY_SECRET = "playbook"` is visible in the page;
  it only deters random traffic. Move sends behind real auth.
- **Dedicated Supabase project:** would end the Client Pulse Site-URL/auth
  collision and separate our data from unrelated production tables. Requires
  migrating `telnyx_*`, `message_templates`, `recipient_lists`, `telnyx_numbers`
  (+ functions) and re-pointing n8n; `enriched_prospects` stays where the scraper
  writes it (read cross-project).

---

## 9. POLISH — nice-to-have UI
- **Overview/home** with counts + "how it works" for first-time users.
- **Send history / log** (list, template, count, time, status) — sends are
  fire-and-forget today.
- **Companies detail:** a hero summary (name, tier, location, phone, top contacts)
  above the collapsible raw JSON.
- **Responsive** layout (fixed column widths today), real icons, better empty
  states, clearer active tab.
- **VoIP classification decision:** currently mobile = textable, landline = no,
  voip = "review". Decide whether voip counts as textable.

---

## Env vars / config quick reference (Vercel)
| Var | Purpose | Status |
|-----|---------|--------|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | DB access (anon) | set |
| `REPLY_SECRET` | shared secret for webhooks | set (`playbook`) |
| `BULK_SEND_WEBHOOK_URL` | bulk send n8n webhook | defaulted |
| `SYNC_NUMBERS_WEBHOOK_URL` | number sync n8n webhook | defaulted |
| `COMPANY_AI_WEBHOOK_URL` | HubSpot-deal scraper webhook | defaulted |
| `ALLOWED_EMAIL_DOMAIN` | login domain lock | `callplaybook.com` |
| `TELNYX_API_KEY` | **Number Lookup (owner key needed)** | **MISSING / blocked** |
