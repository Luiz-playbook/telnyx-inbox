-- NHL nickname aliases for market_bridge_team (NHL load follow-up, mirrors 018 for MLB).
--
-- api-web.nhle.com reports team common names ('avalanche','maple leafs',...) that the
-- bridge didn't have. Each alias points at a market_key that already exists in
-- market_state. League-blind is correct for all of these under NHL; the one true
-- collision (NHL 'rangers') is handled by the league-aware override in 028.
--
-- Not aliased (no market defined; rows kept + flagged unassigned): blue jackets (Columbus),
-- golden knights (Las Vegas), predators (Nashville), sharks (San Jose). Add markets +
-- aliases when those become worth targeting.
--
-- Idempotent.

insert into public.market_bridge_team (team_lc, market_key)
select v.team_lc, v.market_key from (values
  ('avalanche','denver'), ('bruins','boston'), ('canadiens','montreal'),
  ('devils','new_york'), ('ducks','anaheim'), ('jets','winnipeg'),
  ('kings','los_angeles'), ('kraken','seattle'), ('lightning','tampa_bay'),
  ('mammoth','utah'), ('maple leafs','toronto'), ('oilers','edmonton'),
  ('panthers','miami'), ('stars','dallas'), ('wild','minnesota')
) as v(team_lc, market_key)
where not exists (select 1 from public.market_bridge_team b where b.team_lc = v.team_lc);

-- backfill any NHL rows loaded before the aliases existed
update public.events_master e
set market_code = tb.market_key,
    state_code  = ms.state_code
from public.market_bridge_team tb
left join public.market_state ms on ms.market_key = tb.market_key
where e.league = 'nhl' and e.market_code is null and tb.team_lc = e.team;
