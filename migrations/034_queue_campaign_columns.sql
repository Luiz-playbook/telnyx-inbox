-- Queue rows carry the same campaign facts the Campaigns tab shows, and the state filter
-- gets a full region list.
--
-- 1. geo_regions() — every market we can target, not just the ones with an event on the
--    board. The Campaigns state filter was built from the loaded event rows, so it listed
--    a handful of states. Josh expects all 50 US states (plus DC), Canada listed separately,
--    and the test market kept apart from both.
--
-- 2. get_campaign_queue() — the Queue table showed a title and two counts; everything else
--    a queued blast inherits from its event (sport, league, event date, metro, country) was
--    only visible on the Campaigns tab. Those columns are read from events_master via the
--    row's event_id, so a placeholder with no event still renders (nulls, not a dropped row).
--    Segment is deliberately absent: campaign_queue targets a market, not a market×segment,
--    so a queue row has no single segment to report.

create or replace function public.geo_regions()
returns table(code text, name text, country text)
language sql
stable security definer
set search_path to 'public'
as $function$
  select r.code, r.name, r.country
  from public.geo_region r
  order by r.country, r.name;
$function$;

grant execute on function public.geo_regions() to anon, authenticated, service_role;

drop function if exists public.get_campaign_queue();

create or replace function public.get_campaign_queue()
returns table(
  id uuid, title text, state_code text, state_name text, event_id uuid,
  email boolean, sms boolean, phone_count integer, sms_count integer, ticket_price numeric,
  email_copy text, sms_copy text, scheduled_for timestamptz, status text, confirmed_at timestamptz,
  snooze_count integer, sent_at timestamptz, is_placeholder boolean, created_at timestamptz,
  email_from text, sms_from text, email_count integer, team text, opponent text,
  event_date date, league text, sport text, venue text, market_key text, country text,
  ticket_url text
)
language sql
stable security definer
set search_path to 'public'
as $function$
  select
    q.id, q.title, q.state_code, q.state_name, q.event_id,
    q.email, q.sms,
    case when q.status = 'sent' then q.phone_count
         else coalesce(mc.phone_count::int, q.phone_count) end as phone_count,
    case when q.status = 'sent' then q.sms_count
         else coalesce(mc.phone_count::int, q.sms_count) end   as sms_count,
    coalesce(q.ticket_price, em.best_price) as ticket_price,   -- stored snapshot, else live best_price
    q.email_copy, q.sms_copy, q.scheduled_for, q.status, q.confirmed_at,
    q.snooze_count, q.sent_at, q.is_placeholder, q.created_at,
    q.email_from, q.sms_from,
    case when q.status = 'sent' then q.email_count
         else coalesce(mc.email_count::int, q.email_count) end as email_count,
    q.team, q.opponent,
    -- Campaign facts, same derivation as event_targets() so both tabs read identically.
    em.event_date,
    upper(em.league) as league,
    case lower(em.league)
      when 'mlb' then 'Baseball'
      when 'nba' then 'Basketball'
      when 'nhl' then 'Ice Hockey'
      when 'nfl' then 'Football'
      else initcap(em.league)
    end as sport,
    em.venue,
    em.market_code as market_key,
    gr.country,
    em.price_url as ticket_url
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role;
