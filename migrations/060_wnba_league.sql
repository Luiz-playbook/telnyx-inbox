-- WNBA as its own league.
--
-- Loaded by scripts/load-schedule.js --league wnba, via ESPN. The WNBA is NOT a variant of the
-- NBA — different teams, different arenas, a May-to-October season — so it is a separate league
-- sharing the sport "Basketball", exactly as CFB shares "Football" with the NFL.
--
-- Only the league -> sport mapping needs changing. Both functions exposing `sport` carry the
-- same CASE, whose fallback is initcap(league), so without this WNBA rows report sport "Wnba"
-- and the Sport filter grows a second basketball-shaped option.
--
-- Loaded from today forward rather than the whole season: of 337 games in 2026 only 30 were
-- still upcoming, the rest already played. Those 30 are the late-season and playoff games —
-- which is what was actually asked for. Come the 2027 season a full load would be ~340 mostly
-- ordinary games, and whether the WNBA is a full league or a marquee-only feed is a decision
-- for then.
--
-- BASED ON 059, WHICH IS APPLIED. Not on 058, which is committed and has never been run — that
-- mistake is what made 059's first attempt fail with "column q.send_failures does not exist".
-- Bodies are lifted verbatim from 059 with one CASE branch added; grants are carried because
-- dropping a function drops its ACL and CREATE FUNCTION then grants EXECUTE to PUBLIC.

drop function if exists public.event_targets();

create function public.event_targets()
returns table(
  event_id text, team text, opponent text, event_date date, ticket_price numeric, ticket_url text,
  league text, sport text, venue text, market_key text, state_code text, state_name text, country text,
  segment text, companies bigint, emails bigint, phones bigint,
  price_source text, priced_at timestamptz, price_seats smallint, price_currency text
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
      -- CFB is football played in a different competition, so it shares the SPORT and is
      -- separated by LEAGUE — which is how nhl/mlb/nfl already work. Without this branch the
      -- CASE falls through to initcap(league) and the Sport filter grows a bogus "Cfb"
      -- sitting next to "Football", splitting one sport across two filter options.
      when 'cfb' then 'Football'
      -- WNBA is its own league sharing the sport, exactly as CFB does with the NFL. Without
      -- this the CASE falls through to initcap(league) and the Sport filter gains a "Wnba"
      -- option beside "Basketball", splitting one sport in two.
      when 'wnba' then 'Basketball'
      else initcap(em.league)
    end,
    em.venue,
    em.market_code,
    em.state_code,
    coalesce(s.name, gr.name),
    coalesce(s.country, gr.country),
    s.segment, s.companies, s.emails, s.phones,
    em.price_source, em.priced_at, em.price_seats, em.price_currency
  from events_master em
  left join geo_region gr on gr.code = em.state_code
  left join ss s on s.code = em.state_code
  where em.event_date >= current_date
  order by em.event_date asc, em.team,
           case s.segment when 'ICP' then 1 when 'SCP' then 2 else 3 end;
$function$;

grant execute on function public.event_targets() to anon, authenticated, service_role;

drop function if exists public.get_campaign_queue();

create or replace function public.get_campaign_queue()
returns table (
  id uuid, title text, state_code text, state_name text, event_id uuid,
  email boolean, sms boolean, phone_count integer, sms_count integer,
  ticket_price numeric, email_copy text, sms_copy text,
  scheduled_for timestamptz, status text, confirmed_at timestamptz,
  snooze_count integer, sent_at timestamptz, is_placeholder boolean,
  created_at timestamptz, email_from text, sms_from text, email_count integer,
  team text, opponent text, event_date date, league text, sport text, venue text,
  market_key text, country text, ticket_url text, email_subject text,
  archived_at timestamptz, segment text, rejected_at timestamptz, reject_note text,
  price_source text, priced_at timestamptz, price_seats smallint, price_currency text,
  segment_email_count integer, segment_phone_count integer
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    q.id, q.title, q.state_code, q.state_name, q.event_id,
    q.email, q.sms,
    case when q.status = 'sent' then q.phone_count
         else coalesce(mc.phone_count::int, q.phone_count) end as phone_count,
    case when q.status = 'sent' then q.sms_count
         else coalesce(mc.phone_count::int, q.sms_count) end   as sms_count,
    coalesce(q.ticket_price, em.best_price) as ticket_price,
    q.email_copy, q.sms_copy, q.scheduled_for, q.status, q.confirmed_at,
    q.snooze_count, q.sent_at, q.is_placeholder, q.created_at,
    q.email_from, q.sms_from,
    case when q.status = 'sent' then q.email_count
         else coalesce(mc.email_count::int, q.email_count) end as email_count,
    coalesce(em.team_full, initcap(nullif(btrim(q.team), '')), q.team)      as team,
    coalesce(initcap(nullif(btrim(em.opponent), '')), q.opponent)           as opponent,
    em.event_date,
    upper(em.league) as league,
    case lower(em.league)
      when 'mlb' then 'Baseball'
      when 'nba' then 'Basketball'
      when 'nhl' then 'Ice Hockey'
      when 'nfl' then 'Football'
      -- CFB is football played in a different competition, so it shares the SPORT and is
      -- separated by LEAGUE — which is how nhl/mlb/nfl already work. Without this branch the
      -- CASE falls through to initcap(league) and the Sport filter grows a bogus "Cfb"
      -- sitting next to "Football", splitting one sport across two filter options.
      when 'cfb' then 'Football'
      -- WNBA is its own league sharing the sport, exactly as CFB does with the NFL. Without
      -- this the CASE falls through to initcap(league) and the Sport filter gains a "Wnba"
      -- option beside "Basketball", splitting one sport in two.
      when 'wnba' then 'Basketball'
      else initcap(em.league)
    end as sport,
    em.venue,
    em.market_code as market_key,
    gr.country,
    em.price_url as ticket_url,
    q.email_subject,
    q.archived_at,
    q.segment,
    q.rejected_at,
    q.reject_note,
    -- Price provenance. Only meaningful when ticket_price came from events_master: a row
    -- carrying its own overridden q.ticket_price is not what these describe, and the UI says so
    -- rather than attaching someone else's sourcing to a hand-typed number.
    em.price_source,
    em.priced_at,
    em.price_seats,
    em.price_currency,
    -- Reach for THIS row's segment. NULL on a whole-market row (see the header) and, like the
    -- market-level pair above, frozen at the snapshot once the row is sent — a sent blast
    -- should report who it actually reached, not who the market holds today.
    case when q.status = 'sent' then q.email_count else msc.email_count::int end as segment_email_count,
    case when q.status = 'sent' then q.phone_count else msc.phone_count::int end as segment_phone_count
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  -- On the view's full grouping key, so this matches at most one row and cannot fan out.
  left join public.market_segment_counts msc
         on msc.code = q.state_code and msc.segment = q.segment
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to public, anon, authenticated, service_role, readonly_preview;
