-- 082: stop the daily audience rebuild timing out.
--
-- THE FAILURE
--
-- /api/refresh-contacts — the daily cron that rebuilds market_contacts and the reach counts —
-- has been returning 500 since migration 080:
--
--     {"code":"57014","message":"canceling statement due to statement timeout"}
--
-- Not a broken query. refresh_market_contacts() runs fine in the SQL editor, which is why 080
-- applied cleanly: that session has a generous timeout. PostgREST does not, and the RPC path is
-- how the cron calls it.
--
-- WHY IT GOT SLOW, AND IT WAS MY DOING. Two migrations added cost to the same statement:
--
--   073 changed market_counts and market_segment_counts from count(*) to
--       count(distinct sendable_phone(phone)) / sendable_email(email) — a function call per row
--       across ~82,000 rows, twice per view.
--   080 added a THIRD matview on the same pattern, at a finer grain (code x segment x sport).
--
-- Each was right on its own. Together they pushed one statement past the limit, and the symptom
-- landed somewhere neither migration touched.
--
-- WHAT IT COSTS WHILE BROKEN. market_contacts stops being rebuilt, so every reach figure in the
-- UI slowly goes stale — which is the exact bug api/refresh-contacts.js was written to fix. Its
-- own header says it: "every reach number in the UI has been as old as the last time someone ran
-- it by hand." A market that gains contacts reads empty; one that loses them reads full.
--
-- TWO FIXES, because either alone leaves it fragile.

-- ---------------------------------------------------------------------------
-- 1. Halve the work. sendable_phone called norm_phone_e164 TWICE per row — once to test the
--    result and once to return it. Postgres will not collapse those: the function is IMMUTABLE,
--    but that permits caching, it does not promise it inside a single expression.
--
--    Rewritten to normalise once. Same output for every input — the test and the returned value
--    were always the same call, which is exactly why doing it twice was waste rather than logic.
-- ---------------------------------------------------------------------------
create or replace function public.sendable_phone(p text)
returns text
language sql
immutable
parallel safe
set search_path to 'public'
as $function$
  select case when v ~ '^\+[0-9]{10,15}$' then v end
  from (select public.norm_phone_e164(p) as v) t;
$function$;

-- Same treatment: lower(btrim(...)) was computed twice, and PARALLEL SAFE lets the planner use
-- more than one worker on an aggregate over 82,000 rows. Both functions are pure.
create or replace function public.sendable_email(e text)
returns text
language sql
immutable
parallel safe
set search_path to 'public'
as $function$
  select case when v ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then v end
  from (select lower(btrim(coalesce(e, ''))) as v) t;
$function$;

-- norm_phone_e164 is called by both and was never marked parallel safe. It is pure.
create or replace function public.norm_phone_e164(p text)
returns text
language sql
immutable
parallel safe
set search_path to 'public'
as $function$
  with d as (select regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g') as v)
  select case
           when v = ''                              then null
           when left(v, 1) = '+'                    then v
           when length(v) = 10                      then '+1' || v
           when length(v) = 11 and left(v, 1) = '1' then '+'  || v
           else v
         end
  from d;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Give the rebuild room, on the function itself.
--
-- Faster is not the same as fast enough, and this job grows with the contact base: it truncates
-- and reinserts ~82,000 rows and refreshes three materialized views. Tuning it to just under the
-- limit would mean it breaks again silently the next time the data grows — which is precisely
-- how it broke this time.
--
-- Scoped to THIS FUNCTION, not the role or the database. Every other statement keeps the short
-- timeout that protects the API from a runaway query; only the one job that legitimately takes
-- minutes is allowed them. SECURITY DEFINER already makes it run as its owner, so the setting
-- travels with the function rather than depending on who calls it.
--
-- 5 minutes against a job that should take seconds: a ceiling to catch a genuine hang, not a
-- target. api/refresh-contacts.js sets maxDuration 60, so Vercel gives up first on the HTTP path
-- — the work still completes in the database, and the next run is a no-op rebuild either way.
-- ---------------------------------------------------------------------------
alter function public.refresh_market_contacts() set statement_timeout = '300s';

comment on function public.refresh_market_contacts() is
  'Rebuilds market_contacts from contact_intel/company_intel and refreshes market_counts, '
  'market_segment_counts and market_sport_counts. Carries its own 300s statement_timeout '
  '(migration 082) because the default PostgREST timeout killed it once the counts became '
  'distinct-and-sendable (073) and gained a third view (080).';

-- The three views are rebuilt by the function above; this leaves the data correct now rather
-- than at the next cron.
select public.refresh_market_contacts();
