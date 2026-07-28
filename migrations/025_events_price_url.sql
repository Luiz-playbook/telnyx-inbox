-- Add a source URL for the ticket price so the UI can make the price clickable
-- (redirect to the resale listing). event_targets() now returns it as ticket_url.
alter table public.events_master add column if not exists price_url text;

drop function if exists public.event_targets();

create function public.event_targets()
 returns table(event_id text, team text, opponent text, event_date date, ticket_price numeric,
               ticket_url text, league text, sport text, venue text, market_key text, state_code text,
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
    em.price_url,
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

grant execute on function public.event_targets() to anon;
