-- Removing a row from the queue. Two operations, because a sent blast and an unsent one
-- are not the same kind of thing:
--
--   DELETE  — unsent rows only. A queued blast that should not go out has no value once
--             it is cancelled; it holds a per-day slot and blocks its market from being
--             re-picked (the additive guard in api/trigger-decide.js treats any non-sent
--             row as live), so leaving it parked is worse than removing it.
--
--   ARCHIVE — sent rows. A send is history: it is what market_blast_log points at with
--             campaign_queue_id, it is what "this market was blasted" means, and deleting
--             it would quietly rewrite the record the cooldown and the performance model
--             are built on. Archiving only hides it from the working queue.
--
-- THE SENT RULE IS ENFORCED HERE, NOT IN THE UI. queue_delete raises on a sent or sending
-- row. A button can be bypassed — anon holds execute on these RPCs, so the refusal has to
-- live where the write happens.
--
-- 'sending' is refused as well: that row is mid-flight in api/queue-tick.js, and deleting
-- it underneath the tick would lose the record of a send that is actually happening.

-- ---------------------------------------------------------------------------
-- 1. The column. Nullable timestamp rather than a boolean — "when" is free and answers
--    questions "whether" cannot.
-- ---------------------------------------------------------------------------
alter table public.campaign_queue
  add column if not exists archived_at timestamptz;

comment on column public.campaign_queue.archived_at is
  'Set by queue_archive() to hide a sent blast from the working queue without destroying the send record. Null = live. Reversible via queue_unarchive().';

create index if not exists campaign_queue_archived_at_idx
  on public.campaign_queue (archived_at) where archived_at is null;

-- ---------------------------------------------------------------------------
-- 2. Delete — unsent only.
-- ---------------------------------------------------------------------------
create or replace function public.queue_delete(p_id uuid)
returns uuid
language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_status text;
begin
  select status into v_status from public.campaign_queue where id = p_id;
  if v_status is null then
    raise exception 'Blast not found.' using errcode = 'no_data_found';
  end if;
  if v_status in ('sent', 'sending') then
    -- plpgsql RAISE uses % as the placeholder, not %s — '%s' prints the substitution
    -- followed by a literal 's' ("already been sents").
    raise exception 'This blast has already been % — it can be archived, but not deleted.', v_status
      using errcode = 'check_violation';
  end if;
  delete from public.campaign_queue where id = p_id;
  return p_id;
end;
$function$;

grant execute on function public.queue_delete(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Archive / unarchive. Allowed on any row: archiving an unsent blast is a legitimate
--    "not now, but keep it" — deleting is the destructive one and that is the one gated.
-- ---------------------------------------------------------------------------
create or replace function public.queue_archive(p_id uuid)
returns public.campaign_queue
language sql volatile security definer set search_path to 'public'
as $function$
  update public.campaign_queue
     set archived_at = coalesce(archived_at, now())
   where id = p_id
  returning *;
$function$;

create or replace function public.queue_unarchive(p_id uuid)
returns public.campaign_queue
language sql volatile security definer set search_path to 'public'
as $function$
  update public.campaign_queue set archived_at = null where id = p_id returning *;
$function$;

grant execute on function public.queue_archive(uuid)   to anon, authenticated, service_role;
grant execute on function public.queue_unarchive(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Expose archived_at. Return type changes again, so drop + recreate (see 044).
--    Rows are still RETURNED when archived — the UI filters them out — so nothing that
--    counts or audits the queue silently loses history.
-- ---------------------------------------------------------------------------
drop function if exists public.get_campaign_queue();

create function public.get_campaign_queue()
 returns table(id uuid, title text, state_code text, state_name text, event_id uuid,
   email boolean, sms boolean, phone_count integer, sms_count integer, ticket_price numeric,
   email_copy text, sms_copy text, scheduled_for timestamp with time zone, status text,
   confirmed_at timestamp with time zone, snooze_count integer, sent_at timestamp with time zone,
   is_placeholder boolean, created_at timestamp with time zone, email_from text, sms_from text,
   email_count integer, team text, opponent text, event_date date, league text, sport text,
   venue text, market_key text, country text, ticket_url text, email_subject text,
   archived_at timestamp with time zone)
 language sql stable security definer set search_path to 'public'
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
    q.archived_at
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- NOTE. api/queue-tick.js and api/trigger-decide.js both read get_campaign_queue() and
-- treat every row with status not in ('sent','sending') as live. An ARCHIVED unsent row
-- therefore still holds its slot and still blocks its market from being re-picked. That is
-- deliberate: archiving is "hide it", not "cancel it". Delete is the one that frees a slot.
-- ---------------------------------------------------------------------------
