-- Company management profiles — recipients we can message (feeds batch sending).
-- Created by AI (n8n + Firecrawl) or by hand (paste text / upload PDF or MD).
-- Target project: Playbook n8n (snfmggrnyjayuuxafats).

create table if not exists public.companies (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  website           text,
  industry          text,
  location          text,
  size              text,                       -- e.g. "50-200", "Enterprise"
  description       text,                       -- short summary
  products_services text,
  value_prop        text,
  target_audience   text,
  tone              text,                       -- desired outreach tone
  contacts          jsonb not null default '[]'::jsonb,  -- [{name,role,phone,email}]
  raw_content       text,                       -- pasted / scraped / PDF text, verbatim
  source            text not null default 'manual' check (source in ('manual','ai')),
  source_detail     text,                       -- scraped URL or uploaded filename
  status            text not null default 'draft', -- draft | ready | archived
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_companies_created on public.companies (created_at desc);
create index if not exists idx_companies_name    on public.companies (lower(name));

-- keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

-- RLS. SPIKE-ONLY: the browser (anon) does full CRUD directly, since manual
-- profile management runs client-side. Tighten (auth + scoped policies, or route
-- writes through a secret-gated n8n webhook) before this is exposed for real.
alter table public.companies enable row level security;
drop policy if exists companies_anon_all on public.companies;
create policy companies_anon_all
  on public.companies for all
  to anon using (true) with check (true);

alter publication supabase_realtime add table public.companies;
