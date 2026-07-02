-- Telnyx 2-Way SMS Inbox — storage schema
-- Target project: Playbook n8n (snfmggrnyjayuuxafats)
-- Additive only: two new `telnyx_`-prefixed tables, no changes to existing objects.
--
-- Write path : n8n workflows using the Supabase SERVICE ROLE (bypasses RLS).
-- Read path  : static UI using the ANON key (governed by the RLS policies below).
-- For this testing spike the read policies are permissive (anon may read all
-- inbox rows). Tighten before this goes to a real user (see README "Hardening").

-- ── Conversations: one row per (our number, contact number) pair ──────────────
create table if not exists public.telnyx_conversations (
  id                uuid primary key default gen_random_uuid(),
  telnyx_number     text not null,          -- our Telnyx number (the inbound "to")
  contact_number    text not null,          -- the person texting us
  last_message_at   timestamptz not null default now(),
  last_preview      text,                   -- snippet of the most recent message
  last_direction    text,                   -- 'inbound' | 'outbound' of last message
  unread            boolean not null default true,
  assigned_to       text,                   -- e.g. 'cole' once we route/assign
  created_at        timestamptz not null default now(),
  unique (telnyx_number, contact_number)
);

-- ── Messages: every inbound + outbound text in a conversation ─────────────────
create table if not exists public.telnyx_messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.telnyx_conversations(id) on delete cascade,
  direction         text not null check (direction in ('inbound','outbound')),
  from_number       text not null,
  to_number         text not null,
  body              text,
  media             jsonb,                  -- MMS media descriptors, if any
  telnyx_message_id text,                   -- Telnyx's message id (dedupe + status)
  status            text,                   -- delivery status from message.finalized
  created_at        timestamptz not null default now()
);

create index if not exists idx_telnyx_messages_conv
  on public.telnyx_messages (conversation_id, created_at);

-- Dedupe guard: Telnyx retries webhooks. Ignore a repeat of the same inbound id.
create unique index if not exists uq_telnyx_messages_telnyx_id
  on public.telnyx_messages (telnyx_message_id)
  where telnyx_message_id is not null;

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table public.telnyx_conversations enable row level security;
alter table public.telnyx_messages      enable row level security;

-- Anon (browser UI) may READ. Service role (n8n) bypasses RLS entirely for writes.
-- SPIKE-ONLY: permissive read. Replace with an owner/team scoped policy for prod.
drop policy if exists telnyx_conversations_anon_read on public.telnyx_conversations;
create policy telnyx_conversations_anon_read
  on public.telnyx_conversations for select
  to anon using (true);

drop policy if exists telnyx_messages_anon_read on public.telnyx_messages;
create policy telnyx_messages_anon_read
  on public.telnyx_messages for select
  to anon using (true);

-- ── Realtime: push new rows to the UI without polling ─────────────────────────
alter publication supabase_realtime add table public.telnyx_conversations;
alter publication supabase_realtime add table public.telnyx_messages;
