# LLM providers before OpenRouter (historical)

Frozen record of how this app talked to language models **before** the OpenRouter migration
of 2026-08-26. Written because the migration replaced one of the two providers with a
different company's model rather than re-routing it, and the reasoning behind the original
split is not recoverable from the diff.

Current behaviour lives in [`lib/llm.js`](../lib/llm.js) and [`lib/price.js`](../lib/price.js).
This file describes what those replaced.

---

## The shape of it

Six LLM workloads, two providers, chosen per workload rather than by preference.

| Workload | Endpoint | Provider | Model |
|---|---|---|---|
| Campaign Agent chat | [`api/chat.js`](../api/chat.js) | OpenAI | `gpt-4o` |
| Blast copy rewriter | [`api/draft.js`](../api/draft.js) | OpenAI | `gpt-4o` |
| Queue draft tailoring | [`api/queue-draft.js`](../api/queue-draft.js) | OpenAI | `gpt-4o` |
| Daily send decider (rationales) | [`api/decide.js`](../api/decide.js) | OpenAI | `gpt-4o` |
| Trigger decider (market picks) | [`api/trigger-decide.js`](../api/trigger-decide.js) | OpenAI | `gpt-4o` |
| Ticket price lookup | [`lib/price.js`](../lib/price.js) | **Google** | `gemini-2.5-flash` |

Two keys: `OPENAI_API_KEY` and `GEMINI_API_KEY`. Both server-side only.

### Conventions that shaped the code

- **No SDKs, no `package.json`.** Every call was a raw `fetch`. The repo had no dependencies
  and adding one npm package for one call was judged not worth changing the deploy shape.
  Each endpoint therefore carried its own copy of the request boilerplate — five near-identical
  `callOpenAI` functions. This is exactly the drift `lib/llm.js` was later created to stop.
- **Keys never reached the browser.** `ui/` is a static bundle, so anything in `ui/config.js`
  is public. [`scripts/gen-config.js`](../scripts/gen-config.js) writes that file from an
  explicit **allowlist**, and no model key was ever on it. This is why the draft endpoint
  exists at all: the browser cannot call OpenAI directly.
- **A dormant Anthropic branch.** `api/draft.js` and `api/queue-draft.js` both fell back to
  `claude-opus-4-8` via `api.anthropic.com` when `OPENAI_API_KEY` was unset. `ANTHROPIC_API_KEY`
  was commented out in `.env`, so it never fired — but it was live code, not dead code.

### Cost

Nothing measured the OpenAI side. Spend was visible only as a monthly total in the OpenAI
dashboard, unattributable to any endpoint. **This is the gap the OpenRouter migration was
meant to close.**

The Gemini side was measured precisely, per run, into `events_master_price_runs` — see
"Cost model" below.

---

## Why the price lookup used a different provider

This is the part worth preserving, because it looks like an inconsistency and is not one.

### The job is search, not generation

The other five workloads write text. The price lookup **reads a number off the live web**.
A model cannot do that from training data: ticket prices move hourly and the weights are a
frozen snapshot. Asked cold, a model either declines or invents.

So the request carried a flag:

```js
tools: [{ google_search: {} }]
```

That is **not** function calling, and it is not part of the prompt. It is a server-side
capability on Google's `generateContent` endpoint that tells *Google* to run a real search,
fetch the result pages, and inject them into the context before the model generates. The
model's only job is extraction — reading a get-in price out of freshly fetched listings.

Google was chosen because it was the only provider exposing that capability. The model was
incidental; the search was the product.

### Why not just ask a model for prices

Tried, and it is the failure mode the prompt is written to prevent. `buildPricePrompt()`
says, in the file to this day:

> Do NOT guess or estimate. If no active, verified listing is found via web search, return
> `null` for `price_usd` and `source`.

Ungrounded, that instruction is doing all the work and the honest answer is always `null`.
Measured on four MLB games (2026-09-04) with the same prompt: ungrounded returned 0/4;
grounded returned 4/4 at $27–$46, all matching real listings.

### Model choice within Google

`gemini-2.5-flash`, upgraded from `flash-lite` on 2026-08-03. The reasoning is preserved in
`lib/price.js`: the prompt carries conditional logic (prefer a two-seat listing, fall back to
a single, divide a pair total by two) and lite was the tier most likely to fumble it and
report a pair total as a per-seat price.

The upgrade was close to free **there specifically**, which does not generalise: grounding
billed per request, so tokens were noise. See below.

### Cost model — grounding dominated

```js
PRICE_IN_COST     = 0.30 / 1e6    // USD per input token
PRICE_OUT_COST    = 2.50 / 1e6    // USD per output token
GROUNDING_PER_REQ = 0.035         // USD per grounded request
```

A full refresh was ~22 batched requests ≈ **$0.77 of grounding** against a measured average
run cost of **$0.71**. Grounding was effectively the entire bill; token rates barely moved it.

This matters historically: any cost comparison against a token-priced route is not
like-for-like. A token-only figure under-reports a grounded run by nearly its whole cost.

### Guards the prices ran through

