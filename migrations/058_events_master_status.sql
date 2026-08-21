-- 058: the status column from 053, applied on its own.
--
-- WHY THIS FILE EXISTS AT ALL. 053_event_cancellations.sql was committed (a90ee28) but never
-- reached the database: two migrations were numbered 053, and the runner took
-- 053_price_seat_quantity and skipped the other. Nothing surfaced the gap because nothing read
-- the column — until api/price-refresh.js started filtering `status=eq.scheduled`, at which
-- point every price refresh died on:
--
--   {"code":"42703","message":"column events_master.status does not exist"}
--
-- returned as a 400, which the endpoint reports as `events fetch failed` and the UI shows as
-- "Price refresh failed". Looked like a Gemini billing problem; the model was never called.
--
-- WHY NOT JUST RUN 053. Because 053 also carries `create function get_campaign_queue()` and
-- `rpc_event_recommendations()`, and 054 (price provenance) and 056 (segment reach) have since
-- redefined get_campaign_queue on top of the OLD live baseline. Replaying 053 now would roll
-- that function back and silently drop price_source/price_seats/segment_*_count from the queue.
-- So this migration takes section 1 of 053 verbatim and nothing else. The rest of 053 — the
-- cancellation-aware upsert_events_master — still needs a rebase onto 054/056 before it can run.
--
-- SAFE BY CONSTRUCTION: additive, and the not-null default backfills every existing row to
-- 'scheduled', so the price-refresh filter matches exactly the set it matched before the filter
-- was added. Nothing starts being excluded today.

alter table public.events_master
  add column if not exists status         text not null default 'scheduled',
  add column if not exists status_seen_at timestamptz,
  add column if not exists rescheduled_to uuid references public.events_master(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_master_status_chk') then
    alter table public.events_master
      add constraint events_master_status_chk
      check (status in ('scheduled','postponed','cancelled'));
  end if;
end $$;

-- Partial: the queue/price/decider paths all ask "is this game off?", which is the small side.
create index if not exists events_master_status_idx
  on public.events_master (status) where status <> 'scheduled';

comment on column public.events_master.status is
  'scheduled | postponed | cancelled. Set only from an explicit upstream status field, never from a game being absent from a feed.';
