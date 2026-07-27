# AI-827 — Batched ticket-price lookup POC (Gemini)

**Spike, throwaway.** Goal: prove we can get per-game resale prices by feeding *specific*
games from `events_master` to Gemini in small batches, asking only for price. Harness:
[scripts/poc-price-lookup.js](../scripts/poc-price-lookup.js). Source games: the 826 master
table (30 MLB teams, remaining 2026 home games).

## Setup

- Model: Gemini 2.5 (`flash`, `flash-lite`, `pro` selectable), **grounded** via the
  `google_search` tool — required, or the model just hallucinates prices (price is the
  one field 826 can't guarantee, so grounding is the whole point).
- Prompt per game: `on {date} the {team} host the {opponent} at {venue}` → lowest get-in
  resale price USD, `null` + note if not found. Explicit date + opponent + venue each.
- Cost model: Gemini token pricing **+ $0.035 per grounded request**. At small batches the
  grounding fee dominates, so batch size is the main cost lever. *(Prices approximate —
  verify before quoting.)*

## Results (measured)

| run | model | batch | priced | coverage | time | cost | extrapolated 840 |
|-----|-------|-------|--------|----------|------|------|------------------|
| A | flash      | 6  | 6/6   | 100% | 15.8s | $0.037 | ~$5.14, ~37 min |
| B | flash      | 15 | 17/30 | 57%  | 58.3s | $0.077 | half missing |
| C | flash-lite | 6  | 6/6   | 100% | **3.7s**  | $0.035 | ~$4.92, ~9 min |
| D | flash-lite | 6 (×10, **60 games**) | 48/60 | **80%** | 41.5s | $0.35 | ~$4.92, **~10 min** |
| E | flash-lite | 300 in ONE call | — | **fails** | timeout | — | not viable |

### Findings

1. **Small batches are mandatory.** Batch 6 → good coverage. Batch 15 → 57% (run B); the
   model silently drops games it can't ground in one shot. Coverage, not cost, breaks first.
2. **flash-lite ≈ flash for this task, 4× faster, same cost.** 3.7s vs 15.8s per batch
   (run C vs A). Cost is grounding-fee-dominated so the tiers price the same. This is a
   search task, not a reasoning task — the expensive tiers buy nothing. **Skip pro.**
3. **Real coverage is ~80% per pass, not 100%.** The 6-game sample flattered it; at 60 games
   (run D) 12 were unpriceable in one pass. A **second retry pass over the misses** is needed
   to approach full coverage — budget for it.
4. **Grounding fee dominates cost:** $0.035/call ≫ tokens (~$0.001/call). Cost ≈
   `0.035 × (games / batch)`. At batch 6 the full 840-game slate ≈ **$4.90 grounding + pennies**.
5. **A single ~300-game call is not viable** (run E): the request timed out
   (`UND_ERR_HEADERS_TIMEOUT`), never returned. No provider should be handed a 300-game
   bulk list — the shape is wrong regardless of vendor.
6. **Accuracy is still unmeasured.** No ground-truth feed, so "priced" = *a price came back*,
   not *correct*. Needs a manual spot-check: pull ~20 returned prices, compare to
   StubHub/SeatGeek by hand. **Open — do before productionizing.**

## Cost / time envelope (flash-lite, grounded, batch 6)

- Full remaining MLB slate (~840): **~$5**, **~10 min** per pass (+ a retry pass for the ~20%).
- AI-828 eligible slice (market + 20-day window, ~310 games): **~$2**, **~4 min** per 72h
  cycle. Matches Josh's ~300–400 estimate.

## MCP comparison — *pending*

Josh's MCP options not tested (endpoints not shared yet). The bulk test (finding 5) already
answers the "can one accept ~300 games in a single call" question: a single giant call is the
wrong shape regardless of provider. Fill in per-provider cost once endpoints arrive.

## Recommendation

- **Productionize: Gemini 2.5 flash-lite, grounded (`google_search`), batch 6.** Same coverage
  as flash, 4× faster, cheapest. pro is dead weight for a search-bound task.
- **Two-pass:** initial batch-6 sweep, then one retry pass over `price_usd = null` games to
  lift ~80% → high-90s.
- Feed the AI-828 eligible slice, not the whole table — **~$2 / ~4 min per 72h cycle**.
- **Blocker before productionizing:** the manual accuracy spot-check (finding 6). Coverage is
  proven; correctness is not.
