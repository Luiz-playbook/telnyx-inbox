-- 116: let a venue be edited by hand without the loader undoing it (AI-1086).
--
-- THE PROBLEM THIS SOLVES. youth_event_venues is filled by scripts/load-greenfield-venues.js
-- from data/greenfield-venues.csv, and that loader REPLACES the table's contents. The venue
-- names in it are explicitly a research starting point — 39 of 89 are still flagged Medium,
-- meaning nobody has checked them against the organisation's own site. The whole point of
-- letting someone edit a row is to fix those.
--
-- Without this flag, the next loader run silently throws that work away. Worse, it throws it
-- away quietly and at an unrelated moment, so the person who corrected a venue name in October
-- discovers in December that it has been wrong again for weeks.
--
-- So: a row the UI has written sets edited_by_hand, and the loader leaves those rows alone. The
-- flag is set by the ROUTE, not by the caller — a client that could clear it could also hand its
-- own edit back to the loader.
--
-- Safe to run twice.

alter table public.youth_event_venues
  add column if not exists edited_by_hand boolean not null default false;

comment on column public.youth_event_venues.edited_by_hand is
  'True when a person created or changed this row through api/venues.js. '
  'scripts/load-greenfield-venues.js SKIPS these rows, so a hand-corrected venue name survives '
  'the next load. Set by the route, never by the caller.';

-- Partial index: the loader asks "which rows must I leave alone", and that is a small subset.
create index if not exists youth_event_venues_edited
  on public.youth_event_venues (state_code) where edited_by_hand;

-- ---------------------------------------------------------------------------------------------
-- The view gains the flag and the id, so the Venues tab can edit what it is displaying
-- ---------------------------------------------------------------------------------------------
--
-- CREATE OR REPLACE VIEW CAN ONLY APPEND A COLUMN, NEVER INSERT ONE.
--
-- Postgres matches the new select list against the old one BY POSITION, so a column added in the
-- middle is read as renaming everything after it. The first version of this migration put
-- edited_by_hand next to the other youth_event_venues columns, which looked tidy and failed:
--
--   ERROR: 42P16: cannot change name of view column "school_district" to "edited_by_hand"
--   HINT:  Use ALTER VIEW ... RENAME COLUMN ...
--
-- The hint is a red herring here — nothing is being renamed, a column is being added. So the
-- first 22 columns below are byte-for-byte 115's list in 115's order, and edited_by_hand is
-- appended at the end. Column order in a view nothing selects by position is cosmetic; being
-- able to run the migration is not.
--
-- Recreated in full rather than altered because a view has no ALTER ... ADD COLUMN, and spelling
-- it out keeps 115's definition and this one from drifting apart across two files.
create or replace view public.youth_event_venues_with_market as
select
  v.id,
  v.state_code,
  v.state_name,
  v.venue_city,
  c.market_city,
  (c.market_city is not null and lower(v.venue_city) = lower(c.market_city)) as in_market_city,
  v.org,
  v.level,
  v.venue,
  v.venue_type,
  v.sports,
  v.confidence,
  v.notes,
  c.school_district,
  c.athletics_body,
  c.school_first_day,
  c.school_last_day,
  c.fall_sports_start,
  c.winter_sports_start,
  c.spring_sports_start,
  c.summer_sports_start,
  c.verified_at as market_verified_at,
  -- APPENDED, for the reason above. Everything before this line is 115's list in 115's order.
  v.edited_by_hand
from public.youth_event_venues v
-- A plain left join on state_code, and nothing more — see 115 on why a venue's market is its
-- state's market, and why joining on a city name matches 13 of 50.
left join public.market_season_calendar c on c.state_code = v.state_code;

comment on view public.youth_event_venues_with_market is
  'Venues joined to their market on STATE_CODE (AI-1086). The join is state-level because a '
  'market is one city per state and most venues are in other cities — see 115. in_market_city '
  'flags the few that do sit in the market city; edited_by_hand flags the rows the loader skips.';

grant select on public.youth_event_venues_with_market to anon, authenticated;
grant select on public.youth_event_venues_with_market to service_role;
