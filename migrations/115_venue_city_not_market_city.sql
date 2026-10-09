-- 115: youth_event_venues.market_city holds the VENUE's city, so call it venue_city (AI-1086).
--
-- THE BUG. Two tables carried a column called market_city and it meant different things:
--
--   market_season_calendar.market_city   the ONE chosen city per state — Huntsville for Alabama
--   youth_event_venues.market_city       the city the VENUE is in    — Tuscaloosa, Auburn, …
--
-- So the obvious join did not work, and worse, it half-worked. Measured before this migration:
-- 50 distinct (city, state) pairs in youth_event_venues against 18 in market_season_calendar,
-- with 37 venue cities matching no market row and 5 markets holding no venue. Alabama has seven
-- venue cities while its market is Huntsville, which has exactly one venue — so a join on
-- market_city silently dropped Bryant-Denny and Jordan-Hare, the two venues anyone would
-- actually want.
--
-- Josh's rule on the Oct 1 call was that venues are matched TO markets and the knowledge base
-- takes the biggest city in the market. That makes one market per state correct, and makes the
-- venue table's column a venue attribute that was given a market's name. Renaming it is the
-- whole fix: the DATA was right, the label was wrong, and the label is what made people join
-- the wrong columns.
--
-- THE MARKET KEY IS state_code. It always was — it is the only column the two tables share
-- whose meaning matches. A view is added below so that join has one definition instead of being
-- rewritten from memory at each call site.
--
-- Safe to run twice. Nothing is dropped and no row changes.

-- ---------------------------------------------------------------------------------------------
-- The rename
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'youth_event_venues' and column_name = 'market_city'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'youth_event_venues' and column_name = 'venue_city'
  ) then
    alter table public.youth_event_venues rename column market_city to venue_city;
  end if;
end $$;

comment on column public.youth_event_venues.venue_city is
  'The city this VENUE is in (Tuscaloosa, Auburn). NOT the market — a market is one city per '
  'state and lives in market_season_calendar.market_city (Huntsville for all of Alabama). The '
  'two are joined on state_code, never on a city name: 37 of 50 venue cities match no market.';

-- The index was named for the old column. Renaming it keeps the name honest; the index itself is
-- unchanged and still covers (state_code, <city>).
do $$
begin
  if exists (select 1 from pg_class where relname = 'youth_event_venues_market' and relkind = 'i') then
    alter index public.youth_event_venues_market rename to youth_event_venues_state_city;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- One definition of the join
-- ---------------------------------------------------------------------------------------------
--
-- Every venue with the market it belongs to and that market's send timing, joined on state_code.
-- A LEFT join on purpose: a venue in a state whose calendar row is missing is still a venue we
-- could host at, and hiding it would make the list quietly shorter than the table it reads.
--
-- market_city is carried through under its own name so a caller can see BOTH cities at once —
-- which is the thing that was impossible to see when both columns were called market_city.
create or replace view public.youth_event_venues_with_market as
select
  v.id,
  v.state_code,
  v.state_name,
  v.venue_city,
  c.market_city,
  -- True when the venue happens to sit in the market's own city. One venue in Alabama does; six
  -- do not. Exposed rather than left to be worked out, because "is this venue in the market we
  -- time sends for?" is the question the mismatch made unanswerable.
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
  c.verified_at as market_verified_at
from public.youth_event_venues v
-- A plain left join on state_code, and nothing more. An earlier draft wrapped the calendar in a
-- subquery that joined it BACK to the venues to work out in_market_city — which would have
-- produced one row per matching venue and quietly multiplied the 89 rows.
left join public.market_season_calendar c on c.state_code = v.state_code;

comment on view public.youth_event_venues_with_market is
  'Venues joined to their market on STATE_CODE (AI-1086). The join is state-level because a '
  'market is one city per state and most venues are in other cities — see 115. in_market_city '
  'flags the few venues that do sit in the market city.';

grant select on public.youth_event_venues_with_market to anon, authenticated;
grant select on public.youth_event_venues_with_market to service_role;
