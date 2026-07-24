# Market History & AI Decider — Data Provenance

How the **Market History** tab and the **AI Decider** get their numbers, which
Supabase tables feed them, and how two inconsistent naming schemes were made to
line up. Everything lives in the `snfmggrnyjayuuxafats` project.

---

## 1. Source tables (the raw truth)

| Table | Role | Key columns used |
|---|---|---|
| `blast_templates` | **The training data.** 140 historical email blasts imported from the "historical ticket blasts" sheet. Every row has real send volume + engagement. | `list_name` (market), `name` (template name), `sent_emails`, `open_rate`, `click_rate`, `clickthru_rate`, `bounce_rate`, `unsubscribe_rate`, `scheduled_for` (send timestamp), `email_template` |
| `icp_events` | **What we decide over.** Upcoming games/events. | `team_name`, `opponent`, `event_date`, `event_time`, `filled_pct` |
| `campaign_send_log` | **Send memory.** One row per logged decision, used for cooldown/fatigue. | `event_id`, `run_date`, `decision`, `template_name` |
| `decider_rules` | **Cole Rules.** Single-row settings the decider reads. | `cooldown_floor_days`, `forward_window_days`, `optout_ceiling_pct`, `cross_strategy_fatigue_days` |

Nothing about performance is invented — `open_rate`, `clickthru_rate`, etc. are
columns that came in with the blast export.

---

## 2. The coherence problem

The two tables that must be joined **don't name markets the same way**:

- `icp_events.team_name` is a **team nickname**: `Reds`, `Lakers`, `NY Rangers`,
  `KC Royals`, `University of Michigan` — and it's dirty (case variants like
  `kc royals` vs `KC Royals`, typos like `Mitchigan`).
- `blast_templates.list_name` is a **metro / state / team label**: `Cincinatti`,
  `Yankees New York City`, `Georgia`, `Washington DC & DMV`, `Red Sox`.

There is no shared key. A blast for "Cincinatti" and an upcoming "Reds" game are
the same market to a human, but nothing in the data says so.

### The fix: a canonical `market_key`

Two small hand-authored bridge tables map **both** sides down to one slug
(the metro), e.g. `cincinnati`, `new_york`, `los_angeles`:

| Bridge table | Maps | Example rows |
|---|---|---|
| `market_bridge_team` | `lower(team_name)` → `market_key` | `reds → cincinnati`, `lakers → los_angeles`, `orioles → baltimore`, `university of michigan → detroit` |
| `market_bridge_list` | `list_name` → `market_key` | `Cincinatti → cincinnati`, `Yankees New York City → new_york`, `Georgia → atlanta`, `Washington State → seattle` |

Once both sides carry `market_key`, they join cleanly. Junk lists (e.g.
`EZ Facility Sportsplex`) are mapped to `other` and excluded.

**Deliberate looseness** (documented, not accidental):
- State-level lists collapse to the main metro (`Pennsylvania → philadelphia`,
  `Ohio → cleveland`), so a same-state team can inherit a nearby city's history.
- Chicago teams (Bulls/Cubs/Blackhawks) map to `chicago`, but there is **no
  Chicago blast** in the data → they correctly fall through to "no history".
- Ambiguous `Rangers` is treated as the Texas Rangers (`dallas`); `NY Rangers`
  is separate.

---

## 3. The scoring layer (SQL views = the "trained model")

All scoring is in SQL so the **UI and the daily cron read the exact same
numbers** — one source of truth, no drift.

```
blast_templates ──(market_bridge_list)──► v_blast_scored
                                             │
        ┌────────────────────┬───────────────┼────────────────────┐
        ▼                    ▼               ▼                     ▼
v_market_performance  v_market_best_template  v_market_best_dow   (perf_score)
```

- **`v_blast_scored`** — every blast joined to its `market_key`, plus a
  `perf_score = 0.7 · clickthru_rate + 0.3 · open_rate` (rewards engagement
  quality first, reach second).
- **`v_market_performance`** — per-market rollup, **volume-weighted** so a
  50k-send blast counts more than a 500-send one:
  `open_rate_w = Σ(open_rate·sent) / Σ(sent)` (same for CTR / click rate),
  plus averaged bounce/unsub, blast count, total sent, last send.
- **`v_market_best_template`** — the single best template per market
  (`distinct on (market_key) … order by perf_score desc, sent_emails desc`).
- **`v_market_best_dow`** — the weekday (`0=Sun…6=Sat`) whose blasts summed the
  highest `perf_score`, i.e. the historically best send day.

---

## 4. What the tab actually calls

Two `SECURITY DEFINER` RPCs (granted to `anon`, so the static UI can call them
with just the public key):

- **`rpc_market_performance()`** → the **Market performance** table
  (market, #blasts, sent, open %, CTR %, best template, best day).
- **`rpc_event_recommendations()`** → the **AI Decider** table. For each
  upcoming `icp_events` row it resolves `team_name → market_key`, joins the
  performance model, and returns a **deterministic** decision:

  | reason_code | meaning |
  |---|---|
  | `ok` | send — market has history and isn't full/held |
  | `no_history` | skip — no comparable market blast to learn from |
  | `nearly_full` | skip — `filled_pct ≥ 90` |
  | `too_early` | hold — game is beyond the forward-looking window |
  | `cooldown` | hold — market was sent to inside the cooldown floor |

  It also emits warning flags: `optout_warning` (market unsub rate above the
  opt-out ceiling) and `fatigue_warning` (any send within the fatigue window).

The **Cole Rules** (`cooldown_floor_days`, `forward_window_days`,
`optout_ceiling_pct`, `cross_strategy_fatigue_days`) are read live from
`decider_rules`, so editing them recomputes every recommendation.

---

## 5. Metrics-first, LLM explains

The send/skip call and the chosen template are 100% computed in SQL. The LLM
(`api/decide.js`) is only asked to **write the one-sentence rationale** from the
numbers it's handed — it never changes the decision. Without an OpenAI key the
UI falls back to a templated sentence built from the same fields.

---

## 6. Verified output (2026-07-22)

- 140 blasts across **51 raw lists** → **36 markets with usable history** after
  bridging.
- **19 upcoming events → 15 send / 4 skip** (2 no-history, 2 nearly-full) before
  the forward-window rule; holds appear once far-out games exceed the window.
- Example learned rows: Boston = 16.1% open / 6.9% CTR over 5 blasts, best day
  Fri; New York = 15.8% open across 92.6k sent.

---

## 7. Refresh / maintenance

- The performance views are **live** over `blast_templates` — new blast rows
  show up automatically; no refresh needed.
- `market_contacts` (the per-market phone/email lists in Compose) is a **flat
  snapshot** — rebuild with `select refresh_market_contacts();` when
  `contact_intel` changes. (Separate from this doc's model, noted for context.)
- To correct a mis-mapped market, edit `market_bridge_team` /
  `market_bridge_list` — everything downstream recomputes.
