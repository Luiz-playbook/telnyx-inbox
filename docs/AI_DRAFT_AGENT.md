# Campaign copy agent — "Anything specific for this blast?"

The Compose tab's **Anything specific for this blast?** card rewrites the Email/SMS copy
in the Preview card to match a one-line operator instruction. This document is the spec
for that agent: what it receives, what it returns, and the exact prompts.

Implementation: [`api/draft.js`](../api/draft.js). The prompts live in that file as
`SYSTEM_PROMPT` and `userPrompt()` — **edit both places together** or they drift.

---

## Why there are two buttons

> Save draft → Apply to draft

The Compose tab has four cards, and the copy in **Preview** is only correct relative to
the other three: which **play** is selected, what's in **Market & Game**, and which
**channels/senders** are on in **Audience & Channels**. Those are live form fields —
an operator can change the market after the copy was written.

**Save draft** snapshots all three into one object. **Apply** sends that snapshot, not
the live DOM. This means the copy is rewritten against the values the operator actually
reviewed, and a mid-edit field change can't silently leak into the prompt.

Applying also **clears the "I've reviewed this copy" checkbox**, because the copy the
operator approved no longer exists. That re-locks "Add to Send Plan".

---

## Request

`POST /api/draft`, header `x-inbox-secret: <REPLY_SECRET>`.

```jsonc
{
  "draft": {
    "play": "ticket",                    // ticket | suite | teammate | waitlist
    "playLabel": "Ticket Blast",
    "playDesc": "Tickets as a demo-booking incentive…",
    "marketCode": "OH",
    "marketName": "Ohio",
    "contextLabel": "Game / Event",      // relabels per play (Hook / Waitlist / …)
    "context": "Browns Home Opener",
    "sport": "",                         // Teammate AI / Event Waitlist only
    "gameDate": "2026-09-27",            // Ticketblast / Suite only
    "costPerBundle": "20",               // Ticketblast / Suite only
    "assignedBda": "unassigned",
    "lastSuite": "unknown",
    "nextSuite": "unknown",
    "notes": "Lower bowl, section 112",
    "email": true, "sms": true,          // channels firing
    "emailFrom": "john@callplaybook.com",
    "smsFrom": "+1…",
    "emailBody": "…current Email preview…",
    "smsBody": "…current SMS preview…"
  },
  "instruction": "mention the new sponsorship program"
}
```

`sport` and `gameDate`/`costPerBundle` are mutually exclusive — the Compose form hides
one set per play, and the snapshot sends only the visible fields so the model isn't told
about a game date on a play that has none.

## Response

```jsonc
{ "email": "…rewritten…", "sms": "…rewritten…", "model": "claude-opus-4-8" }
```

An inactive channel is returned **unchanged from the request** — the server overwrites
whatever the model produced for it, so a stray rewrite can't reach a channel that's off.

Errors are `{ "error": "…" }` with 400 (bad input), 401 (bad secret), 500 (no key
configured), or 502 (model call failed / unparseable output).

---

## System prompt

```
You are the campaign copy agent for Playbook Sports' Marketing Blaster.

You rewrite outreach copy that a human operator is about to send to sports organizations. The operator gives you (a) a saved campaign draft and (b) one instruction describing what makes this run different. You return the rewritten copy.

RULES
1. Rewrite only what the instruction asks for. Preserve the existing voice, structure, and sign-off. This is an edit, not a fresh draft.
2. Never invent facts. Use only what the draft gives you. If the instruction asks for something the draft does not support (a discount, a deadline, a stat), leave it out rather than making it up.
3. Preserve placeholder tokens exactly as written — [NAME], [GAME], [DATE], [SPORT]. They are filled at send time. Never replace a token with a real value, and never introduce a token the original copy did not have.
4. Keep the sender identity consistent with the draft. Do not change who is writing or their title.
5. SMS is a single message with no subject line and no signature block. Keep it under 480 characters. Email keeps its greeting, paragraphs, and sign-off.
6. Do not add links, phone numbers, prices, or calendar URLs unless they already appear in the copy you were given.
7. Compliance: no unsubstantiated urgency ("last chance", "expires tonight") unless the draft states a real deadline. No all-caps shouting. No emoji unless the original copy already used them.
8. Rewrite only the channels marked active in the draft. For an inactive channel, return its original text unchanged.

Return the rewritten copy and nothing else — no commentary, no explanation of what you changed.
```

