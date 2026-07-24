-- Ticket Blaster: isolated schema for the chatbot-driven campaign queue.
-- Target project: Playbook n8n (snfmggrnyjayuuxafats). Additive.
--
-- WHY A SEPARATE SCHEMA:
--   Everything here is TESTING-ONLY. Keeping it out of `public` means it cannot be
--   confused with prod tables and no cron / send path touches it yet. Nothing in this
--   file sends anything — it only stores what a blast WOULD be (status defaults to
--   'draft', dry_run defaults to true).
--
-- IMPORTANT — before the browser (supabase-js) can read these via sb.from('...'):
--   Supabase Dashboard > Project Settings > API > "Exposed schemas" must include
--   `ticketblaster`. PostgREST exposes only `public` by default. Until then these
--   tables are reachable via SQL / service role only. (Intentional: keeps it dark
--   during testing.)

create schema if not exists ticketblaster;

-- Let the API roles see the schema (table-level RLS still gates rows).
grant usage on schema ticketblaster to anon, authenticated, service_role;

-- =====================================================================
-- campaign_queue — the shared spine. Cron (later) writes drafts here,
-- the chatbot edits them, the UI reads them. One row = one planned blast.
-- =====================================================================
create table if not exists ticketblaster.campaign_queue (
  id             uuid primary key default gen_random_uuid(),

  -- targeting
  market_code    text not null,                      -- US state / CA province code
  market_name    text,                               -- human label, denormalised for display
  segments       text[] not null default '{}',       -- e.g. {icp,scp,neither}
  play           text,                               -- ticket | suite | teammate | waitlist

  -- channels + senders
  channels       text[] not null default '{}',       -- {sms,email}
  email_from     text,
  sms_from       text,

  -- copy (what would be sent)
  email_subject  text,
  email_body     text,
  sms_body       text,

  -- scheduling / catalytic approval (NOT wired to any sender yet)
  scheduled_for  timestamptz,                        -- when it WOULD send
  auto_send_at   timestamptz,                        -- catalytic: auto-approve deadline (48h model)
  status         text not null default 'draft'       -- draft | approved | sending | sent | skipped
                   check (status in ('draft','approved','sending','sent','skipped')),
  flagged        boolean not null default false,     -- "flag for review" chatbot action

  -- safety
  dry_run        boolean not null default true,      -- true = never actually send. Default ON.

  -- provenance
  created_by     text,                               -- 'chatbot' | 'cron' | user email
  notes          text,                               -- e.g. "skip Dodgers - hasn't worked"
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists campaign_queue_status_idx   on ticketblaster.campaign_queue (status);
create index if not exists campaign_queue_market_idx    on ticketblaster.campaign_queue (market_code);
create index if not exists campaign_queue_schedule_idx  on ticketblaster.campaign_queue (scheduled_for);

-- =====================================================================
-- chat_sessions — log every chatbot prompt + what it did. Josh wants
-- these kept as training data ("sessions" tab). No PII beyond the prompt.
-- =====================================================================
create table if not exists ticketblaster.chat_sessions (
  id           uuid primary key default gen_random_uuid(),
  actor        text,                                 -- who prompted (user email)
  prompt       text not null,                        -- what they typed
  action       text,                                 -- resolved tool call, e.g. 'add_blast'
  args         jsonb,                                -- tool arguments
  result       jsonb,                                -- what the tool returned / row ids touched
  created_at   timestamptz not null default now()
);

create index if not exists chat_sessions_created_idx on ticketblaster.chat_sessions (created_at desc);

-- updated_at trigger (reuse the existing public helper)
drop trigger if exists campaign_queue_set_updated_at on ticketblaster.campaign_queue;
create trigger campaign_queue_set_updated_at
  before update on ticketblaster.campaign_queue
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS. TESTING-ONLY: anon does full CRUD directly, same spike posture as
-- migration 004. Tighten before any real (non-dry-run) use.
-- =====================================================================
alter table ticketblaster.campaign_queue enable row level security;
alter table ticketblaster.chat_sessions  enable row level security;

grant all on ticketblaster.campaign_queue to anon, authenticated, service_role;
grant all on ticketblaster.chat_sessions  to anon, authenticated, service_role;

drop policy if exists campaign_queue_anon_all on ticketblaster.campaign_queue;
create policy campaign_queue_anon_all on ticketblaster.campaign_queue for all to anon using (true) with check (true);

drop policy if exists chat_sessions_anon_all on ticketblaster.chat_sessions;
create policy chat_sessions_anon_all on ticketblaster.chat_sessions for all to anon using (true) with check (true);
