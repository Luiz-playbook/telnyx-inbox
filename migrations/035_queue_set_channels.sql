-- Turn a channel off (or back on) for a queued blast.
--
-- The Queue could pick WHO carries a send but never "don't send on this channel at all".
-- A row is enqueued with email=true, sms=true, so an operator who only wanted the email had
-- to leave the SMS pointed at a real number and hope. The "Send from" / "Text from" pickers
-- now carry a "not sending" option, which lands here.
--
-- Null means "leave this channel as it is", so the email picker can flip email without
-- touching sms and vice versa. A sent row is never modified — that is the historical record.

create or replace function public.queue_set_channels(p_id uuid, p_email boolean default null, p_sms boolean default null)
returns campaign_queue
language sql
security definer
set search_path to 'public'
as $function$
  update public.campaign_queue
     set email = coalesce(p_email, email),
         sms   = coalesce(p_sms,   sms)
   where id = p_id and status <> 'sent'
  returning *;
$function$;

grant execute on function public.queue_set_channels(uuid, boolean, boolean) to anon, authenticated, service_role;
