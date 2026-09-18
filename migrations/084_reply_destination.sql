-- 084: which of OUR numbers or addresses a reply came back to.
--
-- A DIFFERENT QUESTION FROM PROVIDER, and the more useful one day to day.
--
-- 083 added provider — Telnyx, Salesmsg, CakeMail — which answers "through which service". This
-- answers "to which of our own senders", and that is the question an operator actually has:
--
--   "did this come back to the 2-way number or to Main?"
--   "which address are people replying to?"
--
-- It matters because the senders are not interchangeable. The nine Telnyx numbers sit across two
-- messaging profiles with different inbound webhooks, so which number a reply landed on decides
-- whether it reached HubSpot or reached here. And on the email side each blast goes out AS a
-- named person — Josh, Jake, Zay — so the address a reply came to is the person whose inbox it
-- is actually sitting in.
--
-- Both columns already exist and were simply never returned:
--   telnyx_conversations.telnyx_number   (live values: +15550001111, +16158050766)
--   email_replies.to_email               (no rows yet; the column is there)
--
-- NOTHING IS STORED OR MIGRATED. This is a read-shape change: one more column out of
-- reply_inbox, and one more optional filter. No table is touched.

-- ---------------------------------------------------------------------------
-- The return type gains a column, so drop and recreate — the same reason 071/075/083 had to.
-- 083's body verbatim plus `destination` and `p_destination`.
--
-- NAMED `destination`, NOT `to_number` OR `to_email`, because it is one concept wearing two
-- shapes: the end of ours that the reply arrived at. A column per channel would push the union
-- apart and make the UI ask which one to read.
-- ---------------------------------------------------------------------------
drop function if exists public.reply_inbox(text, text);

create or replace function public.reply_inbox(
  p_channel     text default null,
  p_provider    text default null,
  p_destination text default null
)
returns table (
  channel      text,
  provider     text,
  destination  text,
  reply_id     text,
  thread_key   text,
  correspondent text,
  received_at  timestamptz,
  preview      text,
  unread       boolean,
  campaign_id  text,
  market_key   text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- EMAIL: one row per reply. destination is the address they replied TO — which, since blasts
  -- go out as a named person, is whose mailbox the reply is sitting in.
  select 'email'::text,
         coalesce(e.provider, 'unknown'),
         e.to_email,
         e.id::text,
         coalesce(e.thread_id, e.id::text),
         e.from_email,
         e.received_at,
         left(regexp_replace(coalesce(e.body, ''), '\s+', ' ', 'g'), 160),
         (e.read_at is null),
         e.campaign_id,
         e.market_key
  from public.email_replies e
  where (p_channel is null or p_channel = 'email')
    and (p_provider is null or coalesce(e.provider, 'unknown') = p_provider)
    and (p_destination is null or e.to_email = p_destination)

  union all

  -- SMS: one row per CONVERSATION whose last message came IN. destination is OUR number on that
  -- thread, which is what decides where its replies are routed.
  select 'sms'::text,
         'telnyx'::text,
         c.telnyx_number,
         c.id::text,
         c.id::text,
         c.contact_number,
         c.last_message_at,
         left(coalesce(c.last_preview, ''), 160),
         coalesce(c.unread, false),
         null::text,
         null::text
  from public.telnyx_conversations c
  where (p_channel is null or p_channel = 'sms')
    and (p_provider is null or p_provider = 'telnyx')
    and (p_destination is null or c.telnyx_number = p_destination)
    and coalesce(c.last_direction, 'inbound') = 'inbound'

  -- By position. received_at is also an output column name and those are in scope in the body,
  -- so ordering by name can resolve to the parameter or be rejected as ambiguous (see 079). It
  -- has MOVED to position 7 because destination was inserted ahead of it — which is exactly the
  -- fragility of positional ordering, and still preferable to an ambiguous name.
  order by 7 desc nulls last;
$function$;

comment on function public.reply_inbox(text, text, text) is
  'One list over every reply channel for the Replies tab. p_channel filters email/sms, '
  'p_provider the service, p_destination OUR number or address the reply arrived at — all three '
  'optional and composable. destination is telnyx_conversations.telnyx_number for SMS and '
  'email_replies.to_email for email: one concept, two shapes. Migration 084.';

revoke execute on function public.reply_inbox(text, text, text) from public;
grant  execute on function public.reply_inbox(text, text, text) to anon, authenticated, service_role;
