-- 074: stop marking every queued blast as a placeholder, so the queue can actually send.
--
-- WHAT WAS WRONG
--
-- queue_enqueue_test writes is_placeholder = true on every row it inserts, hard-coded, with the
-- comment "TEST rows only: queue-tick skips placeholders, never sends". api/queue-tick.js honours
-- that exactly:
--
--     q.filter(r => !r.is_placeholder && sendable(r) && scheduled_for <= now)
--
-- That was correct while the product was in test. It was never undone. The send allowlist was
-- emptied, production was taken out of test mode, the front-end send switch was made
-- environment-driven (AI-959) — and this flag, set at the moment of queueing inside a function
-- still named _test, kept every row unsendable.
--
-- Measured on 2026-09-16, before this migration:
--
--   * last blast actually sent ................. 2026-06-23, 85 days earlier
--   * rows in the queue ........................ 83
--   * rows past their scheduled send time ...... 68
--   * of those, how many the cron would send ... 0  (all 68 is_placeholder = true)
--   * rows a human had CONFIRMED ............... 7, including games not yet played
--
-- Seven blasts were read and approved by a person and silently went nowhere. The hourly cron ran
-- the whole time and correctly found nothing to do.
--
-- Trigger Blast, the daily decider cron and the new multi-select Add to Queue (AI-964) all insert
-- through this one function, so all three produced unsendable rows.
--
-- WHY THE NAME STAYS. queue_enqueue_test is called from ui/index.html in two places and from the
-- OpenClaw agent; renaming it is a separate change with its own blast radius, and doing it inside
-- the migration that flips the behaviour would mean two reasons for one diff. The name is now
-- wrong and the comment below says so.

-- ---------------------------------------------------------------------------
-- The function, byte-identical to migration 071's, with ONE value changed:
-- is_placeholder false instead of true.
-- ---------------------------------------------------------------------------
create or replace function public.queue_enqueue_test(p_rows jsonb)
returns setof public.campaign_queue
language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  r jsonb;
  v_when timestamptz;
  v_event uuid;
  v_code text;
  v_segment text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    v_when    := coalesce((nullif(r->>'scheduled_for',''))::timestamptz, now());
    v_event   := (nullif(r->>'event_id',''))::uuid;
    v_code    := nullif(r->>'state_code','');
    v_segment := nullif(btrim(coalesce(r->>'segment','')), '');

    if v_segment is not null and v_segment not in ('ICP','SCP','Other') then
      raise exception 'Unknown segment %, expected ICP, SCP or Other.', v_segment
        using errcode = 'check_violation';
    end if;

    if exists (
      select 1
      from public.campaign_queue q
      where q.status not in ('sent', 'sending', 'rejected')
        and (
          (v_event is not null and q.event_id = v_event
           and (v_segment is null or q.segment is null or q.segment = v_segment))
          or (v_event is null and v_code is not null
              and q.state_code = v_code
              and q.scheduled_for::date = v_when::date
              and (v_segment is null or q.segment is null or q.segment = v_segment))
        )
    ) then
      continue;
    end if;

    return query
    insert into public.campaign_queue
      (title, state_code, state_name, event_id, segment,
       email, sms, phone_count, sms_count, email_count,
       email_copy, sms_copy, scheduled_for, status, is_placeholder,
       trigger_instructions)
    values (
      coalesce(nullif(r->>'title',''), 'Blast'),
      v_code,
      nullif(r->>'state_name',''),
      v_event,
      v_segment,
      coalesce((r->>'email')::boolean, true),
      coalesce((r->>'sms')::boolean, false),
      coalesce((nullif(r->>'phone_count',''))::int, 0),
      coalesce((nullif(r->>'sms_count',''))::int, 0),
      coalesce((nullif(r->>'email_count',''))::int, 0),
      r->>'email_copy',
      r->>'sms_copy',
      v_when,
      'pending',
      -- THE CHANGE. A queued blast is a real blast now: it sits as 'pending' until a person
      -- confirms it, and the hourly cron will send it at its slot. Nothing else about the
      -- human-in-the-loop design moves — approval is still required, and is still the only
      -- thing standing between a queued row and a real send.
      false,
      nullif(btrim(coalesce(r->>'trigger_instructions','')), '')
    )
    returning *;
  end loop;
end;
$function$;

comment on function public.queue_enqueue_test(jsonb) is
  'Queue one or more blasts. THE NAME IS HISTORICAL — since migration 074 these are real rows '
  'that will send once confirmed, not test placeholders. Called by Trigger Blast, the daily '
  'decider cron, and multi-select Add to Queue. Renaming it is a separate change: two UI '
  'call sites and the OpenClaw agent use this name.';

revoke execute on function public.queue_enqueue_test(jsonb) from public, anon;
grant  execute on function public.queue_enqueue_test(jsonb) to authenticated, service_role;

-- The default on the column follows, so a row inserted by anything other than this function is
-- also real. The column stays — a genuine demo row is still expressible by setting it — but the
-- default no longer assumes everything is a test.
alter table public.campaign_queue
  alter column is_placeholder set default false;

comment on column public.campaign_queue.is_placeholder is
  'True only for demo/placeholder rows the hourly send must never pick up. Default false since '
  'migration 074 — before that every queued blast was true and nothing could send.';
