-- 106: a mailbox pulled into SendBlaster, filtered to demo bookings (AI-1102).
--
-- WHAT THIS IS FOR
--
-- Cole's Gmail, read once a day by an n8n workflow, with an agent keeping only the emails
-- that are about booking a demo. Those land here and a SendBlaster inbox tab shows them.
--
-- NOT email_replies, deliberately. That table is replies to blasts, keyed by the campaign
-- they answer, and the Replies tab and Market History read it as such. Dropping a mailbox
-- import into it would make every one of Cole's demo-booking emails look like a reply to a
-- campaign that does not exist. Different thing, different table.
--
-- ONE ROW PER GMAIL MESSAGE, keyed on Gmail's own id, so the daily sync can be re-run over
-- the same window and change nothing - the upsert collides on gmail_message_id. The
-- classification is stored with the row (is_demo_booking + why) rather than being used to
-- drop non-matches: a wrongly-dropped email is invisible forever, a wrongly-classified one
-- is a filter away from being found. Only the fields the tab needs are kept; the body is a
-- preview, not the whole email. This is a mailbox and most of it is not ours to hold.

create table if not exists public.inbox_emails (
  id                uuid primary key default gen_random_uuid(),
  source            text not null default 'gmail:cole',   -- which mailbox; room for a second
  gmail_message_id  text not null,
  gmail_thread_id   text,
  from_email        text,
  from_name         text,
  to_email          text,
  subject           text,
  snippet           text,                                 -- Gmail's own ~200-char preview
  body_preview      text,                                 -- first ~1,500 chars of the text part
  labels            text[] not null default '{}',         -- Gmail label names, for the tab's filter
  received_at       timestamptz,
  is_demo_booking   boolean not null default false,
  classifier_reason text,                                 -- one line from the agent, for trust
  classified_at     timestamptz,
  synced_at         timestamptz not null default now(),
  read_at           timestamptz,
  constraint inbox_emails_source_message unique (source, gmail_message_id)
);

create index if not exists idx_inbox_emails_demo     on public.inbox_emails (source, received_at desc) where is_demo_booking;
create index if not exists idx_inbox_emails_received on public.inbox_emails (source, received_at desc);
create index if not exists idx_inbox_emails_labels   on public.inbox_emails using gin (labels);

comment on table public.inbox_emails is
  'A mailbox pulled into SendBlaster by n8n, one row per Gmail message, classified for demo '
  'bookings (AI-1102). Not replies to blasts - those are email_replies.';

alter table public.inbox_emails enable row level security;

-- The UI reads with the anon key; n8n writes with the service role.
drop policy if exists inbox_emails_anon_read on public.inbox_emails;
create policy inbox_emails_anon_read on public.inbox_emails for select to anon using (true);

grant select on public.inbox_emails to anon;
grant select, insert, update, delete on public.inbox_emails to service_role;

-- The sync's upsert, as one call n8n can make through PostgREST with the service role:
--   POST /rest/v1/inbox_emails?on_conflict=source,gmail_message_id
--   Prefer: resolution=merge-duplicates,return=minimal
-- A re-run over the same days updates labels / classification and inserts nothing twice.
