-- REJECT — the operator saying "not this one", in a way the decider can read back.
--
-- Josh, 2026-07-31: "is there a way to reject it and say, don't send this blast... so that it
-- knows not to suggest the same thing again". Today the only way to refuse a blast is
-- queue_delete (045), which DESTROYS the row. The next Trigger Blast run therefore has no
-- idea the refusal ever happened and cheerfully re-queues the same game — the exact loop
-- Josh predicted on the call.
--
-- Reject keeps the row. The refusal becomes data:
--   * the decider reads it and will not re-suggest that game for that segment (21 days), and
--   * the operator's written reason becomes a feedback source for OpenClaw, tagged so recent
--     rejections can be pulled on their own.
--
-- DELETE IS NOT REPLACED. It stays for genuine mistakes and [TEST] rows — things that should
-- leave no trace precisely because they mean nothing. Reject is the one that means something.
--
-- ---------------------------------------------------------------------------------------
-- WHAT A REJECTED ROW DOES AND DOES NOT HOLD. This is the part that is easy to get wrong.
--
-- api/trigger-decide.js collapses three separate jobs into one `live` filter (status not in
-- ('sent','sending')): it counts the per-day slot, it locks the market, and it blocks the
-- event. A rejected row must NOT behave like a live one on the first two, or every rejection
-- silently burns a day slot forever and the queue starves:
--
--   per-day slot   RELEASED — the day can be refilled.
--   market lock    RELEASED — a different game in that market is still fair game, and per Vhea
--                  rejecting one segment puts the market back in the sendable pool.
--   (event, segment) BLOCKED for 21 days — this is the whole point.
--
-- The block is keyed on event AND segment, not event alone. Rejecting the SCP row for a game
-- is a statement about SCP, not about the game: ICP for that same fixture is untouched.
-- Legacy rows carry segment = null and block the event outright, which is the honest reading
-- of a row that was never segment-scoped.
-- ---------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Columns.
--
-- `status` has NO check constraint on this table (verified against the live DB — the
-- constraint in 012 belongs to the abandoned ticketblaster schema, not public), so 'rejected'
-- needs no constraint surgery. Live values are: pending, confirmed, snoozed, sending, sent.
--
-- `segment` is NULLABLE and null means "whole market, not segment-scoped" — which is what
-- every row predating this migration actually is. Backfilling them to 'ICP' would invent a
-- targeting decision nobody made.
-- ---------------------------------------------------------------------------
alter table public.campaign_queue
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_note text,
  add column if not exists segment     text;

comment on column public.campaign_queue.rejected_at is
  'Set by queue_reject(). The decider suppresses this (event_id, segment) for 21 days from here. Reversible via queue_unreject().';
comment on column public.campaign_queue.reject_note is
  'Optional free-text reason the operator gave when rejecting. Josh was explicit that it stays optional — never gate the reject on it. This is what makes the rejection worth feeding back to OpenClaw.';
comment on column public.campaign_queue.segment is
  'ICP | SCP | Other — which audience slice of the market this row targets. NULL = whole market (every row queued before migration 048).';

alter table public.campaign_queue
  drop constraint if exists campaign_queue_segment_check;
alter table public.campaign_queue
  add constraint campaign_queue_segment_check
  check (segment is null or segment in ('ICP', 'SCP', 'Other'));

-- Partial: the decider only ever asks for rows that ARE rejected, and they are the minority.
create index if not exists campaign_queue_rejected_at_idx
  on public.campaign_queue (rejected_at desc) where rejected_at is not null;
create index if not exists campaign_queue_segment_idx
  on public.campaign_queue (segment);

-- ---------------------------------------------------------------------------
-- 2. Reject / unreject.
--
-- Same refusal as queue_delete on a sent or sending row, for the same reason: 'sent' is what
-- market_blast_log points at and what the cooldown is built on, and 'sending' is mid-flight in
-- api/queue-tick.js. Neither can be un-decided after the fact. Enforced HERE rather than in the
-- UI because anon holds execute on these RPCs — a button can be bypassed.
-- ---------------------------------------------------------------------------
create or replace function public.queue_reject(p_id uuid, p_note text default null)
returns public.campaign_queue
language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_status text;
  v_row    public.campaign_queue;
