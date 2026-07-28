-- Surface the cheapest ticket price in the Queue.
--
-- campaign_queue already has a ticket_price column, but the enqueue path leaves it null,
-- so the Queue's "Ticket $" cell shows "—". Rather than touch enqueue (send-test-mode
-- work is in flight there), resolve the price at READ time: get_campaign_queue() now
-- coalesces the stored ticket_price with the live events_master.best_price for the row's
-- event. This keeps the Queue price auto-fresh as the 72h refresh (AI-828) updates prices.
--
-- Same output columns as before (was RETURNS SETOF campaign_queue) plus the join, so the
-- Queue UI (which already reads r.ticket_price) needs no change.

drop function if exists public.get_campaign_queue();

create or replace function public.get_campaign_queue()
returns table(
  id uuid, title text, state_code text, state_name text, event_id uuid,
  email boolean, sms boolean, phone_count integer, sms_count integer, ticket_price numeric,
  email_copy text, sms_copy text, scheduled_for timestamptz, status text, confirmed_at timestamptz,
  snooze_count integer, sent_at timestamptz, is_placeholder boolean, created_at timestamptz,
  email_from text, sms_from text, email_count integer, team text, opponent text
)
language sql
stable security definer
set search_path to 'public'
as $function$
  select
    q.id, q.title, q.state_code, q.state_name, q.event_id,
    q.email, q.sms, q.phone_count, q.sms_count,
    coalesce(q.ticket_price, em.best_price) as ticket_price,   -- stored snapshot, else live best_price
    q.email_copy, q.sms_copy, q.scheduled_for, q.status, q.confirmed_at,
    q.snooze_count, q.sent_at, q.is_placeholder, q.created_at,
    q.email_from, q.sms_from, q.email_count, q.team, q.opponent
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role;
