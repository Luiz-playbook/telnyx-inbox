-- AI-826 follow-up: point event_targets() at events_master (the MLB StatsAPI load)
-- instead of the demo ticketblaster.sports_ticket (NBA/NHL seed data).
--
-- events_master already carries market_code + state_code (resolved at load via
-- market_bridge_team), so the old matchup-parsing + sports_team_state join is gone;
-- we join state contact counts straight on state_code. Output signature is unchanged,
-- so the Compose "Campaigns by event" table (cbs-rows) keeps working as-is.
--
-- sport is derived from league (all MLB = Baseball for now; NBA/NHL/NFL ready).
-- Upcoming games only (event_date >= today).

create or replace function public.event_targets()
 returns table(event_id text, team text, opponent text, event_date date, ticket_price numeric,
               league text, sport text, venue text, market_key text, state_code text,
               state_name text, country text, companies bigint, phones bigint,
               icp bigint, scp bigint, other bigint)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with ss as (select * from state_summary())
  select
    em.id::text,
    coalesce(em.team_full, initcap(em.team)),
    initcap(em.opponent),
    em.event_date,
    em.best_price,
    upper(em.league),
    case lower(em.league)
      when 'mlb' then 'Baseball'
      when 'nba' then 'Basketball'
      when 'nhl' then 'Ice Hockey'
      when 'nfl' then 'Football'
      else initcap(em.league)
    end,
    em.venue,
    em.market_code,
    em.state_code,
    coalesce(s.name, gr.name),
    coalesce(s.country, gr.country),
    s.companies, s.phones, s.icp, s.scp, s.other
  from events_master em
  left join geo_region gr on gr.code = em.state_code
  left join ss s on s.code = em.state_code
  where em.event_date >= current_date
  order by em.event_date asc, em.team;
$function$;
