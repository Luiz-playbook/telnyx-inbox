-- 088: price over time, per game and per marketplace.
--
-- events_master keeps only the CURRENT price (best_price + price_candidates), overwritten on every
-- refresh, so nothing could answer "is this game getting cheaper?" or "what is the lowest it has
-- been?" — Josh's feedback on a game that looked expensive (2026-10-01). One row is written per
-- source per refresh, holding that source's cheapest listing at the time.
--
-- Written by api/price-refresh.js (service role). Read by the price editor with the anon key, the
-- same way it reads events_master. The write is best-effort: a refresh never fails because history
-- could not be stored.
--
-- Growth: ~3 rows per priced game per refresh. At the 12-hourly cron over ~300 games that is under
-- 2,000 rows a day. Prune with: delete from event_price_history where checked_at < now() - interval '120 days';

create table if not exists public.event_price_history (
  id          bigint generated always as identity primary key,
  event_id    uuid not null references public.events_master(id) on delete cascade,
  source      text not null,
  price       numeric,            -- per ticket before fees, as price_candidates.price
  all_in      numeric,            -- what the buyer pays, as price_candidates.all_in
  seats       smallint,
  section     text,
  chosen      boolean not null default false,   -- this listing was the one stored as best_price
  checked_at  timestamptz not null default now()
);

create index if not exists event_price_history_event_idx
  on public.event_price_history (event_id, checked_at desc);

alter table public.event_price_history enable row level security;

drop policy if exists event_price_history_anon_read on public.event_price_history;
create policy event_price_history_anon_read on public.event_price_history
  for select to anon using (true);
