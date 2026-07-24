-- Recipient counts on the queue: add email_count, and let queue_enqueue_test store
-- phone_count / sms_count / email_count / state_code for each queued row.
--
-- Counts are resolved from the market: market_key -> market_state.state_code ->
-- markets_with_contacts(code) -> {phone_count, email_count}. Display only; TEST rows
-- (is_placeholder=true) still never send.

alter table public.campaign_queue
  add column if not exists email_count integer not null default 0;

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
       email, sms, phone_count, sms_count, email_count,
       email_copy, sms_copy, scheduled_for, status, is_placeholder)
    values (
      coalesce(nullif(r->>'title',''), '[TEST] Blast'),
      nullif(r->>'state_code',''),
      nullif(r->>'state_name',''),
      (nullif(r->>'event_id',''))::uuid,
      coalesce((r->>'email')::boolean, true),
      coalesce((r->>'sms')::boolean, false),
      coalesce((nullif(r->>'phone_count',''))::int, 0),
      coalesce((nullif(r->>'sms_count',''))::int, 0),
      coalesce((nullif(r->>'email_count',''))::int, 0),
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
