-- 106: NBA section -> zone lookup, so a listing's section can be named (AI-1089).
--
-- WHY A TABLE AND NOT A CONSTANT. The map is a scrape of RateYourSeats (Oct 6 2026) kept in a
-- Google Sheet, 907 section rows over 30 teams, and it is still being corrected: a third of it is
-- "Derived" — placed by counting around the bowl from a midcourt/bench anchor rather than read off
-- a label. Those rows get fixed as people spot-check them, and a sheet reloaded by a script is
-- how a correction reaches the pipeline without a deploy. scripts/load-nba-zones.js loads it.
--
-- ZONES. Four, from best to worst, which is also what the premium offer quotes:
--   center court   the midcourt sections, dead on the halfway line
--   sideline       the rest of the sideline block, still between the baskets
--   corner         the diagonals
--   behind basket  the baselines
--
-- MIDCOURT IS A SUBSET OF SIDELINE IN THE SOURCE, NOT A SIBLING. The sheet's By Team tab lists
-- Hawks midcourt as 108, 119 and "other sideline" as 107, 108, 109, 118, 119, 120 — 108 and 119
-- appear in BOTH, and its Read Me says "Midcourt + Other sideline = sections between the baskets".
-- So the By Section tab carries two rows for those sections. One section must resolve to ONE zone
-- or "center court from $X" is unanswerable, so the loader keeps the most premium label it sees
-- and zone_rank below is what "most premium" means. Storing both and deciding at read time would
-- put that tie-break in every caller instead of once, here.
--
-- CONFIDENCE TRAVELS WITH THE ROW. 'Medium' means Derived, i.e. positioned by counting. The sheet
-- says verify those before quoting a price, so the column is kept and the pipeline can refuse to
-- quote a Medium row even when it matched cleanly.

create table if not exists public.nba_section_zones (
  team        text not null,
  arena       text not null,
  tier        text not null,
  -- Normalised by the loader: uppercased, spaces stripped ('106 CT' -> '106CT'), because the
  -- marketplaces spell the same section a dozen ways and the match has to be exact.
  section     text not null,
  zone        text not null check (zone in ('center court', 'sideline', 'corner', 'behind basket')),
  zone_rank   smallint not null check (zone_rank between 1 and 4),
  -- Which ring the tier is, derived from the tier text by the loader. The per-zone cheapest price
  -- is a LOWER BOWL question (Josh: "the 100 level and the 00 sections"); a mezzanine row carrying
  -- the same section numbers as the bowl (Cavs M101-M126) would otherwise undercut it.
  tier_class  text not null check (tier_class in ('lower_bowl', 'floor', 'club', 'mezzanine', 'upper')),
  source      text,
  confidence  text not null default 'Medium' check (confidence in ('High', 'Medium')),
  loaded_at   timestamptz not null default now(),
  primary key (team, tier, section)
);

comment on table public.nba_section_zones is
  'NBA section -> zone lookup from the NBA_Arena_Section_Map sheet (AI-1089). Loaded by '
  'scripts/load-nba-zones.js. One row per team+tier+section; midcourt wins over sideline where '
  'the source lists a section as both. confidence=Medium means the row was derived by counting '
  'around the bowl, not read off a label — verify before quoting it.';

-- The hot path is "this listing says section 108, which zone is it": team + section, any tier.
create index if not exists nba_section_zones_lookup
  on public.nba_section_zones (team, section);

-- The lookup is reference data, readable by the app like the rest of the directory tables.
alter table public.nba_section_zones enable row level security;

drop policy if exists nba_section_zones_read on public.nba_section_zones;
create policy nba_section_zones_read on public.nba_section_zones
  for select using (true);

grant select on public.nba_section_zones to anon, authenticated;
grant all    on public.nba_section_zones to service_role;
