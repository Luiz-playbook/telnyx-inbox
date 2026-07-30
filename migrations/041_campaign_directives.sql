-- Cole directives: durable operator feedback that steers the queueing decision across runs.
-- See docs/OPENCLAW_QUEUE_RULES.md §4. The Campaign Agent (OpenClaw) chooses which markets go
-- into the queue; a human's standing instruction ("don't send Nashville for 4 days", "push
-- Columbus to the front") must persist beyond the chat that created it — Thursday's run in a
-- fresh session with no history must still obey Monday's directive. Chat memory alone is too
-- soft for a hard rule, so directives live here as structured rows the decider loads each run.
--
--   block  — remove the market from the candidate set. ABSOLUTE: overrides even a SQL-floor
--            'send'. It can only make the agent MORE restrictive.
--   boost  — prefer the market when ranking. ADVISORY: reorders within the already-approved
--            set only; it can NEVER unlock a market the safety floor (§1) rejected.
--
-- market_key matches rpc_event_recommendations().market_key (e.g. 'nashville', 'new_york'), so
-- an active directive lines up directly with the candidate set.

create table if not exists public.campaign_directives (
  id              uuid primary key default gen_random_uuid(),
  market_key      text not null,
  state_code      text,
  kind            text not null check (kind in ('block','boost')),
  note            text not null,                 -- the operator's own words, verbatim
  created_by      text not null default 'cole',
  effective_from  date not null default current_date,
  effective_until date not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists campaign_directives_market_until_idx
  on public.campaign_directives (market_key, effective_until);

-- Reachable only through the SECURITY DEFINER RPCs below (RLS on + no policies = no direct rows).
alter table public.campaign_directives enable row level security;

-- The block/boost list the decider loads before every run: unrevoked and not yet expired.
create or replace function public.campaign_directives_active()
returns setof public.campaign_directives
language sql
security definer
set search_path to 'public'
as $function$
  select *
    from public.campaign_directives
   where revoked_at is null
     and effective_until >= current_date
   order by kind, market_key;
$function$;

-- Add (or supersede) a directive.
--   p = { market_key, kind, note, state_code?, effective_from?, effective_until?, created_by? }
-- A new directive for the same market+kind supersedes the prior active one (so "block Nashville
-- for 4 days" then "block Nashville until the 12th" replaces, not stacks). If effective_until is
-- omitted it defaults to +7 days (doc §4.2 default for a block with no stated duration).
create or replace function public.campaign_directive_add(p jsonb)
returns public.campaign_directives
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r public.campaign_directives;
begin
  if coalesce(p->>'market_key', '') = '' then raise exception 'market_key required'; end if;
  if coalesce(p->>'kind', '') not in ('block', 'boost') then raise exception 'kind must be block or boost'; end if;
  if coalesce(p->>'note', '') = '' then raise exception 'note required'; end if;

  update public.campaign_directives
     set revoked_at = now()
   where market_key = p->>'market_key'
     and kind = p->>'kind'
     and revoked_at is null
     and effective_until >= current_date;

  insert into public.campaign_directives
    (market_key, state_code, kind, note, created_by, effective_from, effective_until)
  values (
    p->>'market_key',
    nullif(p->>'state_code', ''),
    p->>'kind',
    p->>'note',
    coalesce(nullif(p->>'created_by', ''), 'cole'),
    coalesce((p->>'effective_from')::date, current_date),
    coalesce((p->>'effective_until')::date, current_date + 7)
  )
  returning * into r;
  return r;
end;
$function$;

-- Soft-revoke a directive (Cole: "Nashville is fine now"). Returns the row, or nothing if the id
-- is unknown or already revoked.
create or replace function public.campaign_directive_revoke(p_id uuid)
returns public.campaign_directives
language sql
security definer
set search_path to 'public'
as $function$
  update public.campaign_directives
     set revoked_at = now()
   where id = p_id and revoked_at is null
  returning *;
$function$;

grant execute on function public.campaign_directives_active()        to anon, authenticated, service_role;
grant execute on function public.campaign_directive_add(jsonb)       to anon, authenticated, service_role;
grant execute on function public.campaign_directive_revoke(uuid)     to anon, authenticated, service_role;
