-- Numbers available on the Telnyx messaging profile — powers the number switcher
-- (pick which number to send from / which inbox to view).

create table if not exists public.telnyx_numbers (
  id                   uuid primary key default gen_random_uuid(),
  phone_number         text not null unique,
  messaging_profile_id text,
  label                text,
  active               boolean not null default true,
  sort_order           int not null default 0,
  created_at           timestamptz not null default now()
);

alter table public.telnyx_numbers enable row level security;
drop policy if exists telnyx_numbers_anon_all on public.telnyx_numbers;
create policy telnyx_numbers_anon_all on public.telnyx_numbers for all to anon using (true) with check (true);

alter publication supabase_realtime add table public.telnyx_numbers;

insert into public.telnyx_numbers (phone_number, messaging_profile_id, label, sort_order)
values ('+16158050766', '40019f22-ee12-4a37-a3d8-c4255ed71c03', 'Main', 0)
on conflict (phone_number) do nothing;
