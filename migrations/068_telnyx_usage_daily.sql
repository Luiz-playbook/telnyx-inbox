-- Telnyx 10DLC send volume against the carrier cap — storage for the Market History strip.
--
-- WHY THIS EXISTS. Telnyx publishes what a brand is ALLOWED to send and never what it has
-- sent against that allowance: there is no consumption endpoint, and no "how much is left"
-- anywhere in the API. The only route to a remaining figure is to count sent messages
-- ourselves and subtract. `/v2/usage_reports` aggregates that server-side, so this schema is
-- a cache of those aggregates rather than a per-message log — one row per day, per sending
-- number, per carrier.
--
-- WHY PER CARRIER AND NOT A DAILY TOTAL. The cap that binds is T-Mobile's, and it counts only
-- T-Mobile-bound messages. Total outbound is the wrong number to compare to 40,000 — across
-- the 30 days measured on 2026-09-10 it overstated real cap usage by 6x (89,552 sent, 14,225
-- of them to T-Mobile). Carrier is not something we choose either: it is whoever the
-- RECIPIENT's provider is, discovered per message. So it has to be stored, not assumed.
--
-- WHY SEGMENTS ARE STORED SEPARATELY FROM COUNT. AT&T rate-limits segments, not messages:
-- 160 GSM-7 characters is one segment, so a 320-character blast burns the allowance twice as
-- fast as its message count suggests. `usage_reports` calls this `parts`.

-- ── The facts: one row per day / number / carrier / direction ────────────────
create table if not exists public.telnyx_usage_daily (
  usage_date      date        not null,
  sending_number  text        not null,   -- usage_reports `tn`, E.164
  carrier         text        not null,   -- usage_reports `normalized_carrier`; '' when unknown
  direction       text        not null check (direction in ('inbound','outbound')),
  msg_count       integer     not null default 0,   -- usage_reports `count`
  segments        integer     not null default 0,   -- usage_reports `parts`
  cost            numeric(12,4),
  synced_at       timestamptz not null default now(),
  primary key (usage_date, sending_number, carrier, direction)
);

-- The strip asks one question — "the last N days" — so date leads the index.
create index if not exists idx_telnyx_usage_daily_date
  on public.telnyx_usage_daily (usage_date desc, direction);

comment on table public.telnyx_usage_daily is
  'Cached /v2/usage_reports messaging aggregates. Refreshed by api/telnyx-usage-sync.js.';

-- ── Which inbox each sending number belongs to ───────────────────────────────
--
-- Telnyx has no idea what "Ticketblast" is; it knows +13159988112. This mapping exists
-- nowhere else, so it lives here rather than in code — numbers are being added as inboxes are
-- created, and adding one should not need a deploy.
create table if not exists public.telnyx_senders (
  phone_number  text primary key,          -- E.164
  label         text not null,             -- the inbox name a person recognises
  active        boolean not null default true,
  sort_order    integer not null default 0,
  notes         text,
  created_at    timestamptz not null default now()
);

comment on table public.telnyx_senders is
  'Sending number -> inbox name. Add a row when a number is added to a 10DLC campaign.';

-- Seeded from the live 10DLC assignments read on 2026-09-10 (see bruno/telnyx-10dlc).
-- Every one of these is ASSIGNED to campaign C8LB7XX under the Playbook brand with
-- tmobileNumberMappingStatus=ADDED, so they all draw on the SAME 40,000/day allowance.
insert into public.telnyx_senders (phone_number, label, sort_order, notes) values
  ('+13159988112', 'Ticketblast',         10, 'C8LB7XX / Playbook. ~90% of all outbound volume.'),
  ('+19345001252', 'Event Confirmations', 20, 'C8LB7XX / Playbook'),
  ('+13238801900', 'Event Marketing',     30, 'C8LB7XX / Playbook. Was recorded as receive-only; it sends.'),
  ('+19345001757', 'Cole TBD',            40, 'C8LB7XX / Playbook'),
  ('+15512344320', 'Kids',                50, 'C8LB7XX / Playbook'),
  ('+16808420065', 'Marketing',           60, 'C8LB7XX / Playbook'),
  ('+16093602796', 'General',             70, 'C8LB7XX / Playbook. The HubSpot 2-way inbox.'),
  ('+16158050766', 'SendBlaster',         80, 'NOT ON ANY 10DLC CAMPAIGN as of 2026-09-10 — unregistered long code.')
on conflict (phone_number) do nothing;

-- ── The caps, refreshed from Telnyx rather than remembered ───────────────────
--
-- The cap is not a number Telnyx returns. It returns a vetting score, and the carriers
-- publish a band table that turns that score into two limits. Storing the score alongside the
-- derived limits keeps the derivation auditable and lets the strip say WHEN it last checked —
-- a score can be re-pulled, and ours has already moved once (16 -> 63 on 2026-06-09, which
-- took the daily cap from 2,000 to 40,000).
create table if not exists public.telnyx_brands (
  brand_id        text primary key,        -- Telnyx UUID
  tcr_brand_id    text,
  brand_name      text,
  vetting_score   integer,                 -- null = unvetted
  tmo_daily_cap   integer not null default 2000,   -- T-Mobile messages/day, brand-level
  att_tpm         integer not null default 240,    -- AT&T segments/minute
  identity_status text,
  checked_at      timestamptz not null default now()
);

comment on table public.telnyx_brands is
  'Per-brand carrier limits derived from the vetting score. Refreshed by api/telnyx-usage-sync.js.';

insert into public.telnyx_brands
  (brand_id, tcr_brand_id, brand_name, vetting_score, tmo_daily_cap, att_tpm, identity_status) values
  ('4b20019e-4394-6a29-1fd4-f94f145124f0', 'BDOF01M', 'Playbook AI Solutions Inc.', 63, 40000, 2400, 'VETTED_VERIFIED'),
  ('4b20019d-3f6a-b253-8681-08d4420acbbf', 'B95W6JI', 'Social City LLC (NYC Basketball)', null, 2000, 240, 'VERIFIED')
on conflict (brand_id) do nothing;

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- No anon policy on any of the three. The browser never reads these directly — it goes
-- through /api/telnyx-usage, which holds the service role. Same rule as
-- ticketblaster_market_blasts_log: a table with no policy returns an empty array to anon
-- rather than an error, so a direct read would look like "no volume" instead of "no access".
alter table public.telnyx_usage_daily enable row level security;
alter table public.telnyx_senders     enable row level security;
alter table public.telnyx_brands      enable row level security;

grant select, insert, update, delete on public.telnyx_usage_daily to service_role;
grant select, insert, update, delete on public.telnyx_senders     to service_role;
grant select, insert, update, delete on public.telnyx_brands      to service_role;
