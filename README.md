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

> **Beyond the inbox:** this repo also holds the Ticket Blaster events + pricing pipeline
> (master schedule per league, market resolution, Gemini price refresh). See
> [`docs/events-pipeline.md`](docs/events-pipeline.md) for sources, cadence, and open items.

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

That serves the static bundle only. To run the API routes too — and to sign in — use the
dev server, **on port 3005**:

```bash
node --env-file=.env scripts/gen-config.js   # writes ui/config.js from .env (git-ignored)
PORT=3005 node --env-file=.env scripts/dev-server.js
```

### The port is not arbitrary — use 3005

Google sign-in round-trips through Supabase, which only honours a `redirectTo` that is on its
allow-list. An unlisted one is **silently replaced by the project Site URL** — no error, no
warning, you just land on whatever happens to be running there. Site URL is
`http://localhost:3000`, which on a typical machine here is a different Next.js project. So a
login started on any other port finishes in the wrong app, and it reads as this one being
broken rather than as a redirect problem.

`ui/login.html` does the right thing (`redirectTo: location.origin + '/login'`) — the
substitution happens on Supabase's side, at the callback, which is why the port has to match
the allow-list rather than just being consistent.

3005 is on the allow-list. To use a different port, add `http://localhost:<port>/login` under
Authentication → URL Configuration → Redirect URLs first:

<https://supabase.com/dashboard/project/snfmggrnyjayuuxafats/auth/url-configuration>

`PORT` is the only knob — `scripts/dev-server.js` reads it and defaults to 3000, which is the
wrong default for exactly the reason above.

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

# AI-896 — Reusable spam and template quality check via Mailpit + SpamAssassin
# Run instructions

## How to spam-check a blast template

Anyone on the team can run this. Takes about five minutes. You need SSH access
to the harness box — ask JL. This repo is public, so the host address is
written as `<harness-host>` below; substitute the real one.

### 1. Connect and open the UI

Two terminal windows. First one, for running commands:

```bash
ssh root@<harness-host>
```

Second one, for the web UI. The Mailpit UI is deliberately bound to localhost
on the server, so it is not reachable directly — tunnel to it:

```bash
ssh -L 8025:localhost:8025 root@<harness-host>
```

Leave that window open and browse to **http://localhost:8025**.

### 2. Get the message into Mailpit

**Which message you test matters more than anything else here.** Production
blasts go out through Cakemail, which adds an HTML part, an unsubscribe link
and a physical address footer. Scoring the raw template tells you about the
copy; it does not tell you what recipients receive. Prefer Option A.

#### Option A — score a real Cakemail send (recommended)

1. Send a Cakemail test campaign to yourself.
2. In Gmail, open it → three-dot menu → **Show original** → **Download
   Original**. That gives you a `.eml` with every header intact.
3. From a local terminal (not an SSH session), copy it up:

   ```bash
   scp "C:\path\to\your message.eml" root@<harness-host>:/root/campaign.eml
   ```

4. On the server, replay it into Mailpit:

   ```bash
   python3 -c "
   import smtplib
   raw = open('/root/campaign.eml','rb').read()
   s = smtplib.SMTP('localhost', 1025)
   s.sendmail('test@example.test', ['spamcheck@example.test'], raw)
   print('sent')
   "
   ```

   The envelope recipient satisfies the allowlist while the original headers
   stay untouched.

#### Option B — score raw template copy

Only for checking wording before it goes into Cakemail. On the server, run
`nano /root/send_template.py` and paste:

```python
import smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

BODY = """paste the template copy here"""

m = EmailMessage()
m['From'] = 'Sender Name <sender@callplaybook.com>'
m['To'] = 'spamcheck@example.test'
m['Subject'] = 'the real subject line'
m.set_content(BODY)

# Required. Without these you pick up ~3 points of penalties that are
# artifacts of this script, not of the template.
m['Date'] = formatdate(localtime=True)
m['Message-ID'] = make_msgid(domain='callplaybook.com')

smtplib.SMTP('localhost', 1025).send_message(m)
print('sent')
```

Save with `Ctrl+O`, Enter, then `Ctrl+X`. Run it:

```bash
python3 /root/send_template.py
```

Use the real From address and subject — both feed scoring rules.

### 3. Read the results

Refresh http://localhost:8025, open the newest message, and work through the
tabs:

| Tab | Record |
|---|---|
| **Spam Analysis** | The total, and every rule name with its points. The rule list is the actionable part — a bare total tells nobody what to fix. |
| **HTML Check** | The support percentage and each warning, with the affected clients. |
| **Link Check** | Any link or image that fails to resolve. |
| **Headers** | Whether `List-Unsubscribe` is present. |

**Pass threshold: 3.0.** Below that, ship it. Above, look at which rules fired
before sending.

### Gotchas

- **Recipients must match `@example\.test$`** or Mailpit rejects the message
  and it looks like the harness is broken. Use `spamcheck@example.test`.
- **A near-empty test body will trigger `HTML_IMAGE_ONLY_08`** on an image
  ratio that a real campaign would not have. Test with realistic copy.
- **`ALL_TRUSTED` (-1) is a harness artifact**, not something a real send gets.
  Read scores as roughly a point optimistic where it appears.
- **Do not use "Delete all"** — the mailbox is shared with the AI-895 volume
  test data.
- **`MISSING_DATE` / `MSGID_FROM_MTA_HEADER`** mean you skipped the `Date` and
  `Message-ID` lines in Option B. Fix the script, not the template.
