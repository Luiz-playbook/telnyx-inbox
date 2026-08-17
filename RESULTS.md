# Mailpit email-blaster test harness — results

Session scope: stand up the sink, point both transports at it, prove a 500-recipient run
lands with matching counts.

**Outcome: the sink is up and verified. The 500-recipient run did not happen, because
neither in-scope transport exists in this codebase.** Details in "Blockers" below. No
counts are reported rather than counts from a path that was invented to produce them.

Host: `94.72.117.9` (Contabo, Ubuntu 24.04.4 LTS, x86_64)

---

## Task 1 — Mailpit

| | |
| --- | --- |
| Container | `mailpit`, `axllent/mailpit:latest`, Mailpit **v1.30.7** |
| Status | Up, healthy, `--restart unless-stopped` |
| Docker | Not present on the box; installed this session via `get.docker.com` → **29.7.2** |
| Network | `mailpit-net` (user-defined bridge) — see SpamAssassin below |
| Reachable from app | **n/a** — the app has no SMTP transport (see Blockers) |
| Reachable from n8n | **No** — port 1025 is not reachable from outside the host (see below) |

All seven env flags verified as the container sees them, via `docker inspect`:

```
MP_DATABASE=/data/mailpit.db          MP_MAX_MESSAGES=0
MP_SMTP_AUTH_ACCEPT_ANY=1             MP_SMTP_AUTH_ALLOW_INSECURE=1
MP_SMTP_ALLOWED_RECIPIENTS=@example\.test$   MP_ENABLE_CHAOS=true
MP_ENABLE_SPAMASSASSIN=spamassassin:783
```

The allowlist regex survived shell quoting intact — worth confirming explicitly, since a
mangled regex here fails open.

### SpamAssassin (for the spam-check ticket)

Added at startup, since the flag cannot be set on a running container. Done while the DB
held one throwaway test message, so the recreate cost nothing.

- `spamassassin` container, `axllent/spamassassin`, healthy, `--restart unless-stopped`
- Mailpit started with `MP_ENABLE_SPAMASSASSIN=spamassassin:783`

**Both containers had to move onto a user-defined network (`mailpit-net`).** Mailpit was
originally on Docker's default bridge, which has no container-name DNS — `spamassassin:783`
would not have resolved there. Anything else that needs to talk to Mailpit by name must
join `mailpit-net`.

Verified live, not merely configured: a message carrying the **GTUBE** test string scored
**1002** with the `GTUBE` rule fired (`/api/v1/message/{ID}/sa-check`, no error). Scoring
works end to end.

The allowlist was re-tested after the recreate and still rejects (`someone@gmail.com` →
550, `@example.test` → accepted). Message count survived the recreate — the volume holds.

Host resources are comfortable for both containers: 8 GB RAM (6.8 GB free), 4 cores, 137 GB
disk free.

`curl localhost:8025/api/v1/info` returns JSON. Data dir `~/mailpit-data`, DB persisted.

### Port exposure

Operator's call: **1025 open to the internet**, 8025 bound to localhost only (reached over
an SSH tunnel). Run with `-p 1025:1025 -p 127.0.0.1:8025:8025`.

**1025 is not actually reachable from outside**, despite being correctly exposed:

- listening on `0.0.0.0:1025` (`ss -lntp` confirms docker-proxy)
- `ufw` inactive, `iptables -L INPUT` policy ACCEPT, no filter rules
- the box **can** reach its own public IP on 1025
- an external machine **cannot** (TCP connect fails)

So the block is upstream of the host — most likely the **Contabo cloud firewall**, or
outbound 1025 filtering on the testing network. Needs a check in the Contabo panel, and
ideally a second external vantage point to disambiguate. Currently moot (nothing external
needs to deliver here yet) but it will block n8n delivery the moment that changes.

---

## Task 2 — Transports

### 2a. Direct SMTP (the app) — **BLOCKED, no such transport**

`grep -i smtp` across `lib/`, `api/`, `scripts/`, `n8n/` returns **zero hits**. There are no
SMTP env vars to override and no mail library to repoint.

