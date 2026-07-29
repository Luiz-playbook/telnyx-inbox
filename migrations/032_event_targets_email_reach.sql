-- Email reach on the Campaigns by Event table (Josh: emails and phone numbers, everywhere
-- we show an audience — the Queue got this in migration 031, this is the same fix upstream).
--
-- state_summary() already pulled phone_count off market_counts but ignored email_count, so
-- Campaigns by Event could tell you how many numbers a market had and nothing about how many
-- addresses. Both counts now travel together, through state_summary() into event_targets().
--
-- Return types change (a new column), so both functions are dropped and rebuilt. Bodies are
-- otherwise identical to 025 / the live definitions.

drop function if exists public.event_targets();
drop function if exists public.state_summary();

create function public.state_summary()
returns table(code text, name text, country text, companies bigint, emails bigint, phones bigint, icp bigint, scp bigint, other bigint)
language sql
stable security definer
set search_path to 'public'
as $function$
  with base as (
    select r.code, r.name, r.country, lower(btrim(ci.lead_segment)) as seg
    from company_intel ci
    join geo_alias a  on a.alias = upper(btrim(ci.state))
    join geo_region r on r.code  = a.code
    where ci.state is not null and btrim(ci.state) <> ''
  )
  select b.code, b.name, b.country,
         count(*)::bigint                                                   as companies,
         coalesce(max(mc.email_count), 0)::bigint                           as emails,
         coalesce(max(mc.phone_count), 0)::bigint                           as phones,
         count(*) filter (where b.seg = 'icp')::bigint                      as icp,
         count(*) filter (where b.seg = 'scp')::bigint                      as scp,
         count(*) filter (where b.seg is null or b.seg not in ('icp','scp'))::bigint as other
  from base b
  left join market_counts mc on mc.code = b.code
  group by b.code, b.name, b.country
  order by companies desc, b.name;
$function$;

grant execute on function public.state_summary() to anon, authenticated, service_role;

create function public.event_targets()
returns table(
  event_id text, team text, opponent text, event_date date, ticket_price numeric, ticket_url text,
  league text, sport text, venue text, market_key text, state_code text, state_name text, country text,
  companies bigint, emails bigint, phones bigint, icp bigint, scp bigint, other bigint
)
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
    s.companies, s.emails, s.phones, s.icp, s.scp, s.other
  from events_master em
  left join geo_region gr on gr.code = em.state_code
  left join ss s on s.code = em.state_code
  where em.event_date >= current_date
  order by em.event_date asc, em.team;
$function$;

grant execute on function public.event_targets() to anon;
