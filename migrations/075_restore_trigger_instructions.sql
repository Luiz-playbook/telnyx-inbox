-- 075: put trigger_instructions back on the queue, after 058 took it off.
--
-- WHAT HAPPENED
--
-- Migration 058 (partly-sent blasts) was written before 071 and carries its own
-- drop + recreate of get_campaign_queue. It was applied on 2026-09-16, AFTER 071 — so its copy
-- of the function, which knows nothing about trigger_instructions, replaced the one that did.
--
-- The COLUMN was never touched. campaign_queue.trigger_instructions still exists and
-- queue_enqueue_test is still writing to it, so nothing was lost: the operator's Trigger Blast
-- instruction has been recorded on every row all along. It just stopped being READABLE, and the
-- "Queued from instruction" line vanished from the Queue with no error anywhere.
--
-- 071 predicted this in its own header, word for word:
--
--     If 058 is ever applied, it must be applied BEFORE this one, and this function re-derived
--     from it; otherwise 058's drop+recreate will silently drop trigger_instructions back off
--     the queue.
--
-- THE REAL LESSON IS THE ORDERING, not this file. Migrations here are numbered but not tracked,
-- so nothing enforces that 058 cannot run after 074, and three separate files
-- (058/060/071) each carry a full copy of get_campaign_queue. Whichever ran last wins, and it
-- wins silently. 059 and 060 both carry notes about the same trap from the other direction.
-- Until there is a migrations table recording what has run, every file that redefines this
-- function has to be read against the LIVE definition before it is applied, not against its
-- number.
--
-- THIS FILE IS 058's VERSION, VERBATIM, PLUS trigger_instructions — so applying it keeps
-- everything 058 added (send_failures, and the 'partial' status freezing reach like 'sent'
-- does) and restores what it removed. Verified against the live function's returned columns
-- immediately after 058 was applied: send_failures present, trigger_instructions gone.

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
  send_failures text, trigger_instructions text
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
    em.price_source,
    em.priced_at,
    em.price_seats,
    em.price_currency,
    case when q.status in ('sent','partial') then q.email_count else msc.email_count::int end as segment_email_count,
    case when q.status in ('sent','partial') then q.phone_count else msc.phone_count::int end as segment_phone_count,
    q.send_failures,
    -- Restored here. 058 predates 071 and its drop+recreate took this column off the
    -- function while leaving it on the table, so the value was still being written and
    -- simply stopped being readable.
    q.trigger_instructions
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