Email leaves this system through the **CakeMail HTTPS API** (`lib/cakemail.js`,
`https://api.cakemail.dev`). Mailpit is an SMTP sink and cannot intercept an HTTPS client.

This is not a "hardcoded config, needs a refactor" case — the handoff's stop condition. It
is a different integration shape entirely, and one that changes what the test would even
measure. CakeMail is **list-based, not per-recipient**: one market blast is five API calls
(create list → accept policy → import contacts → create campaign → schedule) whether it
carries 500 addresses or 12,000. There is no per-recipient SMTP fan-out from our side to
drop messages, so "sent vs received per recipient" is not the failure mode this transport
can have. Any drop-out happens inside CakeMail, after the contact import, where an SMTP
sink cannot see it.

### 2b. n8n Send Email node — **BLOCKED, no such node**

No `n8n-nodes-base.emailSend` node exists in any of the 8 workflows in `n8n/`. The only
email nodes are 2× `n8n-nodes-base.gmail`, which the handoff itself rules out of scope as
un-interceptable OAuth2.

There was no live workflow to duplicate and no SMTP credential to swap, so no
`Mailpit (test)` credential and no `[TEST] Blast - Mailpit` workflow were created.

### 2c. Allowlist rejection test — **PASS**

The check that stands between a test run and emailing real people. Run via `smtplib`
(`swaks` not installed):

| Recipient | Result |
| --- | --- |
| `someone@gmail.com` | **REJECTED** — `550 5.1.0 Requested action not taken: mailbox unavailable` |
| `pbstress-smoke-1@example.test` | **ACCEPTED** |

Mailpit counters agree: `SMTPAccepted: 1`, `SMTPRejected: 1`.

The safety net works. A live list pointed here by mistake gets refused at the sink.

---

## Task 3 — 500-recipient smoke run — **NOT RUN**

Blocked on Task 2. There is no transport that delivers to an SMTP sink, so there is no
sent-vs-received number to report. Per the handoff's instruction to stop and report rather
than explain a gap away, no substitute path was constructed to manufacture a result.

No addresses were seeded. Nothing was written to Supabase.

---

## Planner isolation proof — **PASSES**, verified against the live database

The ticket's highest-risk item, done ahead of any seeding because being wrong here means
emailing real people. It does not depend on the transport question, so it was the same work
under any answer to that.

**The mechanism already exists** and is enforced in SQL, not application code:
`public.send_allowlist` (migration 023). When non-empty, it restricts recipient resolution
to the listed market codes; empty means normal operation for every market.

Verified on the live project (`snfmggrnyjayuuxafats`), not from the migration files:

1. **Test mode is ON.** `send_allowlist` holds exactly one row: `ZZ`, the Playbook Sports
   Test market (added 2026-07-28).
2. **The gate survived being redefined.** Migration 050 reissued both resolvers with
   `create or replace` for per-segment support — the exact way a safety net gets silently
   dropped. `pg_get_functiondef` on the live functions confirms both `market_emails` and
   `market_phones` still carry the `not exists (select 1 from send_allowlist) or ... in
   (select code from send_allowlist)` clause. Both are `SECURITY DEFINER`, so no caller role
   can route around it.
3. **They are the only recipient-resolution path.** No code in `api/`, `lib/`, `ui/`, or
   `n8n/` reads `market_contacts` directly to send. The single reference is
   `refresh_market_contacts()` (a service_role-only rebuild). The nightly decider workflow
   never resolves recipients at all — it reads `icp_events` / `blast_templates` and writes
   `campaign_send_log`; the send is `api/queue-tick.js`, which goes through the gated RPCs.
4. **Empirically blocked.** `CA` displays **2,586** email contacts;
   `market_emails('CA')` returns **0**, and `market_phones('CA')` returns **0**. The largest
   real market in the system resolves to nobody while test mode is on.

