-- 105: group MMS threads with an agent in them (AI-1095).
--
-- WHAT THIS IS FOR
--
-- A group text is one thread shared by several phones. Telnyx has no object for it: every
-- message in a group is delivered as separate copies, and an inbound reply arrives at our
-- number looking exactly like a 1:1 text, with a single recipient and no hint that other
-- people are in the thread (the message.received webhook carries one `to`). So the only
-- thing that knows who is in a group is whoever opened it. That is us, and this table is
-- that memory.
--
-- One row per thread. `members` is every phone in it EXCEPT our own number: those are the
-- people a reply goes to. `conversation_id` is the Telnyx AI conversation the assistant uses
-- for this thread, so it keeps context across turns, and so two threads with the same lead
-- never share a memory.
--
-- A message log lives beside it. Not telnyx_messages: that table is keyed on a 1:1
-- (telnyx_number, contact_number) conversation and cannot say which thread a copy belonged
-- to. A group message is one event with several deliveries; this logs the event.

create table if not exists public.mms_groups (
  id              uuid primary key default gen_random_uuid(),
  our_number      text not null,                 -- the number the relay answers from, E.164
  members         text[] not null,               -- everyone else in the thread, E.164
  conversation_id uuid,                          -- Telnyx AI conversation for the assistant
  label           text,                          -- what a person would call it ("Smith lead")
  status          text not null default 'open',  -- 'open' | 'closed'
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  constraint mms_groups_has_members check (array_length(members, 1) >= 1)
);

-- Finding the thread a reply belongs to: by our number and the sender. GIN on members makes
-- `members @> array[sender]` an index lookup rather than a scan.
create index if not exists idx_mms_groups_our_number on public.mms_groups (our_number) where status = 'open';
create index if not exists idx_mms_groups_members    on public.mms_groups using gin (members);

create table if not exists public.mms_group_messages (
  id                uuid primary key default gen_random_uuid(),
  group_id          uuid not null references public.mms_groups(id) on delete cascade,
  direction         text not null,               -- 'inbound' | 'outbound'
  from_number       text not null,
  to_numbers        text[] not null,             -- every delivery this one event produced
  body              text,
  telnyx_message_id text,                        -- outbound: the group_mms id; inbound: the received id
  -- Who authored an outbound: 'assistant' (the relay answering), 'operator' (a person
  -- opening or steering the thread). Null on inbound.
  author            text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_mms_group_messages_group on public.mms_group_messages (group_id, created_at);

comment on table public.mms_groups is
  'One group text thread (AI-1095). members = everyone but our_number. Telnyx has no group object, '
  'so this is the only record of who is in a thread.';
comment on table public.mms_group_messages is
  'One row per message event in a group thread, with every delivery it produced in to_numbers.';

-- RLS on, matching every other table. The relay writes with the service role; the UI (when
-- there is one) reads with anon.
alter table public.mms_groups         enable row level security;
alter table public.mms_group_messages enable row level security;

drop policy if exists mms_groups_anon_read on public.mms_groups;
create policy mms_groups_anon_read on public.mms_groups for select to anon using (true);
drop policy if exists mms_group_messages_anon_read on public.mms_group_messages;
create policy mms_group_messages_anon_read on public.mms_group_messages for select to anon using (true);

grant select on public.mms_groups, public.mms_group_messages to anon;
grant select, insert, update, delete on public.mms_groups, public.mms_group_messages to service_role;
