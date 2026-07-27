-- AI-828: price refresh job support.
--
-- The job (api/price-refresh.js) reuses rpc_event_recommendations() to pick eligible
-- games (market + forward window + cooldown already encoded there), narrows to the price
-- window + skip rule below, prices them via Gemini, and writes back through here.
--
-- Tunable knobs live on decider_rules (id=1) next to the send rules:
--   price_window_days  — only price games within N days (ticket: ~20)
--   price_skip_below   — a game already priced below $X is not re-checked (locked in)
--   price_stale_hours  — re-price a game only if its last price is older than this (~72h)

alter table public.decider_rules add column if not exists price_window_days integer not null default 20;
alter table public.decider_rules add column if not exists price_skip_below  numeric not null default 15;
alter table public.decider_rules add column if not exists price_stale_hours integer not null default 72;

-- =====================================================================
-- Per-cycle run log so cadence/cost can be tuned (ticket acceptance).
-- =====================================================================
create table if not exists public.events_master_price_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  model           text,
  eligible        integer,               -- games that passed the eligibility gate
  attempted       integer,               -- games actually sent to the model
  priced          integer,               -- got a usable price back
  missing         integer,               -- attempted but no price (after retry)
  batches         integer,
  retried_batches integer,
  in_tokens       bigint,
  out_tokens      bigint,
  cost_usd        numeric,
  duration_ms     bigint,
  dry_run         boolean not null default false,
  notes           text
);

create index if not exists price_runs_started_idx on public.events_master_price_runs (started_at desc);

alter table public.events_master_price_runs enable row level security;
grant all on public.events_master_price_runs to anon, authenticated, service_role;
drop policy if exists price_runs_anon_read on public.events_master_price_runs;
create policy price_runs_anon_read on public.events_master_price_runs for select to anon using (true);

-- =====================================================================
-- set_event_prices — the ONLY writeback path for prices. Keeps best_price off the
-- open anon UPDATE surface (events_master has select-only anon RLS). Matches by
-- external_id within a league. p_rows: [{external_id, price_usd, source}].
-- =====================================================================
create or replace function public.set_event_prices(p_league text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
  n integer := 0;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    update public.events_master
       set best_price   = (r->>'price_usd')::numeric,
           price_source = nullif(r->>'source',''),
           priced_at    = now()
     where league = p_league
       and external_id = (r->>'external_id')
       and (r->>'price_usd') is not null;
    if found then n := n + 1; end if;
  end loop;
  return n;
end;
$function$;

grant execute on function public.set_event_prices(text, jsonb) to anon, authenticated, service_role;

-- record_price_run — insert a cycle-log row, return its id.
create or replace function public.record_price_run(p jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  insert into public.events_master_price_runs
    (finished_at, model, eligible, attempted, priced, missing, batches, retried_batches,
     in_tokens, out_tokens, cost_usd, duration_ms, dry_run, notes)
  values (
    now(), p->>'model',
    (p->>'eligible')::int, (p->>'attempted')::int, (p->>'priced')::int, (p->>'missing')::int,
    (p->>'batches')::int, (p->>'retried_batches')::int,
    (p->>'in_tokens')::bigint, (p->>'out_tokens')::bigint,
    (p->>'cost_usd')::numeric, (p->>'duration_ms')::bigint,
    coalesce((p->>'dry_run')::boolean, false), nullif(p->>'notes','')
  )
  returning id into v_id;
  return v_id;
end;
$function$;

grant execute on function public.record_price_run(jsonb) to anon, authenticated, service_role;