Conclusion: a seeded test market is unreachable by the live planner, and so is every real
market, for as long as `send_allowlist` is non-empty. The failure mode to watch is not
leakage but **`truncate send_allowlist`** — that single statement re-arms every market at
once, and it is also what `api/queue-tick.js` keys its open no-credential "Send now" path
on, which closes automatically when the list empties.

### But: seeding 12,000 recipients cannot work as specified

**`market_emails` and `market_phones` both end in `limit 1000`** — present since migration
023 and still in the live definition today.

A seeded 12,000-recipient market therefore resolves to **1,000** addresses, not 12,000. With
the `p_segment` argument the ceiling is 1,000 per segment across `ICP`/`SCP`/`Other`, so
3,000 at absolute best. The 2,500 / 7,500 / 12,000 tiers cannot run against this resolver
regardless of which transport is chosen.

Worse for the ticket's core metric: **the count RPCs are neither gated nor capped.**
`market_recipient_counts()` and `market_recipient_counts_by_segment()` read
`market_counts` / `market_segment_counts` directly. So the UI would display 12,000 while
the send resolved 1,000 — a 11,000-message "loss" that is a `LIMIT` clause, not a pipeline
defect. That is precisely the phantom result this harness exists to avoid producing.

**This is a live production finding, not just a test-harness one.** Of 45 markets, **16
currently hold more than 1,000 email contacts** (largest: 2,586), totalling **10,725
addresses beyond the cap**. Once test mode is turned off, every send to those markets
silently tops out at 1,000 while the UI reports the full figure. Nothing warns anyone.

Seeding was **not** performed. It is on the handoff's "not this session" list, and the cap
makes it premature anyway — the seed would produce a misleading number rather than a
measurement. Nothing was written to Supabase this session; all queries were read-only.

## Blockers and findings

1. **The harness premise doesn't match the codebase.** The ticket assumes two SMTP
   transports with per-recipient fan-out. The system has one HTTPS API transport with
   list-based sending, plus a Gmail node that is already out of scope. This needs a design
   decision before more time goes into it — it is arguably Marx's call.
2. **A CakeMail-shaped harness would look different**: intercept or proxy
   `api.cakemail.dev`, assert the imported contact count matches what we submitted, and
   test behaviour at the campaign level. That tests our actual pipeline. It is a different
   build from this handoff.
3. **CakeMail is currently rejecting sends anyway** — "Action blocked due to a low account
   score", escalated to support. The live email path is blocked upstream of any of this.
4. **Port 1025 unreachable externally** — see above. Contabo panel needs checking.
5. **Docker was not installed** on the VPS; installed this session.
6. **Root SSH password was shared in plaintext** during setup and should be rotated. A
   dedicated ed25519 key (`claude-code-mailpit-harness`) is now in
   `/root/.ssh/authorized_keys`; once confirmed working, `PermitRootLogin prohibit-password`
   closes password auth. Left to the operator rather than changed unilaterally.

---

## Remaining (not this session)

- Seeding the full 12,000-recipient market in Supabase — **pointless until the `limit 1000`
  cap is resolved**; the isolation proof it was gated on is now done (see above)
- Tiers 2,500 / 7,500 / 12,000 on both transports — **additionally blocked by the
  `limit 1000` resolver cap**, independent of the transport question
- Chaos failure injection at tier 3, and killing the container mid-run
- List-Unsubscribe header validation on the blast template — **blocked**. We never set the
  header ourselves; `lib/cakemail.js` sets `default_unsubscribe_link: true` and CakeMail's
  MTA injects `List-Unsubscribe` at send time. Validating it therefore requires receiving a
  real CakeMail-delivered message, which needs both a working CakeMail account (currently
  refused for low account score) and a way to receive it. Not doable by inspection.
- Throughput ceiling documentation and the production transport recommendation
- Posting results to Marx for sign-off

Throughput caveat for later tiers: Mailpit's docs disagree on ingest rate (features page
100–200/sec, README 200–300/sec). Plan against the lower figure; if a transport lands near
it, the harness is the bottleneck and the run needs better hardware before the number is
trusted.
