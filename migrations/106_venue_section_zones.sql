-- 106: section -> zone lookup per venue, so a listing's section can be named (AI-1098).
--
-- EVERY LEAGUE, NOT JUST THE NBA. The NBA map is simply the one that exists today (scraped from
-- RateYourSeats, Oct 6 2026); MLB, NFL and the rest are coming and must not need a schema change
-- or a second table when they do. So the table is keyed on league from the start and the loader
-- takes --league. Adding a sport is then data plus one zone vocabulary, not a migration.
--
-- WHY A TABLE AND NOT A CONSTANT. 903 rows for the NBA alone, and a third of them are "Derived"
-- — placed by counting around the bowl from a midcourt/bench anchor rather than read off a label.
-- Those get corrected as people spot-check them, and a sheet reloaded by a script is how a
-- correction reaches the pipeline without a deploy. scripts/load-section-zones.js loads it.
--
-- ZONE IS FREE TEXT, DELIBERATELY. The NBA's four zones (center court, sideline, corner, behind
-- basket) are meaningless in a ballpark — nobody quotes "center court" at Fenway. A CHECK
-- constraint listing the NBA's vocabulary would have to be dropped and rewritten for every sport
-- added, which is exactly the kind of migration this design is trying to avoid. The vocabulary
-- is enforced where it is known: per league, in the loader. zone_rank carries the ordering
-- (1 = most premium) so callers can rank without knowing the sport's words.
--
-- MIDCOURT IS A SUBSET OF SIDELINE IN THE SOURCE, NOT A SIBLING. The sheet's By Team tab lists
-- Hawks midcourt as 108, 119 and "other sideline" as 107-109, 118-120 — 108 and 119 appear in
-- BOTH. One section must resolve to ONE zone or "center court from $X" is unanswerable, so the
-- loader keeps the most premium label it sees. Deciding that at read time would put the tie-break
-- in every caller instead of once, here.
--
-- CONFIDENCE TRAVELS WITH THE ROW. 'Medium' means the row was derived by counting; the source
-- sheet says verify those before quoting a price, so the warning survives all the way to the
-- operator rather than being lost at the database boundary.

create table if not exists public.venue_section_zones (
  league      text not null,
  team        text not null,
  arena       text not null,
  tier        text not null,
  -- Normalised by the loader: uppercased, non-alphanumerics stripped ('106 CT' -> '106CT'),
  -- because the marketplaces spell the same section a dozen ways and the match must be exact.
  section     text not null,
  zone        text not null,
  -- 1 = most premium. The ordering the offer quotes in, and the tie-break when a section carries
  -- more than one label in the source.
  zone_rank   smallint not null check (zone_rank between 1 and 12),
  -- Which ring the tier is, derived from the tier text by the loader. Per-zone pricing is a
  -- LOWER BOWL question; a mezzanine row repeating the bowl's section numbers (Cavs M101-M126)
  -- would otherwise undercut the quote.
  tier_class  text not null check (tier_class in ('lower_bowl', 'floor', 'club', 'mezzanine', 'upper')),
  source      text,
  confidence  text not null default 'Medium' check (confidence in ('High', 'Medium')),
  loaded_at   timestamptz not null default now(),
  primary key (league, team, tier, section)
);

comment on table public.venue_section_zones is
  'Section -> zone lookup per venue (AI-1098), loaded by scripts/load-section-zones.js from the '
  'arena section-map sheets. Keyed by league: NBA is loaded today, other sports to follow. '
  'One row per league+team+tier+section; the most premium label wins where the source lists a '
  'section twice. zone vocabulary is per league (NBA: center court / sideline / corner / behind '
  'basket), zone_rank orders them 1 = best. confidence=Medium means the row was derived by '
  'counting around the bowl, not read off a label — verify before quoting it.';

-- The hot path is "this NBA listing says section 108, which zone is it".
create index if not exists venue_section_zones_lookup
  on public.venue_section_zones (league, team, section);

-- Reference data, readable by the app like the rest of the directory tables.
alter table public.venue_section_zones enable row level security;

drop policy if exists venue_section_zones_read on public.venue_section_zones;
create policy venue_section_zones_read on public.venue_section_zones
  for select using (true);

grant select on public.venue_section_zones to anon, authenticated;
grant all    on public.venue_section_zones to service_role;
