-- 090: strategy — what KIND of offer this is, and the spine that lets there be more than one.
--
-- WHAT THIS IS FOR (AI-1075)
--
-- Every offer on the board today is the same kind of thing: a cheap seat at a fixture, sent to a
-- market. Josh wants a second kind (Youth Events, AI-1076) and said the test of the architecture
-- is whether the third, fourth and fifth are then quick. So this migration is not "add a column
-- called strategy" — it is giving an offer somewhere to EXIST, which it currently does not have.
--
-- THE PROBLEM THIS SOLVES, STATED PLAINLY. There is no offers table. event_targets() computes
-- the Offers tab live from events_master every time the tab opens. That is why a strategy field
-- had nowhere to go: you cannot tag a row that is recomputed on every page load. A Youth Events
-- offer is not a fixture at all — it is a venue and a season — so it cannot be squeezed into
-- events_master either without making that table mean two different things.
--
-- WHAT IS STORED HERE, AND WHAT IS DELIBERATELY NOT.
--
--   Stored:     what an offer IS — its strategy, its market, its segment, what it points at.
--   Not stored: ticket price, audience counts, reach.
--
-- That split is the whole design. Prices move (price-refresh runs twice a day) and reach moves
-- (refresh-contacts runs daily). Materialising either into this table would freeze a number the
-- rest of the app keeps current, and the Offers tab would quietly start showing figures that
-- disagree with Market History. So those stay joined at read time, exactly as they are now.
--
-- MIGRATION SHAPE. This adds the table and the columns and backfills them. It does NOT change
-- what the Offers tab reads — that is the UI's half of AI-1075 and lands with the UI, so this
-- can be applied on its own without altering a single screen. Same rule migration 085 followed.

-- ── The strategies themselves ───────────────────────────────────────────────────────────────
--
-- A table rather than an enum, deliberately. An enum needs a migration to add a value, and the
-- entire point of this ticket is that adding the fifth strategy should not be an engineering
-- task. A row here is all a new strategy should cost.
create table if not exists public.offer_strategies (
  code        text primary key,          -- 'ticket_blasts'
  label       text not null,             -- 'Ticket Blasts' — what the filter shows
  -- What the Type column on Offers says. Separate from label because the strategy is the PLAY
  -- ("Ticket Blasts") and the type is what the recipient is being offered ("Tickets").
  offer_type  text not null,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

insert into public.offer_strategies (code, label, offer_type, sort_order) values
  ('ticket_blasts', 'Ticket Blasts', 'Tickets',      10),
  -- Seeded now, unused until AI-1076. Present so the filter has something to show a second
  -- option against, and so the Youth Events work needs no migration of its own.
  ('youth_events',  'Youth Events',  'Youth Events', 20)
on conflict (code) do nothing;

-- ── Strategy on the things that already exist ───────────────────────────────────────────────
--
-- Queue rows and templates. Every one of them today is a ticket blast — that is not an
-- assumption, it is the only kind of blast the system has ever sent — so the backfill is
-- unconditional and the column is NOT NULL afterwards. A nullable strategy would mean "we do not
-- know", and there is nothing here we do not know.
alter table public.campaign_queue
  add column if not exists strategy text references public.offer_strategies(code);
update public.campaign_queue set strategy = 'ticket_blasts' where strategy is null;
alter table public.campaign_queue
  alter column strategy set default 'ticket_blasts',
  alter column strategy set not null;

alter table public.message_templates
  add column if not exists strategy text references public.offer_strategies(code);
update public.message_templates set strategy = 'ticket_blasts' where strategy is null;
alter table public.message_templates
  alter column strategy set default 'ticket_blasts',
  alter column strategy set not null;

-- Replies get NO column. email_replies already carries campaign_id, so a reply's strategy is the
-- strategy of the blast it answers — one join away. Copying it onto the reply would create a
-- second copy of a fact that can later disagree with the first.
create index if not exists idx_campaign_queue_strategy   on public.campaign_queue (strategy);
create index if not exists idx_message_templates_strategy on public.message_templates (strategy);

-- ── The offers spine ────────────────────────────────────────────────────────────────────────
--
-- One row per thing-that-could-be-blasted, per segment. The grain matches campaign_queue's own
-- de-dupe key (subject + segment), because an offer becomes a queue row one-for-one and anything
-- coarser would make the three segment rows of one game indistinguishable — the same reasoning
-- the Offers tab's selection key already follows.
create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),

  strategy text not null references public.offer_strategies(code),

  -- WHAT THIS OFFER IS ABOUT. Exactly one of these is set, enforced by the check below.
  --   event_id — a fixture, for ticket blasts. Text, matching events_master.event_id.
  --   venue    — a place and a season, for youth events. No fixture exists to point at.
  event_id text,
  venue    text,
  season   text,

  -- WHO IT IS FOR. The same shape the whole app already uses for an audience.
  market_key text,
  state_code text,
  segment    text,

  -- Housekeeping. status is deliberately thin: an offer is either on the board or it is not.
  -- Everything about a SEND lives on campaign_queue, which is a different thing with its own
  -- lifecycle; merging the two would make this table the queue.
  status     text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint offers_points_at_one_thing check (
    (event_id is not null and venue is null)
    or (event_id is null and venue is not null)
  )
);

-- One offer per subject per segment per strategy. Two coalesces because exactly one of
-- event_id/venue is ever set, and a unique index cannot be written across a choice of columns.
create unique index if not exists offers_subject_segment_key
  on public.offers (strategy, coalesce(event_id, ''), coalesce(venue, ''), coalesce(segment, ''));

create index if not exists idx_offers_strategy on public.offers (strategy);
create index if not exists idx_offers_event    on public.offers (event_id) where event_id is not null;

comment on table public.offers is
  'What an offer IS - strategy, subject, audience. Prices and reach are NOT here: they move, and '
  'are joined live from events_master and the market summaries exactly as the Offers tab does today.';
comment on table public.offer_strategies is
  'The kinds of offer the system can make. A row, not an enum, so a fifth strategy costs a row '
  'and not a migration (AI-1075).';

-- ── RLS, matching every other table the UI reads ────────────────────────────────────────────
--
-- RLS on with no policy returns zero rows to the anon key the UI holds, which looks exactly like
-- an empty board. Both tables therefore get an explicit read policy, same as every other table
-- the browser reads. Writing stays server-side through the service role, same as the queue.
alter table public.offers           enable row level security;
alter table public.offer_strategies enable row level security;

drop policy if exists offers_anon_all on public.offers;
create policy offers_anon_all on public.offers for select to anon using (true);
drop policy if exists offer_strategies_anon_all on public.offer_strategies;
create policy offer_strategies_anon_all on public.offer_strategies for select to anon using (true);

grant select on public.offers, public.offer_strategies to anon;
grant select, insert, update, delete on public.offers, public.offer_strategies to service_role;

-- ── NOT DONE HERE, ON PURPOSE ───────────────────────────────────────────────────────────────
--
-- Nothing writes to public.offers yet, and the Offers tab still reads event_targets() live. That
-- is the next commit: ticket offers get upserted into this table so they can carry a strategy,
-- and the tab reads offers joined to live prices and reach. Splitting it this way means this
-- migration can be applied to production without changing a single screen, and the screen change
-- can then be reviewed on its own.
