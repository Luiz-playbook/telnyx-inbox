-- Master events table (AI-826): the authoritative, frozen game list.
--
-- WHY THIS EXISTS:
--   Games used to come from an open-ended LLM scrape, which hallucinated 2027 games
--   in the demo. Schedules do NOT change once a league releases them, so we load the
--   game list ONCE from a deterministic schedule API (MLB StatsAPI first) and store it.
--   After that, the ONLY field an LLM ever touches is price (AI-827/828). Game, team,
--   opponent, date, venue are never LLM-guessed again.
--
--   Distinct from public.icp_events (that is suite-level *booking* data — filled_pct,
--   price_per_person, booking_url). events_master is the raw schedule spine.
--
-- Target project: Playbook n8n (snfmggrnyjayuuxafats), same as the ticketblaster work.
-- Additive.

create table if not exists public.events_master (
  id            uuid primary key default gen_random_uuid(),

  -- league + matchup
  league        text not null,                        -- mlb | nba | nfl | nhl | ncaa...
  team          text not null,                        -- HOME team, nickname-cased to match market_bridge_team (e.g. 'cubs')
  team_full     text,                                 -- display name, e.g. 'Chicago Cubs'
  opponent      text not null,                        -- AWAY team
  event_date    date not null,
  event_time    time,                                 -- UTC (MLB gameDate is UTC); see source_note
  venue         text,
  home_away     text not null default 'home'          -- these rows are the home team's slate
                  check (home_away in ('home','away')),

  -- market / state, resolved at write time from the same bridge the decider uses.
  -- null = no market defined for this team (AI-829 territory) — row is KEPT, just unassigned.
  market_code   text,                                 -- market_bridge_team.market_key
  state_code    text,                                 -- market_state.state_code

  -- price: NULL at preload. Filled + refreshed separately by AI-827/AI-828. Never touched here.
  best_price    numeric,
  price_source  text,
  priced_at     timestamptz,

  -- provenance — every row traceable to a source (AI-826 acceptance)
  external_id   text,                                 -- upstream stable id, e.g. MLB gamePk
  source_url    text not null,                        -- exact API call this row came from
  source_note   text,
  season        text not null,                        -- e.g. '2026-mlb' — AI-830 refresh scoping

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- portable dedupe key across all leagues (AI-830 upserts against this)
  unique (league, team, opponent, event_date)
);

create index if not exists events_master_league_date_idx on public.events_master (league, event_date);
create index if not exists events_master_market_idx       on public.events_master (market_code);
create index if not exists events_master_season_idx       on public.events_master (season);
create unique index if not exists events_master_external_idx
  on public.events_master (league, external_id) where external_id is not null;

-- reuse the existing updated_at helper
drop trigger if exists events_master_set_updated_at on public.events_master;
create trigger events_master_set_updated_at
  before update on public.events_master
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS. Same testing posture as the rest of the ticketblaster stack:
-- writes go through a SECURITY DEFINER rpc, anon may read.
-- =====================================================================
alter table public.events_master enable row level security;
grant all on public.events_master to anon, authenticated, service_role;

drop policy if exists events_master_anon_read on public.events_master;
create policy events_master_anon_read on public.events_master for select to anon using (true);

-- =====================================================================
-- upsert_events_master — the ONE write path. Loader (AI-826 first load) and the
-- season-refresh job (AI-830) both call this. Resolves market_code/state_code here
-- so callers never need to know the bridge. Idempotent: existing games are left
-- untouched (do nothing on conflict), so re-runs and overlapping refreshes are safe.
--
-- Returns one row per input: {inserted: bool, matched_market: bool} for a change log.
-- =====================================================================
drop function if exists public.upsert_events_master(jsonb);
create or replace function public.upsert_events_master(p_rows jsonb)
returns table(out_id uuid, out_inserted boolean, out_team text, out_opponent text, out_date date, out_market text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
  v_team text;
  v_market text;
  v_state text;
  v_id uuid;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    v_team := lower(btrim(r->>'team'));

    -- market resolution: same join the decider uses (bridge -> market_state)
    select tb.market_key, ms.state_code
      into v_market, v_state
      from market_bridge_team tb
      left join market_state ms on ms.market_key = tb.market_key
     where tb.team_lc = v_team
     limit 1;

    insert into public.events_master
      (league, team, team_full, opponent, event_date, event_time, venue, home_away,
       market_code, state_code, external_id, source_url, source_note, season)
    values (
      lower(btrim(r->>'league')),
      v_team,
      nullif(r->>'team_full',''),
      btrim(r->>'opponent'),
      (r->>'event_date')::date,
      (nullif(r->>'event_time',''))::time,
      nullif(r->>'venue',''),
      coalesce(nullif(r->>'home_away',''), 'home'),
      v_market,
      v_state,
      nullif(r->>'external_id',''),
      r->>'source_url',
      nullif(r->>'source_note',''),
      r->>'season'
    )
    on conflict (league, team, opponent, event_date) do nothing
    returning id into v_id;

    return query select
      v_id,
      (v_id is not null),
      v_team,
      btrim(r->>'opponent'),
      (r->>'event_date')::date,
      v_market;
  end loop;
end;
$function$;

grant execute on function public.upsert_events_master(jsonb) to anon, authenticated, service_role;
