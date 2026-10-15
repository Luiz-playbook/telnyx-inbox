# The bulk sender (`hubspot-telnyx-integration`)

The HubSpot ↔ Telnyx SMS system. It sends Playbook's bulk SMS campaigns from our Telnyx numbers,
logs every text into the HubSpot inbox, and keeps consent current. It is a Next.js app on Vercel,
backed by Supabase Postgres.

| | |
|---|---|
| Repo | `marchsl/hubspot-telnyx-integration` (checkout `../hubspot_telnyx_integration`). `main` is protected, and merging it deploys production |
| Production URL | `https://hubspot-telnyx-integration.vercel.app` |
| Vercel | team `playbook-ai-agents`, project `hubspot-telnyx-integration` |
| Database | Supabase `pb-telnyx-request-mngr`, schema `bulk`. The `public` schema belongs to another team's 10DLC onboarding tool |
| UI | **Operator App** at the same URL. Supabase Auth, `@callplaybook.com` accounts only. Pages: Campaigns, Needs you, Numbers, People ("Find a person"), Pipeline, Settings |
| Owner | Charles (marchsl). SendBlaster's side is AI-965 |

## What it replaced, and why

It began as the replacement for n8n **workflow D** (bulk campaign drain). It now also does
**B** (an agent's reply from the HubSpot inbox, sent as SMS) and **C** (1:1 drafts from a contact
record). It sits in front of **A** (inbound texts and delivery receipts).

| n8n workflow | Replaced by | State |
|---|---|---|
| D: bulk drain | `/api/campaign-sweep` + `/api/drain` | archived 2026-09-01 |
| B: agent reply from inbox | `/api/inbox-reply` | archived 2026-09-02 |
| C: 1:1 draft send | `/api/one-to-one` | archived 2026-09-02 |
| A: inbound + receipts | `/api/inbound` | **A is still live.** Per the bulk sender's README, `/api/inbound` ran in *shadow* mode: it verifies, records and forwards to n8n. Check the README before assuming otherwise |

The reasons for moving off n8n:
- Speed. A 5,000-contact campaign took 4–6 h in n8n, because its batches run one at a time.
- Blast radius. The n8n workspace crash-looped every workflow twice.
- HubSpot contact properties are not a queue. That caused a 40-minute silent stall on 2026-08-20.

## How it runs

```
HubSpot stamps / API / SendBlaster ──► stage ──► bulk.campaign (draft) + bulk.recipient rows
                                                 │   (consent, opt-outs, phone fixes, census)
                                   arm/approve ──┘
                                                 ▼
          /api/drain (every minute) ── claims a batch FOR UPDATE SKIP LOCKED ──► Telnyx send
                 │                                                                   │
                 ├─ bulk.message (sent, in the same transaction)        receipts ◄───┘ (/api/dlr)
                 ├─ /api/log-sweep  → HubSpot inbox thread (custom channel)
                 └─ /api/stamp-sweep → HubSpot contact stamps + E.164 phone writeback
```

The **queue is Postgres**, with no Redis or queue service. The send and its compliance record
commit in one transaction, so there is no "sent but not recorded" case. HubSpot is told
afterwards, in batches.

### Crons (`vercel.json`)

| Route | Schedule | Job |
|---|---|---|
| `/api/drain` | every minute | Claim pending recipients of `running` campaigns and send at the carrier rate (`SEND_RATE_PER_SEC`, about 4/s, shared by all senders). Honours quiet hours, opt-outs, holds and `deferred_until` |
| `/api/campaign-sweep` | every minute | Intake from **HubSpot stamps** (`sms_campaign_key` + `sms_campaign_message`). Stamped campaigns arm once their list stops growing, or wait for Approve, depending on the number. Also holds suspicious ones and notifies |
| `/api/opt-out-sync` | every minute | Pulls `sms_opt_in` changes from HubSpot, so a STOP during a running campaign is honoured within about a minute |
| `/api/log-sweep` | every minute | Copies sent texts into the HubSpot inbox thread. Retries 429 and 5xx; abandons on other 4xx |
| `/api/stamp-sweep` | every 2 min | Writes contact stamps (`sms_last_sent_at`, `sms_last_campaign_id`, `sms_last_sent_body`), delivery status and E.164 phone fixes, 100 contacts per call |
| `/api/retry-sweep` | every minute | One delayed retry, at most 2 a minute, for texts ONVOY blocked as spam (Telnyx `40002`) |
| `/api/receipt-sweep` | every 5 min | Recovers delivery receipts that never arrived, by asking Telnyx about messages still `sent` after 30 min |
| `/api/number-sync` | every 15 min | Asks Telnyx about each sending number and records it. A deleted or disabled number becomes "not sendable" |
| `/api/legacy-opt-out-sync` | every 15 min | Keeps Salesmsg unsubscribes (`bulk.legacy_opt_out`) in step |

