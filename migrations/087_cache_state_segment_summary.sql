-- 087: stop rebuilding the state/segment grid on every request.
--
-- THE PROBLEM, MEASURED ON PRODUCTION.
--
-- The Offers tab calls event_targets(), which returns 9,640 rows. PostgREST caps a response at
-- 1,000, so ui/index.html paged through it: ten requests, one after another.
--
-- That paging is the bug. A set-returning function cannot have a LIMIT pushed inside it, so
-- every page ran the WHOLE function and then discarded what it did not need. The plan for the
-- last page, LIMIT 1000 OFFSET 9000:
--
--   Function Scan on event_targets  (actual time=1183.342..1184.097 rows=9640 loops=1)
--   Execution Time: 1185.282 ms
--
-- rows=9640 while asking for 640. Ten pages x 1,185ms = ~12 SECONDS of database time per load,
-- for an answer that needed 1,185ms once. pg_stat_statements agreed: 916 calls, 1,104,663ms
-- total, mean 1,206ms. Nothing else in the app is close — get_campaign_queue is 18ms,
-- geo_regions 1ms, market_cooldowns 3ms. This one function was the whole problem.
--
-- And 90% of event_targets() was one line: `with ss as (select * from state_segment_summary())`.
--
--   Function Scan on state_segment_summary  (actual time=1068.098..1068.111 rows=192 loops=1)
--
-- 1,068 of the 1,185ms, to produce 192 ROWS. It re-aggregates ~90,800 market_contacts and
-- ~108,800 company_intel rows to build a 64-state x 3-segment grid of companies/emails/phones.
-- The same 192 numbers, rebuilt ten times per page view, from data that only moves when
-- contacts are imported.
--
-- WHAT THIS DOES.
--
-- 1. Stores that grid as a matview. event_targets() reads 192 stored rows instead of counting
--    200,000 live ones.
-- 2. Adds event_targets_json(), which returns everything as ONE row of JSON. PostgREST's cap
--    counts rows, and one row is under it however much it holds — so the UI stops paging.
--
-- Expected: ~12s -> ~0.15s per Offers load.
--
-- STALENESS IS THE TRADE, AND IT IS HANDLED.
--
-- The counts stop being live. That is the point — "live" is what cost 12 seconds. Three things
-- keep it honest:
--   - the grid carries its own refreshed_at, so the UI can SHOW how old it is rather than
--     going quietly stale;
--   - refresh_market_contacts() rebuilds it, so the existing job already covers the case that
--     actually changes the numbers;
--   - refresh_state_segment_summary() is a cheap (~1.1s) manual refresh for the button in the
--     Offers tab, for when someone has just imported and does not want to wait for the job.
--
-- The unique index exists so that refresh can run CONCURRENTLY: pressing the button must not
-- block anyone who is loading the Offers tab at that moment.
--
-- REVERTING. Nothing is dropped. state_segment_summary() is untouched and still correct; this
-- only stops calling it on the hot path. To back out, restore the one CTE line in
-- event_targets() to `select * from state_segment_summary()` and the old behaviour is back.

begin;

-- ---------------------------------------------------------------- 1. the stored grid
--
-- now() is evaluated when the matview is populated and stored with the rows, so the column is
-- literally "when was this built" without a side table to keep in sync.
create materialized view if not exists public.state_segment_summary_mv as
  select s.*, now() as refreshed_at
  from public.state_segment_summary() s;

-- Required for REFRESH ... CONCURRENTLY. Verified on production before writing this:
-- 192 rows, 0 null code, 0 null segment, 0 duplicate (code, segment) pairs.
create unique index if not exists state_segment_summary_mv_key
  on public.state_segment_summary_mv (code, segment);

grant select on public.state_segment_summary_mv to anon, authenticated, service_role;

-- ---------------------------------------------------------------- 2. event_targets, cached
--
-- Byte-for-byte the function as it stood, with ONE line changed: the ss CTE now reads the
-- matview instead of calling state_segment_summary(). Everything downstream of it -- the
-- column list, the league/sport CASE arms, the ordering -- is deliberately identical, because
-- this migration is a performance change and must not be a behaviour change.
create or replace function public.event_targets()
returns table(event_id text, team text, opponent text, event_date date, ticket_price numeric,
              ticket_url text, league text, sport text, venue text, market_key text,
              state_code text, state_name text, country text, segment text, companies bigint,
              emails bigint, phones bigint, price_source text,
              priced_at timestamp with time zone, price_seats smallint, price_currency text)
