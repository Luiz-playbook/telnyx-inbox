# Events & Pricing Pipeline

How game schedules and ticket prices get into the app, where they come from, and how
they're kept fresh. Covers tickets AI-826, AI-827, AI-828, AI-829, AI-830, AI-844, AI-845.

Target Supabase project: **Playbook n8n** (`snfmggrnyjayuuxafats`).

```
Schedule source ─► events_master ─► market resolution ─► decider ─► price refresh ─► UI + agent
(per league)       (frozen games)   (team → market)      (send?)    (Gemini, tiered)
```

The old design asked an LLM open-ended "give me every game", which hallucinated 2027 games.
Now the game list is loaded once per season from deterministic schedule sources; the LLM only
ever touches **price**.

## 1. Schedule sources (per league)

Every `events_master` row stores `source_url` + `external_id`, so any row is traceable to its
source. Loader: [`scripts/load-schedule.js`](../scripts/load-schedule.js) (`--league <x>`).

| League | Source | Why | Status |
|--------|--------|-----|--------|
| MLB | **MLB StatsAPI** `statsapi.mlb.com` | Official, free, one call/season | ✅ loaded (840) |
| NHL | **api-web.nhle.com** (official) | Official, full season/team | ✅ loaded (1344) |
| NFL | **nflverse** `raw.githubusercontent.com/nflverse/nfldata` | No free official API; ESPN unreachable from our network. Widely-public community CSV (AI-844) | ✅ loaded (264) |
| NBA | ESPN hidden API `site.api.espn.com` | Schedule releases mid-August; nothing to load yet | ⏳ coded, pending release |
| College | ESPN hidden API | Same shape as NBA | ⏳ coded |

Notes:
- **ESPN does not resolve from the dev/prod network here** ("API access issue" in AI-844). That
  forced NHL → official api-web and NFL → nflverse. NBA/college use the coded ESPN path and are
  only verifiable where ESPN is reachable.
- NFL loader excludes `location=Neutral` (international games) — the home team isn't hosting in
  its own market/venue there.
- MLB initial load is [`scripts/load-mlb-events.js`](../scripts/load-mlb-events.js); the generic
  multi-league loader is `load-schedule.js`.

## 2. Master table & schedule refresh (AI-826, AI-830)

- Table: `public.events_master` — `league, team, opponent, event_date, event_time, venue,
  home_away, market_code, state_code, best_price, priced_at, external_id, source_url, season`.
  Migration [`017`](../migrations/017_events_master.sql).
- Write path: `upsert_events_master(jsonb)` — idempotent (`on conflict do nothing`), so re-runs
  and season refreshes only ADD new games. Resolves market at write time (league-aware, see §3).
- **Schedule refresh** (AI-830): `record_schedule_run()` + `events_master_schedule_runs` change
  log (rows added per run). Monthly cron `api/schedule-refresh.js` keeps MLB current; run
  `load-schedule.js --league <x>` on demand when a league releases. Migration [`026`](../migrations/026_schedule_refresh.sql).

## 3. Market resolution (team → market)

- `market_bridge_team(team_lc → market_key)` — league-blind nickname map.
- `market_bridge_team_league(league, team_lc → market_key)` — **league-aware override**, checked
  first. Needed for cross-league nickname collisions. Migration [`028`](../migrations/028_league_aware_market_bridge.sql).
  Current overrides: `rangers` (NHL→New York), `cardinals`/`giants`/`jets`/`panthers` (NFL).
- League nickname aliases: MLB [`018`](../migrations/018_bridge_mlb_nickname_aliases.sql),
  NHL [`029`](../migrations/029_bridge_nhl_nickname_aliases.sql), NFL [`031`](../migrations/031_bridge_nfl_markets.sql).
- Unresolved teams (no market defined) keep `market_code = null` — **retained + flagged**, never
  dropped. Currently: NHL Columbus/Vegas/Nashville/San Jose; NFL Indy/Jacksonville/Green Bay/
  Vegas/Nashville.
- **Canadian NHL markets** (AI-829): 6 metros (Toronto, Montreal, Vancouver, Calgary, Edmonton,
  Winnipeg). Leads assigned by ~50mi metro-city list (`market_metro_city`) since leads have no
  lat/long; `canadian_market_summary()` mirrors the US segment shape; `canadian_unassigned_leads()`
  lists in-province-but-outside-metro leads (Ottawa, Victoria, Kelowna...). Migration [`027`](../migrations/027_canadian_nhl_markets.sql).

## 4. Pricing (AI-827, AI-828, AI-845)

- **Source:** Gemini `gemini-2.5-flash-lite`, **grounded** via `google_search` — NOT a ticket-site
  API. It web-searches resale listings (StubHub/SeatGeek/Ticketmaster) and returns the lowest
  get-in price + which site. Shared path: [`lib/price.js`](../lib/price.js).
- **Prompt is pinned** (AI-845): single ticket (per seat), **pre-fee listed** price.
- **Job:** `api/price-refresh.js` prices the decider's send-eligible games, writes `best_price`
  via `set_event_prices()` (also appends to `events_master_price_history`). Migration [`020`](../migrations/020_price_refresh.sql), [`030`](../migrations/030_price_accuracy_tiered_refresh.sql).
