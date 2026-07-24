-- Trigger Blast [Temp btn]: enqueue AI-decided blasts into the queue as TEST rows.
--
-- The Compose & Send "Trigger Blast" button runs the deterministic decider
-- (rpc_event_recommendations) client-side, takes the top few decision='send'
-- markets, and lines them up in campaign_queue for review.
--
-- SAFETY: every row inserted here is is_placeholder=true. queue-tick.js NEVER
-- auto-sends placeholder rows, so nothing this function queues can ever send.
-- This is a testing-only path; remove or harden before wiring real sends.

create or replace function public.queue_enqueue_test(p_rows jsonb)
returns setof public.campaign_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    return query
    insert into public.campaign_queue
      (title, state_code, state_name, event_id,
       email, sms, email_copy, sms_copy,
       scheduled_for, status, is_placeholder)
    values (
      coalesce(nullif(r->>'title',''), '[TEST] Blast'),
      nullif(r->>'state_code',''),
      nullif(r->>'state_name',''),
      (nullif(r->>'event_id',''))::uuid,
      coalesce((r->>'email')::boolean, true),
      coalesce((r->>'sms')::boolean, false),
      r->>'email_copy',
      r->>'sms_copy',
      now(),
      'pending',
      true            -- TEST rows only: queue-tick skips placeholders, never sends
    )
    returning *;
  end loop;
end;
$function$;

grant execute on function public.queue_enqueue_test(jsonb) to anon, authenticated, service_role;
