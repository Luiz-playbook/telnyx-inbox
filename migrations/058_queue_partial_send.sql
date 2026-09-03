-- 058: partly-sent blasts.
--
-- THE GAP THIS CLOSES
--
-- api/queue-tick.js treats a blast as sent if ANY channel succeeded:
--
--   if (!sent.length) { errors.push(...); continue; }   // nothing delivered -> row untouched
--   await rpc('queue_mark_sent', ...)                   // something delivered -> sent
--
-- So a blast whose SMS went out and whose email failed outright is stored as plain 'sent',
-- indistinguishable from a clean one. The `failed` array is returned in the HTTP response and
-- then thrown away — nothing persists it.
--
-- That was survivable only because sent rows stayed visible in the Queue. The Queue is being
-- changed to hide them (it is the working list of what has NOT gone out), and at that point a
-- half-failed blast would vanish from the Queue while Market History logged only the channel
-- that worked. Nobody would ever learn the other half did not go.
--
-- The all-channels-failed case is already correct and is NOT touched here: the row is left
-- untouched, stays queued, and the market is not put on cooldown for a send that never
-- happened.
--
-- WHY A NEW COLUMN AND NOT A REWRITE OF queue_mark_sent
--
-- queue_mark_sent(uuid, text) is not defined in any migration in this repo — it exists only in
-- the live database. Its body is therefore unknown here, and redefining it blind would risk
-- silently dropping whatever else it does (it takes a p_recipients text that no migration
-- accounts for). This migration adds a SEPARATE, additive write instead. queue-tick keeps
-- calling queue_mark_sent exactly as it does today, then layers the failure detail on top.
--
-- 'partial' NEEDS NO CONSTRAINT CHANGE. campaign_queue.status has no check constraint on the
-- live table — migration 048 verified that explicitly and relied on it to add 'rejected',
-- which is not in the original 012 list and works in production.

alter table public.campaign_queue
  add column if not exists send_failures text;

comment on column public.campaign_queue.send_failures is
  'Human-readable failure detail from the send attempt, one entry per failed channel. Set '
  'alongside status = ''partial'' when some channels delivered and others did not. Null on a '
  'clean send. Never cleared by a later read — it is the record that the blast was incomplete.';

-- ---------------------------------------------------------------------------
-- 1. The additive write.
--
-- Deliberately narrow: it sets the failure text and, optionally, the status. It does not touch
-- sent_at, recipients, or anything else queue_mark_sent owns — this runs AFTER that call and
-- must not undo it.
--
-- p_status is optional so the same function can record failure detail without reclassifying a
-- row, which is what a future "all channels failed but we want a note" path would want.
-- ---------------------------------------------------------------------------
create or replace function public.queue_set_failures(
  p_id uuid,
  p_failures text,
  p_status text default null
)
returns setof public.campaign_queue
language sql
security definer
set search_path to 'public'
as $function$
  update public.campaign_queue
     set send_failures = nullif(btrim(coalesce(p_failures, '')), ''),
         status        = coalesce(nullif(btrim(coalesce(p_status, '')), ''), status)
   where id = p_id
  returning *;
$function$;

revoke execute on function public.queue_set_failures(uuid, text, text) from public, anon;
grant  execute on function public.queue_set_failures(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Expose send_failures on the queue, and freeze reach for 'partial' too.
--
-- The return type gains a column, so the function must be dropped and recreated (same reason
-- as 044/045/056). The body below is 056's, verbatim, with two changes:
--
--   * every `q.status = 'sent'` freeze test becomes `q.status in ('sent','partial')` — a
--     partly-sent blast DID reach people, so it must report who it actually reached rather
--     than who the market holds today, exactly like a fully sent one.
--   * q.send_failures is returned.
--
-- GRANTS: dropping a function drops its ACL, and CREATE FUNCTION then grants EXECUTE to PUBLIC
-- by default — see the long note at the end of 056. The pre-change ACL is reproduced verbatim
-- below. This is a display change and must not move the security line in either direction.
-- ---------------------------------------------------------------------------
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
