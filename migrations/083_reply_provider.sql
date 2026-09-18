-- 083: which service a reply came back through.
--
-- WHY IT IS A SEPARATE QUESTION FROM CHANNEL
--
-- The Replies tab already splits Email from SMS. That is not the same split as Telnyx / Salesmsg
-- / CakeMail, and the difference matters because each service keeps its replies in a DIFFERENT
-- INBOX, and only some of them reach this database at all:
--
--   Telnyx, 2-way profile   -> Charles's HubSpot integration   (never reaches this app)
--   Telnyx, "Luiz" profile  -> n8n -> telnyx_messages          (reaches this app)
--   Salesmsg                -> the Salesmsg inbox              (never reaches this app)
--   CakeMail email          -> the sender's own mailbox        (never reaches this app)
--
-- So "SMS" is two services with two destinations, and filtering by channel cannot express "show
-- me what came back through Salesmsg". Provider can, and it is also the honest way to show what
-- is MISSING: a provider with no rows and a reason is more useful than a tab that silently omits
-- an entire service.
--
-- NOTHING HERE STARTS INGESTING ANYTHING. This gives the shape a provider-aware inbox needs; the
-- Salesmsg and CakeMail sides stay empty until something writes to them, and the UI says so per
-- provider rather than showing a blank list.

-- ---------------------------------------------------------------------------
-- 1. Email replies gain a provider.
--
-- Nullable and unconstrained, for the same reason the attribution columns in 079 are: a reply
-- that arrives before anyone teaches the ingestion which service it came from is still worth
-- reading, and a NOT NULL here would reject it at the door.
-- ---------------------------------------------------------------------------
alter table public.email_replies
  add column if not exists provider text;

comment on column public.email_replies.provider is
  'Which service the blast went out through, so the reply can be traced back to it: ''cakemail'', '
  '''gmail'', or null when unknown. Not constrained — an unattributable reply is still worth '
  'reading. Migration 083.';

create index if not exists email_replies_provider_idx
  on public.email_replies (provider, received_at desc);

-- ---------------------------------------------------------------------------
-- 2. reply_inbox gains provider, and a filter for it.
--
-- DROP AND RECREATE, because the return type changes — the same reason 071/075 had to. 079's
-- body verbatim plus the provider column and the new argument.
--
-- THE SMS SIDE IS DERIVED, NOT STORED. telnyx_conversations exists only because the n8n Telnyx
-- webhook writes it, so every row in it is Telnyx by construction — recording a provider column
-- there would be storing a constant. If a Salesmsg inbox is ever ingested it arrives as its own
-- table and unions in here with its own literal, exactly as this does.
--
-- BOTH FILTERS ARE OPTIONAL AND COMPOSABLE: channel alone, provider alone, both, or neither.
-- ---------------------------------------------------------------------------
drop function if exists public.reply_inbox(text);

create or replace function public.reply_inbox(p_channel text default null, p_provider text default null)
returns table (
  channel      text,
  provider     text,
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
  -- EMAIL: one row per reply.
  select 'email'::text,
         coalesce(e.provider, 'unknown'),
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

  union all

  -- SMS: one row per CONVERSATION whose last message came IN. An outbound last message means the
  -- ball is in their court, and an inbox is a list of things waiting on you.
  select 'sms'::text,
         'telnyx'::text,
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
    and coalesce(c.last_direction, 'inbound') = 'inbound'

  -- By position: `received_at` is also an output column name and those are in scope in the body,
  -- so ordering by name here can resolve to the parameter or be rejected as ambiguous. See 079.
  order by 6 desc nulls last;
$function$;

comment on function public.reply_inbox(text, text) is
  'One list over every reply channel for the Replies tab. p_channel filters ''email''/''sms'', '
  'p_provider filters ''telnyx''/''salesmsg''/''cakemail''/''gmail''/''unknown''; both optional '
  'and composable. SMS provider is derived — telnyx_conversations is written only by the Telnyx '
  'webhook, so every row in it is Telnyx by construction. Migration 083.';

revoke execute on function public.reply_inbox(text, text) from public;
grant  execute on function public.reply_inbox(text, text) to anon, authenticated, service_role;
