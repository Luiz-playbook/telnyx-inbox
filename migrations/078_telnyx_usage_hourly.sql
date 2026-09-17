-- 078: hourly Telnyx usage, so the Reports tab can count days in Eastern time (AI-1004).
--
-- WHY. Everything in Playbook runs on ET on purpose. This one panel could not: Telnyx's
-- `usage_reports` was being read with the `date` dimension, which buckets in whole UTC days, and
-- a UTC day cannot be re-cut into an ET one — the volume inside it is already summed. So the tab
-- showed UTC days while the rest of the app showed ET, and 8pm-to-midnight ET landed on the
-- following day's figure.
--
-- The fix is upstream: `usage_reports` also has a `date_time` dimension, which returns the same
-- aggregates by HOUR. ET is a whole-hour offset from UTC, so hours re-bucket into ET days exactly,
-- with no per-message log and no estimation.
--
-- SIZE. Measured 2026-09-17 against the live account: 166 rows for a busy day, 1,730 for 16 days
-- — roughly 3,400 a month with number, carrier and direction. That is a cache, not a message log.
--
-- THE CAP STILL RESETS AT MIDNIGHT UTC. That is a carrier fact and no amount of display changes
-- it. Volume is therefore reported in ET days, while the allowance arithmetic groups the same
-- hours by UTC day — both are derived from this table, and api/telnyx-usage.js labels which is
-- which. telnyx_usage_daily is still written (UTC days) and left in place for anything that reads
-- it; the Reports tab now reads this table instead.

create table if not exists public.telnyx_usage_hourly (
  usage_hour      timestamptz not null,   -- usage_reports `date_time`, start of the UTC hour
  sending_number  text        not null,   -- usage_reports `tn`, E.164
  carrier         text        not null,   -- usage_reports `normalized_carrier`; '' when unknown
  direction       text        not null check (direction in ('inbound','outbound')),
  msg_count       integer     not null default 0,   -- usage_reports `count`
  segments        integer     not null default 0,   -- usage_reports `parts`
  cost            numeric(12,4),
  synced_at       timestamptz not null default now(),
  primary key (usage_hour, sending_number, carrier, direction)
);

-- Every query here is "this range of hours", so the hour leads the index.
create index if not exists idx_telnyx_usage_hourly_hour
  on public.telnyx_usage_hourly (usage_hour desc, direction);

comment on table public.telnyx_usage_hourly is
  'Cached /v2/usage_reports messaging aggregates by hour (AI-1004). Hours are UTC; the Reports tab '
  'groups them into ET days for volume and into UTC days for the T-Mobile allowance, which resets '
  'at midnight UTC. Refreshed by api/telnyx-usage-sync.js.';

comment on column public.telnyx_usage_hourly.usage_hour is
  'Start of the UTC hour the aggregate covers. Stored as timestamptz so the ET grouping is done by '
  'the reader, not baked in.';

-- Same posture as telnyx_usage_daily (migration 068): server-side only. The Reports tab reaches it
-- through api/telnyx-usage.js on the service role, so there is no anon or authenticated policy and
-- RLS denies everything else by default.
alter table public.telnyx_usage_hourly enable row level security;
grant select, insert, update on public.telnyx_usage_hourly to service_role;
