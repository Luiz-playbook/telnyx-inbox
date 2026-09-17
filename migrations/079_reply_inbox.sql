-- 079: one inbox for every reply a blast earns, split by channel.
--
-- WHAT EXISTS TODAY
--
-- SMS replies already have a home: telnyx_conversations (a thread per contact number) and
-- telnyx_messages (the messages in it), written by the n8n inbound workflow. That pair works.
--
-- EMAIL REPLIES HAVE NOWHERE TO LAND AT ALL. The Market History panel has carried a "Replies"
-- tab since it was built and it renders "Coming Soon — this feature is not yet available for
-- emails", because there is no table behind it. A reply to a blast is the single most valuable
-- thing a blast produces, and until now the email half has been dropped on the floor.
--
-- This migration builds the missing half and puts one shape over both, so the UI can show Email
-- and SMS as two tabs of one inbox rather than two features that happen to sit near each other.
--
-- THE UI IS BEING BUILT AGAINST THIS NOW; THE INGESTION IS NOT WIRED YET. That is deliberate and
-- worth stating plainly: email_replies will be empty until something writes to it, and the SMS
-- side has its own coverage problem described below. An empty inbox that is honest about why is
-- more useful than a tab that does not exist.
--
-- ---------------------------------------------------------------------------
-- A ROUTING FACT THAT DECIDES WHAT THIS CAN EVER SHOW
--
-- Checked against the live Telnyx account on 2026-09-17:
--
--   the 8 "2-way inbox" numbers  ->  https://hubspot-telnyx-integration.vercel.app/api/inbound
--   +16158050766 ("Main")        ->  n8n -> telnyx_messages, i.e. this database
--
-- So a reply to a blast sent from a 2-way number lands in HUBSPOT and never reaches this app,
-- and a reply to "Main" lands here and never reaches HubSpot. telnyx_messages currently holds
-- 22 messages across 3 conversations, all test traffic, newest 2026-07-31 — not one real blast
-- reply.
--
-- That is AI-965's concern stated as plumbing. Closing it needs either Charles's endpoint to
-- forward a copy here, or this app to read HubSpot. Neither is done, and neither is blocked by
-- this migration: the shape below holds a reply whatever eventually writes it.
-- ---------------------------------------------------------------------------

create table if not exists public.email_replies (
  id uuid primary key default gen_random_uuid(),

  -- The provider's own id for the message. UNIQUE so re-delivery — every webhook worth using
  -- retries, and n8n will replay — updates rather than duplicates. A reply shown twice reads as
  -- two people answering.
  provider_message_id text unique,
  -- Groups a back-and-forth. Nullable: a first reply has no thread until there is a second.
  thread_id text,

  from_email text not null,
  to_email   text,
  subject    text,
  body       text,

  -- WHICH BLAST THIS ANSWERS, when it can be known. Matching a reply to its campaign is a guess
  -- in the general case (people reply from a different address, forward, or answer weeks later),
  -- so all three are nullable and none is a foreign key: a reply nobody can attribute is still
  -- worth reading, and a FK would reject it outright.
  campaign_id text,
  market_key  text,
  segment     text,

  received_at timestamptz not null default now(),
  -- Read state, per inbox rather than per user. There is no per-user read model here and
  -- inventing one for a two-person team would be ceremony; when that changes this becomes a
  -- join table and nothing above it moves.
  read_at     timestamptz,
  -- Kept whole. Parsers improve and re-parsing beats re-asking the provider for something it may
  -- no longer hold; also the only place to look when an attribution turns out wrong.
  raw         jsonb,

  created_at timestamptz not null default now()
);

comment on table public.email_replies is
  'Inbound replies to email blasts (migration 079). Nothing writes here yet — the ingestion is '
  'not wired. Attribution columns are nullable and unconstrained on purpose: an unattributable '
  'reply is still worth reading.';

-- Newest first is the only order an inbox is ever read in.
create index if not exists email_replies_received_idx on public.email_replies (received_at desc);
-- "What did this blast get back", the question the Market History panel asks.
create index if not exists email_replies_campaign_idx on public.email_replies (campaign_id) where campaign_id is not null;
-- Unread count, cheap.
create index if not exists email_replies_unread_idx   on public.email_replies (received_at desc) where read_at is null;

alter table public.email_replies enable row level security;

-- The UI reads with the ANON key, and RLS with zero policies returns zero rows to it — the trap
-- this codebase has hit before. Read is open to the signed-in app; writing stays server-side,
-- because ingestion is a webhook's job and nothing in the browser should be able to invent a
-- reply that appears to come from a customer.
drop policy if exists email_replies_read on public.email_replies;
create policy email_replies_read on public.email_replies
  for select to anon, authenticated using (true);

grant select on public.email_replies to anon, authenticated;
grant all    on public.email_replies to service_role;

-- ---------------------------------------------------------------------------
-- ONE SHAPE OVER BOTH CHANNELS.
--
-- The two sides are stored differently and should stay that way — an SMS thread is a
-- conversation with a number, an email reply is a message against a campaign — so this does not
-- try to merge the storage. It normalises only what an inbox list needs: who, when, a preview,
-- read state, and enough to open the right thing.
--
-- `channel` is the column the UI's Email / SMS tabs filter on.
--
-- SECURITY DEFINER with a stable search_path, matching every other read RPC here.
-- ---------------------------------------------------------------------------
create or replace function public.reply_inbox(p_channel text default null)
returns table (
  channel      text,
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
  -- EMAIL: one row per reply. There is no thread object, so the thread key falls back to the
  -- reply's own id — a single message is a thread of one, and the UI can open it either way.
  select 'email'::text,
         e.id::text,
         coalesce(e.thread_id, e.id::text),
         e.from_email,
         e.received_at,
         left(regexp_replace(coalesce(e.body, ''), '\s+', ' ', 'g'), 160),
         (e.read_at is null),
         e.campaign_id,
         e.market_key
  from public.email_replies e
  where p_channel is null or p_channel = 'email'

  union all

  -- SMS: one row per CONVERSATION, not per message. A text thread is read as a conversation and
  -- listing every message would bury the person under their own replies.
  --
  -- Only threads whose last message came IN. An outbound last message means the ball is in their
  -- court, not ours, and an inbox is a list of things waiting on you.
  select 'sms'::text,
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
    and coalesce(c.last_direction, 'inbound') = 'inbound'

  -- BY POSITION, NOT BY NAME. `received_at` is also the name of one of this function's RETURNS
  -- TABLE output columns, and those names are in scope inside the body — so a bare
  -- `order by received_at` can resolve to the output parameter instead of the union's column,
  -- or be rejected outright as ambiguous. Position 5 is unambiguous and cannot drift silently,
  -- which name-based ordering across a UNION can.
  order by 5 desc nulls last;
$function$;

comment on function public.reply_inbox(text) is
  'One list over both reply channels for the Replies tab (migration 079). Email is one row per '
  'reply; SMS is one row per conversation whose last message was inbound. Pass ''email'' or '
  '''sms'' to filter, null for both.';

revoke execute on function public.reply_inbox(text) from public;
grant  execute on function public.reply_inbox(text) to anon, authenticated, service_role;