begin
  select status into v_status from public.campaign_queue where id = p_id;
  if v_status is null then
    raise exception 'Blast not found.' using errcode = 'no_data_found';
  end if;
  if v_status in ('sent', 'sending') then
    raise exception 'This blast has already been % — it can be archived, but not rejected.', v_status
      using errcode = 'check_violation';
  end if;

  update public.campaign_queue
     set status      = 'rejected',
         rejected_at = coalesce(rejected_at, now()),
         -- An empty textarea is not a reason. Store null so "no reason given" and "reason was
         -- whitespace" are the same thing downstream.
         reject_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_id
  returning * into v_row;

  return v_row;
end;
$function$;

-- Back to 'pending', and the rejection is FORGOTTEN — rejected_at cleared, so the decider stops
-- suppressing the pair. Un-rejecting while still suppressing it would leave a row the operator
-- has re-approved that the decider refuses to reissue: contradictory, and invisible.
create or replace function public.queue_unreject(p_id uuid)
returns public.campaign_queue
language sql volatile security definer set search_path to 'public'
as $function$
  update public.campaign_queue
     set status = 'pending', rejected_at = null, reject_note = null
   where id = p_id and status = 'rejected'
  returning *;
$function$;

grant execute on function public.queue_reject(uuid, text) to anon, authenticated, service_role;
grant execute on function public.queue_unreject(uuid)     to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2b. Delete keeps its note too — but as HISTORY, not as a rule.
--
-- Josh asked for the notes box on delete specifically: "have a little pop-up that's optional
-- that Cole could put additional context in... every time there's a deletion, I would store
-- that as kind of like its own data source for the open claw". Delete destroys the row, so
-- without somewhere to put it that note would be collected and thrown away — worse than not
-- asking for it.
--
-- DELETIONS DO NOT SUPPRESS. Reject is the considered "not this one" and is what the decider
-- obeys; delete is for mistakes and [TEST] rows, and suppressing those would teach the model
-- from noise. The archive exists so the OpenClaw feed is complete, not so the decider reads it.
-- ---------------------------------------------------------------------------
create table if not exists public.queue_deletions (
  id          bigserial primary key,
  queue_id    uuid,
  event_id    uuid,
  segment     text,
  state_code  text,
  title       text,
  event_date  date,
  note        text,
  deleted_at  timestamptz not null default now()
);

comment on table public.queue_deletions is
  'One row per deleted blast, with the optional reason the operator gave. A record for the OpenClaw feedback feed — the decider does NOT read this. Rejections are what suppress; see queue_rejections(). Migration 048.';

create index if not exists queue_deletions_deleted_at_idx on public.queue_deletions (deleted_at desc);

alter table public.queue_deletions enable row level security;
drop policy if exists queue_deletions_read on public.queue_deletions;
create policy queue_deletions_read on public.queue_deletions for select to anon, authenticated using (true);

grant select on public.queue_deletions to anon, authenticated, service_role;
grant usage, select on sequence public.queue_deletions_id_seq to service_role;

-- Replaces the 1-arg queue_delete from 045. DROPPED rather than overloaded: a defaulted second
-- parameter would leave the existing 1-arg call ambiguous, and PostgREST calls by name.
drop function if exists public.queue_delete(uuid);

create function public.queue_delete(p_id uuid, p_note text default null)
returns uuid
language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_status text;
begin
  select status into v_status from public.campaign_queue where id = p_id;
  if v_status is null then
    raise exception 'Blast not found.' using errcode = 'no_data_found';
  end if;
  if v_status in ('sent', 'sending') then
    -- plpgsql RAISE uses % as the placeholder, not %s — '%s' prints the substitution
    -- followed by a literal 's' ("already been sents").
    raise exception 'This blast has already been % — it can be archived, but not deleted.', v_status
      using errcode = 'check_violation';
  end if;

  -- Written BEFORE the delete, in the same statement-level transaction: if the insert fails the
  -- row survives, which is the safe direction. Losing the row and the record together is not.
  insert into public.queue_deletions (queue_id, event_id, segment, state_code, title, event_date, note)
  select q.id, q.event_id, q.segment, q.state_code, q.title, em.event_date,
         nullif(btrim(coalesce(p_note, '')), '')
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  where q.id = p_id;

  delete from public.campaign_queue where id = p_id;
  return p_id;
end;
$function$;

