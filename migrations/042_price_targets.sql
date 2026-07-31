-- Games that need a resale-price lookup, selected in SQL so OpenClaw can own pricing end to end
-- without re-deriving the eligibility rules in a prompt. Mirrors what api/price-refresh.js used
-- to compute in JS:
--   games the decider says to 'send'  ∩  inside the price window  ∩  stale / never priced,
--   minus locked-in-cheap games that already carry a verify link.
-- Knobs come from decider_rules (id=1), tiered by how soon the game is (near-term prices decay
-- faster, so they use the shorter freshness window).
--
-- Each row also carries a precomputed `listing_url` (the SeatGeek team page). The price lookup
-- must NEVER fetch or invent a URL — asking a model for a link alongside the price wrecked price
-- accuracy (AI-845, see lib/price.js). The URL is derived here from the team name instead, and
-- the agent passes it straight through to set_event_prices.

create or replace function public.price_targets(p_limit integer default null)
returns table (
  ref          text,
  event_id     uuid,
  league       text,
  team         text,
  team_full    text,
  opponent     text,
  event_date   date,
  venue        text,
  state_code   text,
  best_price   numeric,
  priced_at    timestamptz,
  price_url    text,
  days_until   integer,
  listing_url  text
)
language sql
security definer
set search_path to 'public'
as $function$
  with k as (
    select
      coalesce(price_window_days, 20)     as win,
      coalesce(price_skip_below, 15)       as skip_below,
      coalesce(price_stale_hours, 48)      as stale,
      coalesce(price_stale_hours_near, 12) as stale_near,
      coalesce(price_near_days, 3)         as near_days
    from public.decider_rules where id = 1
  ),
  send as (
    select distinct event_id
    from public.rpc_event_recommendations()
    where decision = 'send'
  ),
  ev as (
    -- team_full slug matches the SeatGeek /<team>-tickets path shape ("Cleveland Guardians"
    -- -> "cleveland-guardians"); a single-word or empty name yields no hyphen and no URL.
    select e.*,
           trim(both '-' from lower(regexp_replace(coalesce(e.team_full, ''), '[^a-zA-Z0-9]+', '-', 'g'))) as team_slug
    from public.events_master e
  )
  select
    e.external_id                          as ref,
    e.id                                   as event_id,
    e.league, e.team, e.team_full, e.opponent,
    e.event_date, e.venue, e.state_code,
    e.best_price, e.priced_at, e.price_url,
    (e.event_date - current_date)          as days_until,
    case when position('-' in e.team_slug) > 0
         then 'https://seatgeek.com/' || e.team_slug || '-tickets'
         else null end                     as listing_url
  from send s
  join ev e on e.id = s.event_id
  cross join k
  where e.event_date >= current_date
    and e.event_date <= current_date + k.win
    -- locked-in cheap (already below the floor and already has a verify link) → leave it
    and not (e.best_price is not null and e.best_price < k.skip_below and e.price_url is not null)
    -- needs a price: never priced, or gone stale for its tier
    and (
      e.best_price is null
      or e.priced_at is null
      or e.priced_at < (now() - make_interval(hours =>
           case when (e.event_date - current_date) <= k.near_days then k.stale_near else k.stale end))
    )
  order by e.event_date
  limit p_limit;
$function$;

grant execute on function public.price_targets(integer) to anon, authenticated, service_role;