### Ways a campaign starts

| Door | Who | Arms how |
|---|---|---|
| HubSpot **stamps** (`campaign-sweep`) | Reps, via HubSpot workflows | Arms itself once the list is stable, below `STAMP_AUTO_ARM_MAX` (10,000), or waits for **Approve**, per number. Event Confirmations `+19345001252` is exempt |
| `POST /api/campaigns` (HubSpot list) | Operators with `API_SECRET` | `POST /api/campaigns/:id/arm` with `{"confirm":"<key typed out>"}` |
| `POST /api/campaigns/external` | **SendBlaster** with `SENDBLASTER_API_SECRET` | Auto-arms at most 2,000 eligible, from production; otherwise a draft for Approve. See [sendblaster-integration.md](sendblaster-integration.md) |

The **typed key** on arm and Approve exists because on **2026-09-01** an automated load test
armed a campaign and **242 strangers were texted**. A boolean is something a script satisfies
without anyone reading what is about to be sent.

## Consent, which is never optional

A recipient is texted only if **all** of these hold:
1. The phone number is held by a **HubSpot contact with `sms_opt_in = true`**. A number with no contact is
   counted as `not_in_hubspot` and never texted.
2. The number is not on an opt-out list. Opt-outs are checked by handset, across every record that holds
   the number: HubSpot (`opt-out-sync`), Telnyx's own STOP list, and Salesmsg unsubscribes.
3. `sms_deliverable` is not false, and the number is a valid NANP number.
4. It is **quiet-hours safe**: 8:00–21:00 in the recipient's local time, from a 319-entry map of area
   code to timezone.
5. It is checked again when the text is claimed for sending (`opted_out_since_staging`).

## Things it is careful about

- **Carrier limits.** About 4 msg/s per campaign (AT&T). T-Mobile allows about 2,000 a day per brand.
  All 7 numbers share **10DLC campaign `C8LB7XX`**, so one bad blast hurts every number, including
  ticket confirmations. `40016` means a daily cap, so the run halts with no contact marked.
  `40002` is ONVOY's spam block, retried once, slowly.
- **HubSpot rate limits.** The portal allows about 19 requests/s in general, but **search** (used by staging and the
  opt-out sync) is a separate bucket of about 6–7/s. `HUBSPOT_RATE_PER_SEC=5`. Inbox logging is
  the real throughput ceiling, at about 8 texts/s.
- **Thread continuity.** The thread id is `<contactPhone>__<ourNumber>`. The blast and the
  customer's reply land in the same HubSpot inbox thread.
- **The HubSpot thread timing rule (2026-08-05).** HubSpot ties a thread to a contact only when
  the thread is created. Staging writes E.164 phone fixes, so the first send must come minutes
  later. That is why a SendBlaster auto-arm waits 3 minutes (`deferred_until`).
- **Never deploy during a blast.** Deploys fill the database session pool (Supavisor). The rollout
  scripts check that no campaign is running first.
- **The `.env.local` file is production.** There is no local database. Never stage or arm from a laptop. Test
  numbers are only in the `555-0100`–`555-0199` range.

## Sending numbers (routes) on 2026-10-14

All 7 are sendable, with `max_segments` 10, stored in the database (`bulk.route`).

| Number | Inbox |
|---|---|
| +13159988112 | Ticketblast |
| +13238801900 | Event Marketing |
| +15512344320 | Kids |
| +16093602796 | general (existing) |
| +16808420065 | Marketing |
| +19345001252 | Event Confirmations (exempt from approval for stamped campaigns) |
| +19345001757 | Cole TBD |

`GET /api/routes` is the live answer. Do not hard-code this list. SendBlaster's "2-way 1"
`+14422300850` is **not** one of these.
