-- 057: per-event rescan support.
--
-- events_master has never been able to say anything about a game except when it is. There is
-- no lifecycle field, so a cancelled game is indistinguishable from a scheduled one, and the
-- loader is append-only (on conflict do nothing) so a moved game inserts a SECOND row while
-- the original — the one every queued blast points at — keeps its old date forever.
--
-- This adds the two columns needed to record what a rescan found, and one RPC to apply it to a
-- single named event. Deliberately NOT a change to upsert_events_master: the bulk loader stays
-- append-only, because making it authoritative over dates is a much larger behavioural change
-- and a bad source response would then overwrite good data across a whole season. A rescan is
-- one game, asked for by a person, applied on its own.

alter table public.events_master
  add column if not exists schedule_state      text,
  add column if not exists schedule_checked_at timestamptz;

comment on column public.events_master.schedule_state is
  'Lifecycle as last reported BY THE SOURCE: scheduled | postponed | cancelled | suspended. '
  'NULL means never checked, or the source publishes no such field (nflverse does not) — it '
  'does NOT mean scheduled. Only api/rescan-event.js writes this.';
comment on column public.events_master.schedule_checked_at is
  'When a rescan last got an answer about this game. NULL = never rescanned. Unreachable and '
  'unsupported attempts do not stamp it: nothing was learned.';

-- Apply one rescan result. Returns the row as it now stands plus how many live queued blasts
-- point at it, so the caller can tell the operator what the change touched without a second
-- round trip.
--
-- Every argument is nullable and a NULL leaves that column alone. A source with no lifecycle
-- field (NFL) must be able to correct a date without asserting a state it cannot observe.
create or replace function public.rescan_apply_event(
  p_event_id   uuid,
  p_event_date date        default null,
  p_event_time time        default null,
  p_venue      text        default null,
  p_state      text        default null
)
returns table (
  event_id uuid, event_date date, event_time time, venue text,
  schedule_state text, schedule_checked_at timestamptz, affected_queue_rows integer
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if p_event_id is null then
    raise exception 'rescan_apply_event: p_event_id is required';
  end if;

  if p_state is not null and p_state not in ('scheduled','postponed','cancelled','suspended') then
    raise exception 'rescan_apply_event: unknown schedule_state %', p_state;
  end if;

  update public.events_master em
     set event_date          = coalesce(p_event_date, em.event_date),
         event_time          = coalesce(p_event_time, em.event_time),
         venue               = coalesce(nullif(btrim(p_venue), ''), em.venue),
         schedule_state      = coalesce(p_state, em.schedule_state),
         schedule_checked_at = now(),
         updated_at          = now()
   where em.id = p_event_id
  returning em.id into v_id;

  if v_id is null then
    raise exception 'rescan_apply_event: no event with id %', p_event_id
      using errcode = 'no_data_found';
  end if;

  return query
    select em.id, em.event_date, em.event_time, em.venue,
           em.schedule_state, em.schedule_checked_at,
           (select count(*)::int from public.campaign_queue q
             where q.event_id = em.id
               and q.status not in ('sent','sending','rejected')
               and q.archived_at is null)
    from public.events_master em
    where em.id = v_id;
end;
$function$;

-- Matches the ACL every other function in this schema carries. See the note in migration 056:
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, so listing it here is describing what
-- Postgres already did rather than adding anything. When 052 closes anon it must close PUBLIC
-- for this function too.
grant execute on function public.rescan_apply_event(uuid, date, time, text, text)
  to public, anon, authenticated, service_role;
