-- Live audience counts in the Queue (Josh: "it should be number of phone numbers, number of
-- emails" — and they have to be RIGHT at send time, not whenever the row was queued).
--
-- email_count / phone_count are written once at enqueue, so a row queued four days out shows
-- a snapshot that drifts as contacts are added, cleaned, or opted out. The Queue now resolves
-- them at READ time from market_counts (same source the decider uses), keyed on the row's
-- state_code — exactly how ticket_price already works (migration 025).
--
-- A SENT row keeps its stored numbers: that's the historical record of what actually went out.
-- sms_count is dropped from the read model in favour of phone_count — it was the same number
-- under a second name, which is what made the old "Phones / SMS" columns confusing.

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
    q.email, q.sms,
    case when q.status = 'sent' then q.phone_count
         else coalesce(mc.phone_count::int, q.phone_count) end as phone_count,
    case when q.status = 'sent' then q.sms_count
         else coalesce(mc.phone_count::int, q.sms_count) end   as sms_count,
    coalesce(q.ticket_price, em.best_price) as ticket_price,   -- stored snapshot, else live best_price
    q.email_copy, q.sms_copy, q.scheduled_for, q.status, q.confirmed_at,
    q.snooze_count, q.sent_at, q.is_placeholder, q.created_at,
    q.email_from, q.sms_from,
    case when q.status = 'sent' then q.email_count
         else coalesce(mc.email_count::int, q.email_count) end as email_count,
    q.team, q.opponent
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role;
