-- 056: per-segment reach on the queue.
--
-- WHY
--
-- get_campaign_queue() has always resolved a row's reach through market_counts, which is
-- keyed on market code alone:
--
--   left join public.market_counts mc on mc.code = q.state_code
--
-- A queued blast, since migration 050, targets a market AND a segment. So a row aimed at
-- TX / ICP has been displaying the contact counts for the WHOLE of Texas. The number is not
-- merely imprecise — it points the wrong way: a segment with no contacts at all shows a
-- healthy market total, and the operator sees a blast that looks ready to send to thousands
-- of people it will in fact reach none of. api/queue-tick.js resolves recipients through
-- market_emails / market_phones WITH the segment, so the send has always been correct; only
-- the number on screen was not.
--
-- WHY NOT JUST FIX THE EXISTING JOIN
--
-- Migration 050 considered and rejected re-keying market_counts on (code, segment): that view
-- is joined on code alone here, so one row per code x segment would fan out three-to-one and
-- silently triple every row in the queue. It created market_segment_counts as a separate view
-- instead. That view is what this migration finally joins.
--
-- The join here CANNOT fan out, because it is on the full key of that view — (code, segment)
-- is its GROUP BY, so at most one row matches.
--
-- SEGMENT NULL MEANS "THE WHOLE MARKET"
--
-- A row with no segment targets every segment, which is what every row queued before 050 is.
-- market_segment_counts has no NULL segment (it coalesces to 'Other'), so such a row matches
-- nothing here and both new columns come back NULL. That is the correct answer, not a gap:
-- there is no single segment figure for a row that targets all of them, and the caller should
-- keep using email_count / phone_count for those. Deciding that in SQL by summing the segments
-- would just reproduce market_counts with extra steps.
--
-- ADDITIVE, NOT A REPLACEMENT
--
-- email_count / phone_count keep their present meaning and their present values. Two columns
-- are added beside them. Nothing that reads this function today changes behaviour, and the UI
-- chooses per row which pair to show.

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

-- ---------------------------------------------------------------------------
-- GRANTS — restored exactly as they were. Read this before "tidying" it.
-- ---------------------------------------------------------------------------
--
-- Dropping a function drops its ACL, and CREATE FUNCTION then grants EXECUTE to PUBLIC by
-- default. PUBLIC includes anon. So a migration that recreates a function and grants only the
-- roles it believes in still leaves the function callable by the published anon key — the
-- grant is simply invisible unless you look for the empty grantee in proacl (`=X/postgres`).
--
-- The pre-change ACL on this function was:
--   {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres,
--    service_role=X/postgres, readonly_preview=X/postgres}
-- i.e. PUBLIC *and* anon, both still open — 052 has NOT been applied yet.
--
-- This migration therefore reproduces that set verbatim. It is a reach-columns change and must
-- not move the security line in either direction:
--
--   * Tightening here would break the OpenClaw VPS, which still authenticates with the anon key
--     (052's own pre-flight, item 2, records that as NOT DONE and owned by another developer).
--     Its daily-campaign-queue cron reads this exact function.
--   * Silently leaving the default PUBLIC grant would be the trap above — closing anon in 052
--     while PUBLIC quietly keeps the door open.
--
-- When 052 is applied, it must revoke from PUBLIC as well as anon, for this function and every
-- other one it names. Revoking anon alone changes nothing while the PUBLIC grant stands.
grant execute on function public.get_campaign_queue() to public, anon, authenticated, service_role, readonly_preview;