- **Scope — only the near horizon.** Most events are never priced, by design. The funnel, as of
  2026-07-30:

  | stage | count | dropped because |
  |---|---|---|
  | upcoming in `events_master` | 2,407 | — |
  | decider says `send` | 179 | `too_early` / `no_history` / `cooldown` / `nearly_full` |
  | within `price_window_days` (20) | **127** | a price 3 months out will have moved by send time |

  So an empty Cheapest column usually means "not in range yet", not a failure. It also explains
  why every priced game is MLB: NFL opens 9/9 and NHL 9/29, both outside a 20-day window, so
  **0** of their 1,608 upcoming games are in range. They start pricing themselves in mid-August
  as their openers come within the window — expect per-run cost to roughly double then.
- **Listing URL:** `price_url` holds the page the price was read from, and the Cheapest cell on
  Campaigns and Queue links through it. The column existed from migration `025` but nothing wrote
  it until migration [`039`](../migrations/039_set_event_prices_store_url.sql) — the prompt only
  returned `source`, a site *name*. `cleanPriceUrl()` keeps absolute http(s) URLs only and
  rejects non-ASCII or whitespace in the path: a real run returned a SeatGeek link with "Oriole
  Park" garbled into Tamil script, well-formed and 404ing. A broken link under a price is worse
  than none — it invites verification against nothing. A null URL never clears a stored one.
- **All leagues.** The write used to pass `p_league:'mlb'` into a function filtering on league, so
  an NFL/NHL price would be looked up, *paid for*, and silently discarded — `priced` counted it,
  `written` never did. Migration [`038`](../migrations/038_set_event_prices_all_leagues.sql) adds
  `set_event_prices(p_rows)` matching on `external_id` (globally unique) and taking the league
  from the row it updates. Masked until NFL/NHL enter the window; it would have burned money then.
- **Cheap games and URLs.** A game under `price_skip_below` is never repriced (the price is as good
  as it gets), which also meant one priced before URL capture could never *acquire* a link. Such a
  game is now let through exactly while `price_url is null`; once it has one, the skip resumes.
- **Cadence (tiered):** near-term games (≤3 days) refresh every 12h, far games 48h. Cron runs
  every 12h; per-game freshness picks the tier. Knobs on `decider_rules`: `price_stale_hours`,
  `price_stale_hours_near`, `price_near_days`, `price_window_days`, `price_skip_below`.
- **Accuracy finding (AI-845):** stored prices ran ~20-25% high = **staleness**, not fees (a
  fresh pull of the flagged game = live price; a fee bug would keep it high). Fix = tiered cadence
  above + price history to measure decay.
- **Agent:** the Campaign Agent (`api/chat.js`) answers price questions via `get_event_price`
  (cache-first from `events_master`, one grounded lookup on a miss, writes back).
- **Manual "Refresh prices" (Campaigns tab).** Same job, run on demand. `force=1` bypasses the run
  cooldown **and** the per-game freshness/cheap skips: pressing refresh reprices *every* game in
  the window, not the subset the cron considers due — a button that silently skips 100 of 127
  games is not what the word means. Those skips still apply in full to the cron, which is what
  they were for. The cost guard is therefore up front, not a refusal afterwards: `?estimate=1`
  returns the game count, batch count, estimated cost and `window_days` **without calling the
  model** (free, writes nothing, logs nothing), and the confirm dialog quotes it — *"Refresh
  prices for 127 games? … roughly $0.77"*. Cancelling costs nothing. The `i` tooltip reads
  `price_window_days` live so it never hardcodes the horizon.

## 5. Cron & ops

- Crons in [`vercel.json`](../vercel.json). **price-refresh** and **schedule-refresh** gate on a
  dedicated `PRICE_CRON_SECRET` (query token or Bearer), **isolated** from the shared `CRON_SECRET`
  so enabling them never wakes the other crons. Unset ⇒ endpoint open + a 6h cooldown caps cost.
- **Health:** `price_refresh_health()` — last run age + `ok` flag (answers "is the cron blocked?").
  `last_priced=0` + `last_cost=0` = ran-but-got-nothing (e.g. Gemini capped).
- Run logs: `events_master_price_runs` (cost/duration per cycle), `events_master_schedule_runs`
  (games added per refresh), `events_master_price_history` (every price pull).

## 6. Open items

- ~~**🚑 Gemini spend cap**~~ — resolved. Pricing runs again: 2026-07-30 runs of 127 and 27 games
  completed and billed ($0.844 / $0.283). Left here as history; delete when Phase 2 lands.
- **AI-827 accuracy spot-check:** confirm exact $ vs live StubHub/SeatGeek by hand (coverage
  proven, exact number not).
- **AI-845 Phase 2 (spike):** lower-level (100-level) + VIP price capture — 3-tier grounded prompt
  or ticket-site MCPs. Waits on the Gemini cap.
- **NBA:** load when the schedule releases (~mid-August) via `load-schedule.js --league nba`.
- **Unresolved-team markets:** define markets for the flagged NHL/NFL teams if worth targeting.
- **Canada UI:** surface Canadian NHL markets in `event_targets`/UI now that NHL games are loaded.
