-- League-aware market resolution for shared team nicknames.
--
-- market_bridge_team is keyed on nickname alone, so cross-league nickname collisions
-- resolve wrong: MLB's Texas Rangers own 'rangers' -> dallas, so NHL's New York Rangers
-- games were mis-assigned to Dallas. Same trap awaits jets (NFL NY vs NHL Winnipeg),
-- kings (NBA Sacramento vs NHL LA), panthers (NFL Carolina vs NHL Florida), etc. as more
-- leagues load.
--
-- Fix: a league-scoped override table, consulted BEFORE the league-blind bridge. Only
-- collisions need a row here; everything else keeps resolving through market_bridge_team.

create table if not exists public.market_bridge_team_league (
  league     text not null,
  team_lc    text not null,
  market_key text not null,
  primary key (league, team_lc)
);
grant all on public.market_bridge_team_league to anon, authenticated, service_role;
alter table public.market_bridge_team_league enable row level security;
drop policy if exists mbtl_anon_read on public.market_bridge_team_league;
create policy mbtl_anon_read on public.market_bridge_team_league for select to anon using (true);

-- known collisions (extend as NBA/NFL load)
insert into public.market_bridge_team_league (league, team_lc, market_key) values
  ('nhl', 'rangers', 'new_york')      -- NHL NY Rangers (MLB 'rangers' -> dallas stays)
on conflict (league, team_lc) do nothing;

-- upsert_events_master, now league-aware: override first, blind bridge as fallback.
drop function if exists public.upsert_events_master(jsonb);
create or replace function public.upsert_events_master(p_rows jsonb)
returns table(out_id uuid, out_inserted boolean, out_team text, out_opponent text, out_date date, out_market text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
  v_league text;
  v_team text;
  v_market text;
  v_state text;
  v_id uuid;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    v_league := lower(btrim(r->>'league'));
    v_team := lower(btrim(r->>'team'));

    -- league-aware override wins; else fall back to the league-blind bridge
    select bl.market_key into v_market
      from market_bridge_team_league bl
     where bl.league = v_league and bl.team_lc = v_team
     limit 1;
    if v_market is null then
      select tb.market_key into v_market
        from market_bridge_team tb
       where tb.team_lc = v_team
       limit 1;
    end if;
    select ms.state_code into v_state from market_state ms where ms.market_key = v_market limit 1;

    insert into public.events_master
      (league, team, team_full, opponent, event_date, event_time, venue, home_away,
       market_code, state_code, external_id, source_url, source_note, season)
    values (
      v_league, v_team, nullif(r->>'team_full',''), btrim(r->>'opponent'),
      (r->>'event_date')::date, (nullif(r->>'event_time',''))::time, nullif(r->>'venue',''),
      coalesce(nullif(r->>'home_away',''), 'home'), v_market, v_state,
      nullif(r->>'external_id',''), r->>'source_url', nullif(r->>'source_note',''), r->>'season'
    )
    on conflict (league, team, opponent, event_date) do nothing
    returning id into v_id;

    return query select v_id, (v_id is not null), v_team, btrim(r->>'opponent'), (r->>'event_date')::date, v_market;
  end loop;
end;
$function$;
grant execute on function public.upsert_events_master(jsonb) to anon, authenticated, service_role;

-- fix the rows already loaded with the wrong market
update public.events_master e
set market_code = bl.market_key,
    state_code  = (select ms.state_code from public.market_state ms where ms.market_key = bl.market_key)
from public.market_bridge_team_league bl
where e.league = bl.league and e.team = bl.team_lc
  and e.market_code is distinct from bl.market_key;
