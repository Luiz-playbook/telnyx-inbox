-- One row per (event × segment) on Campaigns by Event.
--
-- Josh sends different copy to ICP, SCP and everyone else, so a market is really three
-- audiences, not one. The table used to squash them into three count columns on a single
-- row, which meant reach (emails / phone numbers) could only ever be stated for the market
-- as a whole. Each event now yields three rows — ICP, SCP, Other, in that order — and every
-- count on the row belongs to that segment alone.
--
-- Segment reach comes from market_contacts joined to company_intel on organization name
-- (24,237 of 24,499 contacts match, ~99%). A contact whose company isn't in company_intel,
-- or whose lead_segment is neither icp nor scp, counts as Other — so no contact is lost and
-- the three rows always sum to the market total. company_intel is de-duplicated by name
-- first (most recently updated row wins), or a company listed twice would double its
-- contacts' counts.

create or replace function public.state_segment_summary()
returns table(code text, name text, country text, segment text, companies bigint, emails bigint, phones bigint)
language sql
stable security definer
set search_path to 'public'
as $function$
  with segs as (
    select unnest(array['ICP','SCP','Other']) as segment
  ),
  -- one segment per company name, newest row wins
  ci_seg as (
    select distinct on (lower(btrim(ci.organization_name)))
           lower(btrim(ci.organization_name)) as org_lc,
           case lower(btrim(ci.lead_segment)) when 'icp' then 'ICP' when 'scp' then 'SCP' else 'Other' end as segment
    from company_intel ci
    where ci.organization_name is not null and btrim(ci.organization_name) <> ''
    order by lower(btrim(ci.organization_name)), ci.updated_at desc nulls last
  ),
  -- companies per state per segment (same source as the old state_summary)
  comp as (
    select r.code, r.name, r.country,
           case lower(btrim(ci.lead_segment)) when 'icp' then 'ICP' when 'scp' then 'SCP' else 'Other' end as segment,
           count(*)::bigint as companies
    from company_intel ci
    join geo_alias a  on a.alias = upper(btrim(ci.state))
    join geo_region r on r.code  = a.code
    where ci.state is not null and btrim(ci.state) <> ''
    group by 1, 2, 3, 4
  ),
  -- contactable reach per state per segment
  reach as (
    select mc.code,
           coalesce(cs.segment, 'Other') as segment,
           count(*) filter (where mc.email is not null)::bigint as emails,
           count(*) filter (where mc.phone is not null)::bigint as phones
    from market_contacts mc
    left join ci_seg cs on cs.org_lc = lower(btrim(mc.organization_name))
    group by 1, 2
  ),
  codes as (
    select code, max(name) as name, max(country) as country from comp group by code
    union
    select r.code, max(gr.name), max(gr.country)
    from reach r left join geo_region gr on gr.code = r.code group by r.code
  )
  select
    k.code, max(k.name), max(k.country), s.segment,
    coalesce(max(c.companies), 0)::bigint,
    coalesce(max(x.emails), 0)::bigint,
    coalesce(max(x.phones), 0)::bigint
  from codes k
  cross join segs s
  left join comp  c on c.code = k.code and c.segment = s.segment
  left join reach x on x.code = k.code and x.segment = s.segment
  group by k.code, s.segment;
$function$;

grant execute on function public.state_segment_summary() to anon, authenticated, service_role;

drop function if exists public.event_targets();

create function public.event_targets()
returns table(
  event_id text, team text, opponent text, event_date date, ticket_price numeric, ticket_url text,
  league text, sport text, venue text, market_key text, state_code text, state_name text, country text,
  segment text, companies bigint, emails bigint, phones bigint
)
language sql
stable security definer
set search_path to 'public'
as $function$
  with ss as (select * from state_segment_summary())
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
    s.segment, s.companies, s.emails, s.phones
  from events_master em
  left join geo_region gr on gr.code = em.state_code
  left join ss s on s.code = em.state_code
  where em.event_date >= current_date
  order by em.event_date asc, em.team,
           case s.segment when 'ICP' then 1 when 'SCP' then 2 else 3 end;
$function$;

grant execute on function public.event_targets() to anon;
