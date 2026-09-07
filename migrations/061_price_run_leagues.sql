-- 061 — AI-968: record WHICH leagues a price run covered, and when it actually started.
--
-- Josh, on the SendBlaster review call: the NBA schedule drops and he wants NBA repriced without
-- paying for or waiting on everything else. Partial refreshes become the normal case, which makes
-- two things that did not matter before start to matter:
--
--   1. "Last refresh: 2h ago" is a lie if that run only covered the WNBA. The tab has to say what
--      was covered, so `leagues` is stored alongside the run.
--   2. The 6h cooldown reads this table. Without the league list it cannot tell a full refresh
--      from a one-league top-up, so refreshing the NBA would block refreshing the NFL ten minutes
--      later. api/price-refresh.js now checks coverage rather than recency alone.
--
-- NULL means "all leagues", so every run recorded before this migration stays correct without a
-- backfill — they were all full refreshes.
--
-- APPLIED-STATE NOTE (the 059 lesson): this is built on 020 + 052, both applied. It does NOT
-- depend on 058 or 060, which are committed but not yet applied, and touches nothing they touch.
--
-- CREATE OR REPLACE, NOT DROP + CREATE. Migration 052 revoked execute on record_price_run from
-- public and anon; a DROP would take that ACL with it and the bare CREATE would hand EXECUTE back
-- to PUBLIC by default, silently reopening a surface 052 deliberately closed. Replace keeps the
-- existing privileges, so 020's grant line is deliberately NOT repeated here.

alter table public.events_master_price_runs
  add column if not exists leagues text[];

comment on column public.events_master_price_runs.leagues is
  'League codes this run covered. NULL = all leagues (also true of every run predating AI-968).';

-- started_at used to be the row default, and the row is inserted AFTER the run finishes — so
-- started_at and finished_at were the same instant and the column was named for something it did
-- not hold. The caller already tracks the real start; take it when offered, keep now() when not,
-- so an older caller is unaffected.
create or replace function public.record_price_run(p jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  insert into public.events_master_price_runs
    (started_at, finished_at, model, eligible, attempted, priced, missing, batches, retried_batches,
     in_tokens, out_tokens, cost_usd, duration_ms, dry_run, notes, leagues)
  values (
    coalesce((p->>'started_at')::timestamptz, now()), now(), p->>'model',
    (p->>'eligible')::int, (p->>'attempted')::int, (p->>'priced')::int, (p->>'missing')::int,
    (p->>'batches')::int, (p->>'retried_batches')::int,
    (p->>'in_tokens')::bigint, (p->>'out_tokens')::bigint,
    (p->>'cost_usd')::numeric, (p->>'duration_ms')::bigint,
    coalesce((p->>'dry_run')::boolean, false), nullif(p->>'notes',''),
    -- Absent, JSON null, or empty => SQL NULL => "all leagues". An empty array would otherwise
    -- read as "covered nothing", which is the opposite of what an unfiltered run did.
    --
    -- The jsonb_typeof guard is load-bearing: the caller sends "leagues": null for a full refresh,
    -- and jsonb_array_elements_text() on a JSON scalar raises "cannot extract elements from a
    -- scalar" — which would abort the insert and lose the whole run log for exactly the common case.
    case when jsonb_typeof(p->'leagues') = 'array'
         then nullif(array(select jsonb_array_elements_text(p->'leagues')), '{}'::text[])
         else null end
  )
  returning id into v_id;
  return v_id;
end;
$function$;
