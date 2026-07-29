-- AI-845 Phase 1: price accuracy — tiered refresh, history, health.
--
-- Diagnosis from stand-up: stored prices ran ~20-25% high. A fresh pull of the flagged
-- game (nationals/blue jays) came back $13 = the live price, while the complained-about
-- ~$17 was an evening-before pull. So the cause is STALENESS (same-day MLB prices decay),
-- not fees/extraction (a fee bug would keep the fresh pull high too) and not source
-- variance (sources are consistent). Fix = refresh near-term games far more often.

-- tiered staleness: near-term games decay fast, so a much shorter freshness window.
alter table public.decider_rules add column if not exists price_stale_hours_near integer not null default 12;
alter table public.decider_rules add column if not exists price_near_days       integer not null default 3;
-- flat far-game cadence tightened 72h -> 48h
update public.decider_rules set price_stale_hours = 48 where id = 1 and price_stale_hours = 72;

-- price history: keep every pull, so decay is MEASURED, not assumed.
create table if not exists public.events_master_price_history (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null,
  league       text,
  best_price   numeric,
  price_source text,
  priced_at    timestamptz not null default now()
);
create index if not exists price_history_event_idx on public.events_master_price_history (event_id, priced_at desc);
alter table public.events_master_price_history enable row level security;
grant all on public.events_master_price_history to anon, authenticated, service_role;
drop policy if exists price_history_anon_read on public.events_master_price_history;
create policy price_history_anon_read on public.events_master_price_history for select to anon using (true);

-- set_event_prices now also appends to history on every write.
create or replace function public.set_event_prices(p_league text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb; n integer := 0; v_id uuid;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    update public.events_master
       set best_price   = (r->>'price_usd')::numeric,
           price_source = nullif(r->>'source',''),
           priced_at    = now()
     where league = p_league
       and external_id = (r->>'external_id')
       and (r->>'price_usd') is not null
    returning id into v_id;
    if found then
      n := n + 1;
      insert into public.events_master_price_history (event_id, league, best_price, price_source)
      values (v_id, p_league, (r->>'price_usd')::numeric, nullif(r->>'source',''));
    end if;
  end loop;
  return n;
end;
$function$;
grant execute on function public.set_event_prices(text, jsonb) to anon, authenticated, service_role;

-- health check: is the refresh actually running? (answers "is the cron blocked?")
-- Cadence expectation is the near cron interval (12h) + a buffer.
create or replace function public.price_refresh_health()
returns table(last_run_at timestamptz, hours_since numeric, expected_within_hours integer, ok boolean, last_priced integer, last_cost numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with last as (
    select started_at, priced, cost_usd
    from public.events_master_price_runs
    where not dry_run
    order by started_at desc
    limit 1
  )
  select l.started_at,
         round(extract(epoch from now() - l.started_at)/3600, 1),
         18,                                   -- 12h cadence + 6h buffer
         (l.started_at is not null and (now() - l.started_at) < interval '18 hours'),
         l.priced, l.cost_usd
  from last l
  right join (select 1) _ on true;            -- always return one row, even with no runs
$function$;
grant execute on function public.price_refresh_health() to anon, authenticated, service_role;