grant execute on function public.queue_delete(uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. What the decider reads.
--
-- Josh: "whenever you run trigger blast, I'd probably pull all deletions from the last 21 days"
-- — hence the default. Returned newest-first so a prompt that has to truncate keeps the most
-- recent refusals, which are the ones that still describe how Cole is thinking.
--
-- The note comes back too. Suppression alone only stops a repeat; the WRITTEN REASON is what
-- lets the model generalise past the one fixture, and it is the whole point of asking for it.
-- ---------------------------------------------------------------------------
create or replace function public.queue_rejections(p_days integer default 21)
returns table(
  event_id uuid, segment text, event_date date, state_code text, title text,
  team text, opponent text, note text, rejected_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $function$
  select
    q.event_id,
    q.segment,
    em.event_date,
    q.state_code,
    q.title,
    coalesce(em.team_full, q.team) as team,
    coalesce(em.opponent, q.opponent) as opponent,
    q.reject_note as note,
    q.rejected_at
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  where q.rejected_at is not null
    and q.rejected_at > now() - make_interval(days => greatest(1, coalesce(p_days, 21)))
  order by q.rejected_at desc;
$function$;

grant execute on function public.queue_rejections(integer) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Expose the new columns. Return type changes, so drop + recreate (see 044, 045).
--    Rejected rows are still RETURNED — the UI filters them out of the working queue, the same
--    way it already handles archived_at. Nothing that counts or audits the queue loses them.
-- ---------------------------------------------------------------------------
drop function if exists public.get_campaign_queue();

create function public.get_campaign_queue()
 returns table(id uuid, title text, state_code text, state_name text, event_id uuid,
   email boolean, sms boolean, phone_count integer, sms_count integer, ticket_price numeric,
   email_copy text, sms_copy text, scheduled_for timestamp with time zone, status text,
   confirmed_at timestamp with time zone, snooze_count integer, sent_at timestamp with time zone,
   is_placeholder boolean, created_at timestamp with time zone, email_from text, sms_from text,
   email_count integer, team text, opponent text, event_date date, league text, sport text,
   venue text, market_key text, country text, ticket_url text, email_subject text,
   archived_at timestamp with time zone, segment text,
   rejected_at timestamp with time zone, reject_note text)
 language sql stable security definer set search_path to 'public'
as $function$
  select
    q.id, q.title, q.state_code, q.state_name, q.event_id,
    q.email, q.sms,
    case when q.status = 'sent' then q.phone_count
         else coalesce(mc.phone_count::int, q.phone_count) end as phone_count,
    case when q.status = 'sent' then q.sms_count
         else coalesce(mc.phone_count::int, q.sms_count) end   as sms_count,
    coalesce(q.ticket_price, em.best_price) as ticket_price,
    q.email_copy, q.sms_copy, q.scheduled_for, q.status, q.confirmed_at,
    q.snooze_count, q.sent_at, q.is_placeholder, q.created_at,
    q.email_from, q.sms_from,
    case when q.status = 'sent' then q.email_count
         else coalesce(mc.email_count::int, q.email_count) end as email_count,
    coalesce(em.team_full, initcap(nullif(btrim(q.team), '')), q.team)      as team,
    coalesce(initcap(nullif(btrim(em.opponent), '')), q.opponent)           as opponent,
    em.event_date,
    upper(em.league) as league,
    case lower(em.league)
      when 'mlb' then 'Baseball'
      when 'nba' then 'Basketball'
      when 'nhl' then 'Ice Hockey'
      when 'nfl' then 'Football'
      else initcap(em.league)
    end as sport,
    em.venue,
    em.market_code as market_key,
    gr.country,
    em.price_url as ticket_url,
    q.email_subject,
    q.archived_at,
    q.segment,
    q.rejected_at,
    q.reject_note
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- NOTE FOR THE JS SIDE — this migration is only half the change.
--
-- api/trigger-decide.js and api/queue-tick.js both treat every row with status not in
-- ('sent','sending') as live, so a rejected row would keep holding its day slot and its market
-- lock. trigger-decide.js must be updated alongside this:
--
--   live      = status not in ('sent','sending','rejected')     -- slot + market lock
--   suppressed = queue_rejections(21) keyed on (event_id, segment)
--
-- Until that lands, rejecting a blast frees nothing and blocks nothing.
-- ---------------------------------------------------------------------------
