-- AI-830: schedule refresh pipeline for new season releases.
--
-- Leagues hard-release their schedules ~6-7x/year (NBA in Aug, NFL separately, ...).
-- The refresh loader (scripts/load-schedule.js) pulls a league's newly released games
-- into events_master via upsert_events_master() (idempotent: on conflict do nothing, so
-- existing rows are never duplicated) and records one row here per run for the change log.

create table if not exists public.events_master_schedule_runs (
  id           uuid primary key default gen_random_uuid(),
  ran_at       timestamptz not null default now(),
  league       text not null,
  season       text,
  source_url   text,
  fetched      integer,                 -- games returned by the source
  added        integer,                 -- new rows inserted (rest were already present)
  added_ids    uuid[],                  -- the games added this run (the change log)
  notes        text
);

create index if not exists schedule_runs_ran_idx on public.events_master_schedule_runs (ran_at desc);
create index if not exists schedule_runs_league_idx on public.events_master_schedule_runs (league, ran_at desc);

alter table public.events_master_schedule_runs enable row level security;
grant all on public.events_master_schedule_runs to anon, authenticated, service_role;
drop policy if exists schedule_runs_anon_read on public.events_master_schedule_runs;
create policy schedule_runs_anon_read on public.events_master_schedule_runs for select to anon using (true);

-- record_schedule_run — insert a change-log row, return its id.
create or replace function public.record_schedule_run(p jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  insert into public.events_master_schedule_runs (league, season, source_url, fetched, added, added_ids, notes)
  values (
    lower(p->>'league'), p->>'season', p->>'source_url',
    (p->>'fetched')::int, (p->>'added')::int,
    (select coalesce(array_agg((v)::uuid), '{}') from jsonb_array_elements_text(coalesce(p->'added_ids','[]'::jsonb)) v),
    nullif(p->>'notes','')
  )
  returning id into v_id;
  return v_id;
end;
$function$;

grant execute on function public.record_schedule_run(jsonb) to anon, authenticated, service_role;