language sql stable security definer set search_path to 'public'
as $function$
  with ss as (select * from state_segment_summary_mv)
  select
    em.id::text,
    coalesce(em.team_full, initcap(em.team)),
    initcap(em.opponent),
    em.event_date,
    em.best_price,
    em.price_url,
    upper(em.league),
    case lower(em.league)
      when 'mlb' then 'Baseball'
      when 'nba' then 'Basketball'
      when 'nhl' then 'Ice Hockey'
      when 'nfl' then 'Football'
      -- CFB is football played in a different competition, so it shares the SPORT and is
      -- separated by LEAGUE — which is how nhl/mlb/nfl already work. Without this branch the
      -- CASE falls through to initcap(league) and the Sport filter grows a bogus "Cfb"
      -- sitting next to "Football", splitting one sport across two filter options.
      when 'cfb' then 'Football'
      -- WNBA is its own league sharing the sport, exactly as CFB does with the NFL. Without
      -- this the CASE falls through to initcap(league) and the Sport filter gains a "Wnba"
      -- option beside "Basketball", splitting one sport in two.
      when 'wnba' then 'Basketball'
      else initcap(em.league)
    end,
    em.venue,
    em.market_code,
    em.state_code,
    coalesce(s.name, gr.name),
    coalesce(s.country, gr.country),
    s.segment, s.companies, s.emails, s.phones,
    em.price_source, em.priced_at, em.price_seats, em.price_currency
  from events_master em
  left join geo_region gr on gr.code = em.state_code
  left join ss s on s.code = em.state_code
  where em.event_date >= current_date
  order by em.event_date asc, em.team,
           case s.segment when 'ICP' then 1 when 'SCP' then 2 else 3 end;
$function$;

-- ---------------------------------------------------------------- 3. one row, not ten pages
--
-- The whole result as a single jsonb array. This is what lets the UI stop paging: PostgREST
-- limits ROWS, and this is one row no matter how many events are in it.
--
-- coalesce, because jsonb_agg over zero rows is NULL, and the UI should receive an empty list
-- rather than null on a day with no upcoming events.
create or replace function public.event_targets_json()
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.event_targets() t;
$function$;

grant execute on function public.event_targets_json() to anon, authenticated, service_role;

-- ---------------------------------------------------------------- 4. how old are the counts
--
-- Its own RPC rather than a column on every event row: the UI needs this once per load, and
-- repeating a timestamp across 9,640 rows would pay for it 9,640 times.
create or replace function public.counts_refreshed_at()
returns timestamptz
language sql stable security definer set search_path to 'public'
as $function$
  select max(refreshed_at) from public.state_segment_summary_mv;
$function$;

grant execute on function public.counts_refreshed_at() to anon, authenticated, service_role;

-- ---------------------------------------------------------------- 5. the refresh
--
-- CONCURRENTLY so that pressing the button in the Offers tab does not take an exclusive lock
-- and stall everyone else's page load for the duration. It costs more than a plain refresh,
-- which is irrelevant across 192 rows.
--
-- Returns the new timestamp so the caller can update the "as of" label without a second round
-- trip to counts_refreshed_at().
create or replace function public.refresh_state_segment_summary()
returns timestamptz
language plpgsql security definer set search_path to 'public'
set statement_timeout to '120s'
as $function$
begin
  refresh materialized view concurrently public.state_segment_summary_mv;
  return (select max(refreshed_at) from public.state_segment_summary_mv);
end;
$function$;

-- service_role only. The browser reaches this through /api/refresh-counts, which checks the
-- caller is a signed-in @callplaybook.com user first. Granting it to anon would put a
-- 1-second database job behind a key that ui/config.js publishes to every visitor.
revoke execute on function public.refresh_state_segment_summary() from public, anon, authenticated;
grant execute on function public.refresh_state_segment_summary() to service_role;

-- ---------------------------------------------------------------- 6. the existing job
--
-- refresh_market_contacts() is what actually changes the numbers underneath, so it has to
-- rebuild the grid too or the cache would go stale exactly when it matters most. Appended to
-- the three refreshes already at the end; the body above them is unchanged.
--
-- NOT concurrent here: this runs right after `truncate public.market_contacts`, so it is
-- already inside a transaction that holds heavy locks, and CONCURRENTLY buys nothing.
create or replace function public.refresh_market_contacts()
returns void
language plpgsql security definer set search_path to 'public'
set statement_timeout to '300s'
as $function$
begin
  truncate public.market_contacts;
  insert into public.market_contacts
    (code, state_name, organization_name, city, contact_name, title, phone, email, segment,
     primary_sport)
  select s.code,
         s.name,
         ci.organization_name,
         ci.city,
         nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
         c.title,
         nullif(btrim(c.phone), ''),
         nullif(lower(btrim(c.email)), ''),
         case lower(btrim(coalesce(ci.lead_segment, '')))
           when 'icp' then 'ICP'
           when 'scp' then 'SCP'
           else 'Other'
         end,
         nullif(lower(btrim(coalesce(ci.primary_sport, ''))), '')
  from public.contact_intel c
  join public.company_intel ci on ci.id = c.company_intel_id
  join public.state_alias  sa on sa.alias = upper(btrim(ci.state))
  join public.us_states     s on s.code = sa.code
  where (c.phone is not null and btrim(c.phone) <> '')
     or (c.email is not null and btrim(c.email) <> '');
  refresh materialized view public.market_counts;
  refresh materialized view public.market_segment_counts;
  refresh materialized view public.market_sport_counts;
  refresh materialized view public.state_segment_summary_mv;
end;
$function$;

commit;

-- ---------------------------------------------------------------- check it worked
--
-- Expect: event_targets_ms well under 200 (was ~1185), rows 9640, grid 192.
--
--   explain analyze select * from public.event_targets();
--   select count(*) from public.state_segment_summary_mv;          -- 192
--   select public.counts_refreshed_at();                           -- a timestamp, not null
--   select jsonb_array_length(public.event_targets_json());        -- 9640
