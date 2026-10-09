# AI-896 — Reusable spam and template quality check via Mailpit + SpamAssassin

Two parts below. **Part 1** is the ticket comment. **Part 2** is the run
instructions for Confluence / the repo README.

---

# Part 1 — Ticket comment

## Step 1 — SpamAssassin enabled and verified

**Decision: self-hosted.** SpamAssassin runs as a sidecar container alongside
Mailpit on the AI-895 harness box. The hosted Postmark option was not used —
it posts the complete message to a third party on every check, and our blast
templates carry client and facility names. Self-hosted was near-zero extra
cost here (one additional container on the same VPS, message never leaves the
box), so there was no reason to take that trade.

Setup as built, on the AI-895 Contabo host (address from JL — written as
`<harness-host>` throughout, since this repo is public):

| | |
|---|---|
| Mailpit container | `mailpit`, image `axllent/mailpit` |
| SpamAssassin container | `spamassassin`, image `axllent/spamassassin`, port 783, not published |
| Wiring | `MP_ENABLE_SPAMASSASSIN=spamassassin:783`, both on the same Docker network |
| Web UI | 8025 bound to `127.0.0.1` — not publicly reachable, SSH tunnel required |
| SMTP | 1025 |
| Recipient allowlist | `@example\.test$` |

Verified three ways: env var present on the running container, Mailpit can
reach `spamassassin:783`, and a GTUBE test message scored as expected.
Scoring is live and returning both totals and rule names.

## Step 2 — Baseline scores

Three runs. The third is the one that matters.

### Run A — raw template, minimal headers (2.1)

| Score | Rule | Description |
|---|---|---|
| 2.7 | MISSING_DATE | Missing Date: header |
| -1 | ALL_TRUSTED | Passed through trusted hosts only via SMTP |
| 0.4 | MSGID_FROM_MTA_HEADER | Message-Id was added by a relay |

**Not a template finding.** Both penalties came from the test script omitting
`Date` and `Message-ID`, which any real sending platform sets. Recorded
because it is a trap for the next person — 3.1 points of noise that looks like
a template problem. The run instructions below cover it.

### Run B — raw template, headers corrected (-1.0)

| Score | Rule | Description |
|---|---|---|
| -1 | ALL_TRUSTED | Passed through trusted hosts only via SMTP |

**No content rules fired at all.** The outreach copy triggers nothing — no
sales-language, gift-offer or first-contact rules. Cleaner than expected for
cold outreach.

### Run C — actual Cakemail send (0.6) ← use this as the baseline

Production sends go out through **Cakemail**, which injects a physical address
footer, an unsubscribe link and an HTML part. Runs A and B scored the raw
template, which is not what recipients receive. To score the real artifact, a
Cakemail test message was exported from Gmail (Show original → Download
Original) and replayed into Mailpit with headers intact.

| Score | Rule | Description |
|---|---|---|
| 0 | HTML_MESSAGE | BODY: HTML included in message |
| 0.6 | HTML_IMAGE_ONLY_08 | BODY: HTML: images with 400-800 bytes of words |

Two notes on reading this:

- `HTML_IMAGE_ONLY_08` fires on image-to-text ratio. The test message body was
  one line ("This is a test only, please ignore"), so the ratio is an artifact
  of the test, not the template. A real campaign with full copy would likely
  not trigger it. **Not worth chasing.**
- No `ALL_TRUSTED` on this run — the .eml carries Cakemail's original Received
  headers — so 0.6 is a closer approximation of a production score than the
  -1.0 above.

**Baseline recorded: 0.6 / 5, not spam, no actionable rules.**

## Step 3 — HTML and link checks

Applicable to the Cakemail send only. The raw template is plain text with no
links or images, so both checks are N/A against it — itself worth knowing.

**HTML check: 89.15% support** across 186 tests (6.77% partially supported,
4.08% not supported). 4 warnings across 8 HTML nodes.

<!-- TO FILL: expand each of the 4 warnings in the HTML Check tab and list the
     element + affected clients. The <body> element warning shows 39% / 29% /
     33%. -->

**Link check:**

<!-- TO FILL: open the Link Check tab and record results. At minimum there is
     the Cakemail unsubscribe link. If any tracking links report failures,
     check whether they are single-use or recipient-bound before recording
     them as broken. -->

**List-Unsubscribe:** the Mailpit message view shows an unsubscribe indicator
next to the From line, so Cakemail appears to set the header.

<!-- TO FILL: confirm on the Headers tab and state yes/no. Real deliverability
     positive at Gmail if present. -->

## Step 2 (cont.) — Proposed house threshold

**Proposed: 3.0 as measured on this harness.**

Reasoning: baseline is 0.6 with nothing actionable, giving roughly 4.4 points
of headroom below SpamAssassin's default cutoff of 5. Three points is enough
room to add tracking links, images and real body copy without tripping, while
still catching a genuine regression well before it becomes a delivery problem.
Anything scoring above 3.0 gets looked at before it goes out.

Caveats to read alongside that number:

- Scores measured on this harness are **not** production scores. Where
  `ALL_TRUSTED` fires it takes a point off that a real send would not get.
- SPF, DKIM and DMARC do not score meaningfully on a replayed message. Out of
  scope for this ticket.
- This is a template-quality gate, not an inbox-placement guarantee. Actual
  placement at Gmail / Outlook / Yahoo needs seed mailboxes — separate ticket.

<!-- TO FILL: sign-off. Acceptance criteria says the threshold must be AGREED,
     not proposed. Get Josh (or whoever owns the blast) to confirm 3.0, and
     record who agreed and when. -->

## Step 4 — Repeatability and CI recommendation

Run instructions written up — see Part 2 below / [link to Confluence page].

**API-driven scoring in CI: recommend a follow-up ticket.** All three checks
are exposed per-message over the Mailpit API, so this can run unattended:

```
GET /api/v1/message/{ID}/sa-check
GET /api/v1/message/{ID}/html-check
GET /api/v1/message/{ID}/link-check
```

<!-- TO FILL: confirm these exact paths against the interactive docs at
     http://localhost:8025/api/v1/ on the running version, and note whether
     sa-check returns the rule list as well as the total. -->

A CI check would send the template to the harness, poll for the message ID,
call `sa-check`, and fail the build above the agreed threshold. Not built
here — raising as a follow-up.

## Notes for whoever picks this up next

- The harness is shared with AI-895. **Do not use "Delete all"** in the Mailpit
  UI — it will wipe the volume-test data too. Delete individual messages.
- **SMTP binding needs review with JL** — confirm whether the current exposure
  is deliberate for the 895 volume testing or should be restricted. The
  recipient allowlist limits the damage either way. Specifics deliberately not
  recorded here; see the Confluence page.
- The "allow internal IPs" flag for link check was **not** enabled and is not
  needed — the Cakemail links are all public. It should stay off, as it opens
  an SSRF path.

---

# Part 2 — Run instructions

## How to spam-check a blast template

Anyone on the team can run this. Takes about five minutes. You need SSH access
to the harness box — ask JL.

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
