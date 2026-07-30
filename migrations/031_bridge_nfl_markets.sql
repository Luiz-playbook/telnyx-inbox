-- AI-844: NFL market resolution — aliases + league-aware collision overrides.
--
-- NFL games load from nflverse (see scripts/load-schedule.js loadNFL). Team nicknames map
-- to markets here. Four nicknames collide with other leagues and MUST use the league-aware
-- override (028), or they resolve to the wrong market:
--   cardinals (MLB St. Louis -> NFL Arizona), giants (MLB SF -> NFL NY),
--   jets (NHL Winnipeg -> NFL NY), panthers (NHL Florida -> NFL Carolina).
--
-- No market defined yet (rows kept + flagged): colts (Indianapolis), jaguars
-- (Jacksonville), packers (Green Bay), raiders (Las Vegas), titans (Nashville).
-- Idempotent.

-- 1. collision overrides (league-scoped, win over the blind bridge)
insert into public.market_bridge_team_league (league, team_lc, market_key) values
  ('nfl','cardinals','phoenix'),
  ('nfl','giants','new_york'),
  ('nfl','jets','new_york'),
  ('nfl','panthers','north_carolina')
on conflict (league, team_lc) do nothing;

-- 2. plain nickname aliases (no collision; market already exists)
insert into public.market_bridge_team (team_lc, market_key)
select v.team_lc, v.market_key from (values
  ('49ers','san_francisco'), ('bears','chicago'), ('bengals','cincinnati'),
  ('bills','buffalo'), ('broncos','denver'), ('browns','cleveland'),
  ('buccaneers','tampa_bay'), ('chargers','los_angeles'), ('chiefs','kansas_city'),
  ('commanders','washington_dc'), ('cowboys','dallas'), ('dolphins','miami'),
  ('eagles','philadelphia'), ('falcons','atlanta'), ('lions','detroit'),
  ('patriots','boston'), ('rams','los_angeles'), ('ravens','baltimore'),
  ('saints','new_orleans'), ('seahawks','seattle'), ('steelers','pittsburgh'),
  ('texans','houston'), ('vikings','minnesota')
) as v(team_lc, market_key)
where not exists (select 1 from public.market_bridge_team b where b.team_lc = v.team_lc);

-- 3a. backfill collisions -> league override (fixes the wrong blind values)
update public.events_master e
set market_code = bl.market_key,
    state_code  = (select ms.state_code from public.market_state ms where ms.market_key = bl.market_key)
from public.market_bridge_team_league bl
where e.league = 'nfl' and e.team = bl.team_lc and bl.league = 'nfl'
  and e.market_code is distinct from bl.market_key;

-- 3b. backfill new aliases -> blind bridge (fills the nulls)
update public.events_master e
set market_code = tb.market_key,
    state_code  = ms.state_code
from public.market_bridge_team tb
left join public.market_state ms on ms.market_key = tb.market_key
where e.league = 'nfl' and e.market_code is null and tb.team_lc = e.team;