Bad prices were expensive enough to earn dedicated defences, all of which outlived the
migration:

- **`PRICE_SANITY_MAX = 250`** — a get-in price is the cheapest seat in the building.
  Anything above this is a premium/club seat reported by mistake. Seen for real: $1,189 on a
  regular-season Twins game while comparable games returned $8–$89. Dropped and counted as a
  miss, which the next run retries.
- **`ASK_FOR_LISTING_URL = false`** (AI-845) — the model used to be asked for a listing URL
  alongside the price. Run average went $28 → $42 and the $1,189 figure appeared. The finding
  was that a second output field competes with the price for the model's attention. The URL
  has been built in code by `buildSearchUrl()` ever since.
- **Fabricated-id detection** — `looksFabricatedId()` rejects placeholder listing ids
  (`.../mlb-game-1-e1234567`, suspiciously round numbers) so links fall back to a team page
  that resolves rather than a dead listing.

### Where a price ends up

Not cosmetic. `best_price` in `events_master` feeds:

- [`ui/index.html`](../ui/index.html) — the price and its provenance on Queue and Campaigns
- [`api/chat.js`](../api/chat.js) — the Campaign Agent's `get_event_price` tool
- [`api/queue-draft.js`](../api/queue-draft.js) — injected as `Get-in price: $X` into the
  draft prompt, so the number reaches **outgoing marketing copy**

A wrong price is therefore quoted to a customer, which is why every guard above prefers no
price to a doubtful one.

---

## What replaced it, and why not like-for-like

Recorded here so the comparison isn't lost.

The five OpenAI workloads were re-routed with no change in behaviour: same `gpt-4o`, reached
via OpenRouter, with the provider pinned to OpenAI so the upstream stays what it always was.

The price lookup **could not be re-routed**. OpenRouter normalises every provider to the
OpenAI chat-completions schema, which has no field for `tools: [{google_search: {}}]`, so the
flag is silently dropped — accepted, ignored, no error. Measured 2026-08-26, same prompt:

| Route | Prompt tokens | Coverage |
|---|---|---|
| Google native + grounding | 478 (+ fetched pages) | **4/4** |
| `google_search` via OpenRouter | 449 — *identical to ungrounded* | 0/4 |
| OpenRouter web plugin + `gemini-2.5-flash` | 3,606 | 0/4 |
| OpenRouter web plugin + `gemini-2.5-pro` | 3,875 | 0/4 |
| OpenRouter web plugin + `gpt-4o` | 3,259 | 0/4 |
| `perplexity/sonar-pro` | 423 | 3–4/4 |

The identical 449 is the proof: nothing was fetched. The web plugin's inflated counts show it
*does* inject search results — it just found no prices with them.

So the price lookup changed vendor entirely, to `perplexity/sonar-pro`, which runs its own
live search. It is cheaper (~$0.010/request vs ~$0.037) and **less accurate**: on the same
four games it read low on three ($23 vs $33, $15 vs $27, $31.77 vs $46) and varied between
runs. `PRICE_SOURCE_DENY` and `normalizeSource()` in `lib/price.js` exist to compensate for
behaviour Gemini never exhibited — prose in the `source` field, and all-in reseller prices
quoted as get-in.

`GEMINI_API_KEY` remains wired as the fallback route in `priceRoute()` for as long as a key
exists. If Perplexity's numbers prove unusable, unsetting `OPENROUTER_GEMINI` restores the
grounded path with no code change.

### The null-retry, and why it isn't OpenAI

The old code dropped a game that came back without a price: `api/price-refresh.js` retries a
batch only when it returns **zero** prices, so a single null inside a good batch was never
looked at again. That was survivable when the primary route hit 4/4; it is not, on a route
that misses.

`callPrices()` now retries **only the games that missed**, on a more accurate tier — so a
clean batch costs nothing extra. Verified by forcing the primary to a model measured at 0/4:
`retried=4`, all four rescued, cost accumulated across both calls.

The obvious question is why the retry is not OpenAI, given the other five workloads run there.
Because no OpenAI model on OpenRouter can search:

- `openai/gpt-4o-search-preview` and `-mini-search-preview` return **404 — no endpoints found**
- plain `openai/gpt-4o` with the web plugin measured **0/4**

Filtering OpenRouter's 417-model catalogue for search capability returns Perplexity `sonar`
variants and nothing else. So the fallback is a different *tier*, not a different company —
`sonar-pro` first, `sonar-pro-search` for the misses.

| Model | Coverage | Within 25% | Cost/req | Latency |
|---|---|---|---|---|
| Google grounded *(gone)* | 4/4 | — (reference) | $0.037 | 30s |
| `perplexity/sonar-pro` | 3–4/4 | 1/4 | $0.010 | 9s |
| `perplexity/sonar-pro-search` | 4/4 | 3/4 | $0.022 | 13s |
| `perplexity/sonar-reasoning-pro` | 4/4 | 2/4 | $0.008 | 95s — exceeds the run budget |

Both models are overridable without a deploy: `PRICE_MODEL_OR` for the primary,
`PRICE_FALLBACK_MODEL` for the retry (`off` disables it).
