-- AI-940 follow-up: college football as its own league.
--
-- CFB games are loaded by scripts/load-schedule.js --league cfb, from CollegeFootballData
-- (FBS home games, neutral-site excluded — the same shape the NFL loader uses). 877 games
-- across 138 teams for 2026; 540 of them resolve to a market, the other 337 are in states with
-- no contacts yet and load with market_code null, so they are visible but not blastable.
--
-- The only schema change needed is the league -> sport mapping. Both functions that expose
-- `sport` carry the same CASE, and its fallback is initcap(league) — so without this, CFB rows
-- report sport "Cfb", which appears in the Sport filter as a second football-shaped option and
-- splits one sport in two. league already separates them, which is what the ticket asked for.
--
-- Bodies below are lifted verbatim from the migrations that last defined each function (055 for
-- event_targets, 058 for get_campaign_queue) with one CASE branch added. Nothing else changes.
--
-- The market_bridge_team rows for the 85 mappable teams are DATA, not schema, and were written
-- separately; they are listed in the run log for 2026-08-27.

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

-- 033 granted this to anon only, and 052 left it off the revoke list, so the Campaigns tab
-- still reads it with the published key (ui/index.html fetchAllEvents). Re-granting all three
-- keeps that working and lets a signed-in session read it too, which is what the editor needs.
-- Left open to PUBLIC deliberately, unlike the write above: this is a read the tab already
-- performs anonymously today, and closing it here would take the Campaigns table down.
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
  segment_email_count integer, segment_phone_count integer,
  send_failures text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    q.id, q.title, q.state_code, q.state_name, q.event_id,
    q.email, q.sms,
    case when q.status in ('sent','partial') then q.phone_count
         else coalesce(mc.phone_count::int, q.phone_count) end as phone_count,
    case when q.status in ('sent','partial') then q.sms_count
         else coalesce(mc.phone_count::int, q.sms_count) end   as sms_count,
    coalesce(q.ticket_price, em.best_price) as ticket_price,
    q.email_copy, q.sms_copy, q.scheduled_for, q.status, q.confirmed_at,
    q.snooze_count, q.sent_at, q.is_placeholder, q.created_at,
    q.email_from, q.sms_from,
    case when q.status in ('sent','partial') then q.email_count
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
    em.price_source,
    em.priced_at,
    em.price_seats,
    em.price_currency,
    case when q.status in ('sent','partial') then q.email_count else msc.email_count::int end as segment_email_count,
    case when q.status in ('sent','partial') then q.phone_count else msc.phone_count::int end as segment_phone_count,
    q.send_failures
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  left join public.market_segment_counts msc
         on msc.code = q.state_code and msc.segment = q.segment
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

-- Reproduced verbatim from 056. Do not "tidy" this — see 056's closing note for why PUBLIC
-- appears here and what must happen to it when 052 is applied.
grant execute on function public.get_campaign_queue() to public, anon, authenticated, service_role, readonly_preview;
