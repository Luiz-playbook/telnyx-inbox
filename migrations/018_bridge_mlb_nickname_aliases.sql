-- MLB nickname aliases for market_bridge_team (AI-826 follow-up).
--
-- The MLB StatsAPI reports team nicknames (teamName) that differ from the strings the
-- bridge was seeded with: 'd-backs' vs 'diamondbacks', 'marlins' vs 'miami marlins',
-- plus flagship teams that were simply never added ('yankees','white sox','red sox',
-- 'dodgers','giants'). Without these, events_master rows for those teams resolved to a
-- null market and could not be targeted. Each alias points at a market_key that already
-- exists in market_state.
--
-- Two are deliberate, reversible calls (not vocabulary — market definition):
--   'blue jays' -> toronto     : Canadian market (see AI-829). toronto already exists (ON).
--   'athletics' -> sacramento  : the A's current home post-Oakland relocation. Revisit if
--                                the franchise's market changes again.
--
-- Idempotent. Safe to re-run.

insert into public.market_bridge_team (team_lc, market_key)
select v.team_lc, v.market_key from (values
  ('yankees',   'new_york'),
  ('white sox', 'chicago'),
  ('red sox',   'boston'),
  ('dodgers',   'los_angeles'),
  ('d-backs',   'phoenix'),
  ('marlins',   'miami'),
  ('giants',    'san_francisco'),
  ('blue jays', 'toronto'),
  ('athletics', 'sacramento')
) as v(team_lc, market_key)
where not exists (
  select 1 from public.market_bridge_team b where b.team_lc = v.team_lc
);

-- Backfill any events_master rows loaded before the aliases existed.
update public.events_master e
set market_code = tb.market_key,
    state_code  = ms.state_code
from public.market_bridge_team tb
left join public.market_state ms on ms.market_key = tb.market_key
where e.market_code is null
  and tb.team_lc = e.team;
