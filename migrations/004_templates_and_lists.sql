-- Message templates + recipient lists for bulk sending.
-- Target project: Playbook n8n (snfmggrnyjayuuxafats). Additive.

create table if not exists public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  body        text not null default '',          -- supports {{name}}, {{first_name}}, {{phone}}
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.recipient_lists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  recipients  jsonb not null default '[]'::jsonb,  -- [{name, phone}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists message_templates_set_updated_at on public.message_templates;
create trigger message_templates_set_updated_at
  before update on public.message_templates
  for each row execute function public.set_updated_at();

drop trigger if exists recipient_lists_set_updated_at on public.recipient_lists;
create trigger recipient_lists_set_updated_at
  before update on public.recipient_lists
  for each row execute function public.set_updated_at();

-- RLS. SPIKE-ONLY: browser (anon) does full CRUD directly. Tighten before real use.
alter table public.message_templates enable row level security;
alter table public.recipient_lists   enable row level security;

drop policy if exists message_templates_anon_all on public.message_templates;
create policy message_templates_anon_all on public.message_templates for all to anon using (true) with check (true);

drop policy if exists recipient_lists_anon_all on public.recipient_lists;
create policy recipient_lists_anon_all on public.recipient_lists for all to anon using (true) with check (true);

alter publication supabase_realtime add table public.message_templates;
alter publication supabase_realtime add table public.recipient_lists;