### Why each rule is there

| Rule | Failure it prevents |
|---|---|
| 1 — edit, don't rewrite | The model replacing Cole's authored voice with generic AI copy on every apply |
| 2 — no invented facts | "20% off" / "offer ends Friday" appearing in outreach that has no such offer |
| 3 — preserve tokens | `[GAME]` resolved to a literal game name, so every recipient gets the wrong one — or a *new* token nothing fills, sending `[CITY]` literally |
| 4 — sender consistency | Teammate AI copy signed by Josh instead of Will/James |
| 5 — SMS shape | A signature block or subject line landing in a 160-char SMS segment |
| 6 — no new links | A hallucinated booking URL in outreach that actually sends |
| 7 — compliance | Fabricated urgency in cold outreach; 10DLC carrier-filtering risk |
| 8 — active channels only | Rewriting SMS copy the operator deliberately turned off |

## User prompt template

Built by `userPrompt(draft, instruction)`. Absent fields are omitted rather than sent as
empty labels, so the model isn't told "Sport:" with nothing after it.

```
## Campaign draft (saved by the operator)
- Play: {playLabel} — {playDesc}
- Market: {marketName}
- {contextLabel}: {context}
- Sport: {sport}                      (omitted when blank)
- Game date: {gameDate}               (omitted when blank)
- Cost per bundle ($): {costPerBundle}
- Assigned BDA / Last suite / Next suite / Notes
- Channels firing: Email + SMS
- Email sender / SMS sender

## Current Email copy
{emailBody}                           (or "(email channel is OFF — return this unchanged)")

## Current SMS copy
{smsBody}

## Operator instruction
{instruction}

Rewrite the copy for the active channels so it satisfies the instruction, following every rule in your instructions.
```

## Structured output

Both providers are constrained to this schema, so the response is always parseable
rather than prose wrapped around a JSON block:

```json
{ "type": "object",
  "properties": { "email": {"type":"string"}, "sms": {"type":"string"} },
  "required": ["email","sms"], "additionalProperties": false }
```

- **Anthropic** — `output_config.format` (`json_schema`), adaptive thinking, `effort: medium`.
- **OpenAI** — `response_format.json_schema` with `strict: true`.

---

## Configuration

Set **one** key in Vercel → Settings → Environment Variables. Anthropic wins if both are set.

| Var | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-…` | Uses `claude-opus-4-8` |
| `OPENAI_API_KEY` | `sk-proj-…` | Uses `gpt-4o` |
| `DRAFT_MODEL` | optional | Overrides the model id |
| `REPLY_SECRET` | shared secret | Must match `ui/config.js`; unset disables the gate |

**The key must never appear in `ui/config.js`.** That file is generated by
`scripts/gen-config.js` and served to every visitor — anything in it is public. Do not
add the model key to `gen-config.js`'s `cfg` object. `api/draft.js` reads
`process.env` directly, which is why the key stays server-side.

## Running locally

`/api/draft` is a Vercel function, so a plain `npx serve ui` returns 404 for it — the
UI reports that explicitly rather than failing silently. For the real thing:

```powershell
vercel dev
```

with `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) and `REPLY_SECRET` in `.env.local`.

## Known gaps

- **No cost ceiling.** Every Apply is a model call; nothing rate-limits per user beyond
  the `REPLY_SECRET` gate. Add a per-IP limit before this is exposed beyond the team.
- **Rules are prompt-level, not enforced.** Nothing server-side verifies that the
  returned copy kept its `[GAME]` token or stayed under 480 chars for SMS. A validation
  pass on the response (reject and retry once) would make rules 3 and 5 hard guarantees.
- **Single-shot.** No conversation history, so "make it shorter" after a previous apply
  re-reads the current preview rather than remembering the earlier instruction. That is
  intentional — the preview *is* the state — but it means instructions don't compose.
