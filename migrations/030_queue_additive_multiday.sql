-- Additive, multi-day queue (Josh, 2026-07-28: "the queue is not rewriting itself every time").
--
-- Two changes to queue_enqueue_test:
--   1. SCHEDULE — the row's send slot comes from the payload (`scheduled_for`), not now().
--      That's what lets a run line up four days of blasts instead of stacking them all today.
--   2. ADDITIVE — a live row (status not sent/sending) already holding this event's slot means
--      the market is spoken for; skip it instead of inserting a duplicate on every trigger.
--      Rows with no event fall back to (market + send day) as the identity.
--
-- Skipped rows are simply not returned, so the caller sees exactly what was ADDED. Existing
-- rows keep their copy, sender, schedule edits and confirmations — nothing is overwritten.
--
-- SAFETY unchanged: every row is is_placeholder=true and queue-tick never sends placeholders.

create or replace function public.queue_enqueue_test(p_rows jsonb)
returns setof public.campaign_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
  v_when timestamptz;
  v_event uuid;
  v_code text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    v_when  := coalesce((nullif(r->>'scheduled_for',''))::timestamptz, now());
    v_event := (nullif(r->>'event_id',''))::uuid;
    v_code  := nullif(r->>'state_code','');

    -- already queued -> leave the existing row alone (this is the "don't rewrite" rule)
    if exists (
      select 1
      from public.campaign_queue q
      where q.status not in ('sent', 'sending')
        and (
          (v_event is not null and q.event_id = v_event)
          or (v_event is null and v_code is not null
              and q.state_code = v_code
              and q.scheduled_for::date = v_when::date)
        )
    ) then
      continue;
    end if;

    return query
    insert into public.campaign_queue
      (title, state_code, state_name, event_id,
       email, sms, phone_count, sms_count, email_count,
       email_copy, sms_copy, scheduled_for, status, is_placeholder)
    values (
      coalesce(nullif(r->>'title',''), '[TEST] Blast'),
      v_code,
      nullif(r->>'state_name',''),
      v_event,
      coalesce((r->>'email')::boolean, true),
      coalesce((r->>'sms')::boolean, false),
      coalesce((nullif(r->>'phone_count',''))::int, 0),
      coalesce((nullif(r->>'sms_count',''))::int, 0),
      coalesce((nullif(r->>'email_count',''))::int, 0),
      r->>'email_copy',
      r->>'sms_copy',
      v_when,
      'pending',
      true            -- TEST rows only: queue-tick skips placeholders, never sends
    )
    returning *;
  end loop;
end;
$function$;

grant execute on function public.queue_enqueue_test(jsonb) to anon, authenticated, service_role;

-- Per-day view of what the queue already holds, so a run can fill only the GAPS.
-- queued counts live rows on that day; event_ids / market_codes are what's already spoken for.
create or replace function public.queue_plan(p_from date default current_date, p_to date default null)
returns table(slot_date date, queued integer, event_ids uuid[], market_codes text[])
language sql
stable security definer
set search_path to 'public'
as $function$
  with days as (
    select generate_series(p_from, greatest(coalesce(p_to, p_from + 3), p_from), interval '1 day')::date as slot_date
  ),
  live as (
    select scheduled_for::date as slot_date, event_id, state_code
    from public.campaign_queue
    where status not in ('sent', 'sending')
  )
  select
    d.slot_date,
    count(l.slot_date)::int as queued,
    coalesce(array_agg(l.event_id) filter (where l.event_id is not null), '{}')          as event_ids,
    coalesce(array_agg(distinct l.state_code) filter (where l.state_code is not null), '{}') as market_codes
  from days d
  left join live l on l.slot_date = d.slot_date
  group by d.slot_date
  order by d.slot_date;
$function$;

grant execute on function public.queue_plan(date, date) to anon, authenticated, service_role;
