-- 081: make the default SMS sender a setting, not a constant in the source.
--
-- WHAT IT DECIDES
--
-- The sender a newly queued blast starts with picks two things at once, and the second is not
-- obvious from the first:
--
--   THE PROVIDER. A value like 'salesmsg:2341:+16468591775' routes the send through the Salesmsg
--   API; a bare number like '+14422300850' routes it through Telnyx. Different service, different
--   deliverability, different cost.
--
--   WHERE REPLIES GO. On Telnyx the number's messaging profile owns the inbound webhook, so a
--   blast from a 2-way-inbox number has its replies land in HubSpot where Cole works, and one
--   from the "Luiz" profile has them land in this app where nobody looks. A Salesmsg send has
--   them land in Salesmsg — a third inbox again.
--
-- That was a constant in ui/index.html. Changing it meant a deploy, and nobody could see what it
-- was set to — which is how every queued blast came to default to Salesmsg without it being a
-- decision anyone remembered making.
--
-- WHY decider_rules AND NOT A NEW TABLE. It is the single-row settings table this product
-- already has (id = 1), it is what the Cole Rules tab edits, and this is a rule in exactly the
-- same sense as the cooldown floor: it shapes what a queued blast looks like before a human
-- touches it. A second settings table would mean two places to look.
--
-- NULL MEANS "let the app choose", and stays the default so applying this migration changes
-- nothing on its own. The UI falls back to its own preference order — a reply-capturing Telnyx
-- number, then Salesmsg, then whatever exists — exactly as it does today. A setting that had to
-- be filled in before the product worked would be a worse default than the one it replaces.

alter table public.decider_rules
  add column if not exists default_sms_from text;

comment on column public.decider_rules.default_sms_from is
  'Sender a newly queued blast starts with: a bare E.164 number routes through Telnyx, a '
  '''salesmsg:<team>:<number>'' value routes through Salesmsg. Null lets the UI choose (a '
  'reply-capturing Telnyx number first). Every queue row can override it. Migration 081.';

-- ---------------------------------------------------------------------------
-- Expose it on the read side.
--
-- get_decider_rules is a plain `select * from decider_rules`, so it picks the new column up with
-- no change — verified against the live function's returned columns rather than assumed. The
-- WRITE side is the one that needs teaching, because it lists its columns explicitly.
--
-- set_decider_rules is NOT defined in any migration in this repo — like queue_confirm and
-- queue_mark_sent it exists only in the live database, so its body is unknown here and
-- redefining it blind would risk dropping whatever else it does. A SEPARATE, ADDITIVE setter is
-- added instead, the same approach 058 took for the same reason. The Cole Rules save calls both:
-- the existing RPC for the numeric rules it already owns, and this for the sender.
-- ---------------------------------------------------------------------------
create or replace function public.set_default_sms_from(p_value text)
returns text
language sql
volatile
security definer
set search_path to 'public'
as $function$
  update public.decider_rules
     set default_sms_from = nullif(btrim(coalesce(p_value, '')), ''),
         updated_at = now()
   where id = 1
  returning default_sms_from;
$function$;

comment on function public.set_default_sms_from(text) is
  'Sets decider_rules.default_sms_from (migration 081). Empty or whitespace stores NULL, which '
  'means "let the app choose" rather than "no sender" — there is no way to express "send from '
  'nothing", because a row with no sender simply does not send SMS.';

revoke execute on function public.set_default_sms_from(text) from public, anon;
grant  execute on function public.set_default_sms_from(text) to authenticated, service_role;
