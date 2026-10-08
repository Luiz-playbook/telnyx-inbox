-- 108: approved venue list and per-market season calendar for the Youth Events strategy (AI-1086).
--
-- NAMED FOR THE STRATEGY, NOT JUST "venues", AND THAT MATTERS HERE. events_master already has a
-- `venue` column and it means the OPPOSITE of this one: there, a venue is where a professional
-- game we SELL TICKETS TO is played (Barclays Center). Here, a venue is somewhere we would HOST
-- a youth event. A bare public.youth_event_venues sitting beside that is a table someone joins to the wrong
-- thing on a Friday afternoon. venue_section_zones is a third, different sense again — the
-- seating map of a ticketed arena.
--
-- Blocks AI-1076, the seasonal cron that creates Youth Events offers for greenfield markets.
-- Both tables exist to be READ BY THAT CRON, which is why the sports a venue supports are stored
-- rather than inferred at query time, and why the season dates live beside the school dates.
--
-- WHAT A GREENFIELD MARKET IS (Josh, Oct 1 call): a state we run no events in, so marketing
-- there cannot collide with the events team. He named eighteen of them on the call. They are
-- deliberately the quiet states, and that has a consequence worth stating plainly: NONE of the
-- eighteen has an NBA, NFL, MLB or NHL team. "Every professional stadium" is therefore a nearly
-- empty set here, and the venue list is overwhelmingly Division 1 college plus a few minor-league
-- parks. That is not a gap in the data; it is what the market selection means.
--
-- SPORTS ARE DERIVED FROM VENUE TYPE, NOT TYPED PER ROW. Josh's rule, verbatim from the call:
--   basketball venues  -> basketball, volleyball
--   football venues    -> football, soccer, lacrosse, field hockey
--   baseball venues    -> baseball, softball
-- The loader applies it. Storing the list per row would let one venue drift out of step with the
-- rule, and the whole point is that "there's no point of inviting a football program to play at
-- a basketball venue".

create table if not exists public.youth_event_venues (
  id            bigint generated always as identity primary key,
  state_code    text not null,
  state_name    text not null,
  -- The market a venue is matched to. Josh: venues are matched to markets, and for the knowledge
  -- base we take the biggest city in the market.
  market_city   text not null,
  org           text not null,              -- the school or club the venue belongs to
  level         text not null check (level in ('pro', 'minor', 'd1')),
  venue         text not null,
  venue_type    text not null check (venue_type in ('football', 'basketball', 'baseball')),
  -- Applied from venue_type by the loader, stored so the cron can filter on it directly.
  sports        text[] not null,
  -- 'High' for the flagship programmes whose venue names are unambiguous; 'Medium' for the rest.
  -- Nothing here has been checked against a primary source yet — see the doc.
  confidence    text not null default 'Medium' check (confidence in ('High', 'Medium')),
  notes         text,
  loaded_at     timestamptz not null default now(),
  unique (org, venue)
);

comment on table public.youth_event_venues is
  'Venues we could HOST a youth event at (AI-1086) — not to be confused with events_master.venue, which is where a ticketed pro game is played. Greenfield states only for now. '
  'sports is derived from venue_type by scripts/load-greenfield-venues.js using Josh''s rule '
  '(basketball->basketball,volleyball; football->football,soccer,lacrosse,field hockey; '
  'baseball->baseball,softball). UNVERIFIED: venue names are a research starting point.';

create index if not exists youth_event_venues_market on public.youth_event_venues (state_code, market_city);
create index if not exists youth_event_venues_sports on public.youth_event_venues using gin (sports);

-- ---------------------------------------------------------------------------------------------
-- Market season calendar: when to send, per state. Deliberately NOT strategy-scoped —
-- school dates and season starts are facts about a market, useful to any strategy that
-- wants to time a send, so this one is named for the market rather than Youth Events.
--
-- Josh's reason for this existing at all: "certain states start a month or two later and ideally
-- you could time it properly by state... so you don't just send them all out the same day once a
-- year." The cron reads these dates to give the sends a rhythm.
--
-- THE DATE COLUMNS SHIP EMPTY ON PURPOSE. First and last day of school and the four season start
-- dates are ~126 facts that change every year and vary by district. Filling them with plausible
-- guesses would be worse than leaving them null, because someone would schedule real sends
-- against them. Each row names the district and the governing athletics association so the
-- lookup is a known task rather than an open search; source_url records where the answer came
-- from when someone fills it in.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.market_season_calendar (
  state_code          text primary key,
  state_name          text not null,
  market_city         text not null,          -- biggest city in the market
  school_district     text,                   -- whose calendar answers the school dates
  athletics_body      text,                   -- whose calendar answers the season starts
  school_first_day    date,
  school_last_day     date,
  fall_sports_start   date,
  winter_sports_start date,
  spring_sports_start date,
  summer_sports_start date,
  source_url          text,
  verified_at         timestamptz,
  notes               text,
  loaded_at           timestamptz not null default now()
);

comment on table public.market_season_calendar is
  'Per-market school and sports-season dates, used to time sends (AI-1086). Date columns are NULL '
  'until someone verifies them against the named district and athletics body — they change '
  'yearly and sends are scheduled against them, so a guess is worse than a blank. '
  'Seasons per Josh: fall Aug-Nov, winter Dec-Feb, spring Mar-May, summer Jun-Jul.';

alter table public.youth_event_venues enable row level security;
alter table public.market_season_calendar enable row level security;

drop policy if exists youth_event_venues_read on public.youth_event_venues;
create policy youth_event_venues_read on public.youth_event_venues for select using (true);
drop policy if exists market_season_calendar_read on public.market_season_calendar;
create policy market_season_calendar_read on public.market_season_calendar for select using (true);

grant select on public.youth_event_venues, public.market_season_calendar to anon, authenticated;
grant all    on public.youth_event_venues, public.market_season_calendar to service_role;
