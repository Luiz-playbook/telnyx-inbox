-- Cancelled / postponed games.
--
-- THE GAP THIS CLOSES: events_master had no way to say a game isn't happening. The loader is
-- insert-only (`on conflict do nothing`), so a game that gets cancelled upstream stayed in the
-- table forever, kept passing the queue's only date guard (event_date < today, api/queue-tick.js),
-- and blasted tickets for a game that does not exist. Postponement was worse: the dedupe key is
-- (league, team, opponent, event_date), so a game moved to a new date came back as a SECOND row —
-- the dead original and its replacement, both priced, both sendable.
--
-- THE SIGNAL IS UPSTREAM STATUS, NOT ABSENCE. A game missing from a feed is ambiguous (partial
-- response, changed window, a source that only returns unplayed games). Every loader here reads
-- an explicit status field instead, and a row is only ever moved off 'scheduled' because a source
-- said so. Absence changes nothing.
--
-- POSTPONED WITH NO NEW DATE HOLDS INDEFINITELY (decided 2026-08-10). It does not auto-cancel:
-- most postponements resolve within days, and when the source publishes the new date the row is
-- updated in place (below) so the queue row — which joins events_master — simply follows it.

-- ---------------------------------------------------------------------------
-- 1. Status on the spine.
--
-- rescheduled_to is for the case where a moved game cannot be updated in place because its new
-- date collides with an existing row: the old row is parked as 'postponed' and points at the row
-- that replaced it, so the history stays traceable instead of being silently deleted.
-- ---------------------------------------------------------------------------
alter table public.events_master
  add column if not exists status         text not null default 'scheduled',
  add column if not exists status_seen_at timestamptz,
  add column if not exists rescheduled_to uuid references public.events_master(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_master_status_chk') then
    alter table public.events_master
      add constraint events_master_status_chk
      check (status in ('scheduled','postponed','cancelled'));
  end if;
end $$;

-- Partial: the queue/price/decider paths all ask "is this game off?", which is the small side.
create index if not exists events_master_status_idx
  on public.events_master (status) where status <> 'scheduled';

comment on column public.events_master.status is
  'scheduled | postponed | cancelled. Set only from an explicit upstream status field, never from a game being absent from a feed.';

-- ---------------------------------------------------------------------------
-- 2. upsert_events_master — no longer insert-only.
--
-- Still idempotent, still the ONE write path. What changes: when a row carries an external_id we
-- match on (league, external_id) FIRST — the identity that survives a date change — and then
--   * a changed status is written through (including back to 'scheduled': games get un-postponed),
--   * a changed date updates the row IN PLACE rather than inserting a duplicate.
--
-- Rows with no external_id keep exactly the old behaviour: insert, conflict do nothing.
--
-- The return type gains out_outcome so the change log can distinguish "nothing to do" from
-- "this game moved" — added rather than replacing out_inserted, which scripts/load-schedule.js
-- uses to count added_ids.
-- ---------------------------------------------------------------------------
drop function if exists public.upsert_events_master(jsonb);
create or replace function public.upsert_events_master(p_rows jsonb)
returns table(out_id uuid, out_inserted boolean, out_team text, out_opponent text,
              out_date date, out_market text, out_outcome text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
  v_team text; v_market text; v_state text; v_id uuid;
  v_league text; v_ext text; v_opp text; v_new_date date; v_status text;
  v_existing_id uuid; v_existing_date date; v_existing_status text;
  v_clash uuid; v_outcome text; v_inserted boolean;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    v_league   := lower(btrim(r->>'league'));
    v_team     := lower(btrim(r->>'team'));
    v_opp      := btrim(r->>'opponent');
    v_ext      := nullif(r->>'external_id','');
    v_new_date := (r->>'event_date')::date;

    -- Unknown/garbage status is treated as 'scheduled'. A source inventing a state we don't model
    -- must not be able to silently take a game out of circulation.
    v_status := lower(coalesce(nullif(r->>'status',''), 'scheduled'));
    if v_status not in ('scheduled','postponed','cancelled') then v_status := 'scheduled'; end if;

    -- market resolution: same join the decider uses (bridge -> market_state)
    select tb.market_key, ms.state_code
      into v_market, v_state
      from market_bridge_team tb
      left join market_state ms on ms.market_key = tb.market_key
     where tb.team_lc = v_team
     limit 1;

    v_id := null; v_existing_id := null; v_outcome := 'unchanged'; v_inserted := false;

    if v_ext is not null then
      select id, event_date, status
        into v_existing_id, v_existing_date, v_existing_status
        from public.events_master
       where league = v_league and external_id = v_ext
       limit 1;
    end if;

    if v_existing_id is not null then
      v_id := v_existing_id;

      if v_status is distinct from v_existing_status then
        update public.events_master
           set status = v_status, status_seen_at = now(), updated_at = now()
         where id = v_existing_id;
        v_outcome := 'status:' || v_status;
      end if;

      -- A date move only counts while the game is on. A postponed game with no new date keeps its
      -- original date (and its hold); it moves when the source republishes it as scheduled.
      if v_status = 'scheduled' and v_new_date is distinct from v_existing_date then
        select id into v_clash
          from public.events_master
         where league = v_league and team = v_team and opponent = v_opp
           and event_date = v_new_date and id <> v_existing_id
         limit 1;

        if v_clash is null then
          update public.events_master
             set event_date = v_new_date,
                 event_time = (nullif(r->>'event_time',''))::time,
                 status = 'scheduled', status_seen_at = now(), updated_at = now()
           where id = v_existing_id;
          v_outcome := 'rescheduled';
        else
          -- The replacement already exists as its own row (it was loaded before this one caught
          -- up). Park the original and point at the survivor rather than deleting either.
          update public.events_master
             set status = 'postponed', rescheduled_to = v_clash,
                 status_seen_at = now(), updated_at = now()
           where id = v_existing_id;
          v_id := v_clash;
          v_outcome := 'rescheduled';
        end if;
      end if;
    else
      insert into public.events_master
        (league, team, team_full, opponent, event_date, event_time, venue, home_away,
         market_code, state_code, external_id, source_url, source_note, season,
         status, status_seen_at)
      values (
        v_league, v_team, nullif(r->>'team_full',''), v_opp, v_new_date,
        (nullif(r->>'event_time',''))::time, nullif(r->>'venue',''),
        coalesce(nullif(r->>'home_away',''), 'home'),
        v_market, v_state, v_ext, r->>'source_url', nullif(r->>'source_note',''), r->>'season',
        v_status, case when v_status <> 'scheduled' then now() end
      )
      on conflict (league, team, opponent, event_date) do nothing
      returning id into v_id;

      if v_id is not null then v_inserted := true; v_outcome := 'inserted'; end if;
    end if;

    return query select v_id, v_inserted, v_team, v_opp, v_new_date, v_market, v_outcome;
  end loop;
end;
$function$;

grant execute on function public.upsert_events_master(jsonb) to anon, authenticated, service_role;
revoke execute on function public.upsert_events_master(jsonb) from anon;  -- 052


-- ---------------------------------------------------------------------------
-- 3. The decider stops recommending games that are off.
--
-- First branch in the CASE, so it outranks every other reason: "the game is cancelled" is not a
-- cooldown or a fill-rate judgement, and the operator should see that word and not 'no_history'.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_event_recommendations()
returns table(event_id uuid, team text, opponent text, event_date date,
  event_time time without time zone, filled_pct numeric, market_key text, market_label text,
  matched boolean, decision text, channel text, reason_code text, n_blasts bigint,
  open_rate_w numeric, ctr_w numeric, unsub_rate numeric, best_template text,
  best_open numeric, best_ctr numeric, best_dow integer, days_until integer,
  days_since_send integer, fatigue_warning boolean, optout_warning boolean, priority numeric)
language sql stable security definer set search_path to 'public'
as $function$
  with r as (select * from decider_rules where id = 1),
  sends as (
    select market_key, max(blasted_at)::date as last_send
    from ticketblaster_market_blasts_log
    where segment is null            -- segment-scoped sends leave the other segments open
    group by market_key
  ),
  fill as (   -- one filled_pct per (team, date); avg guards against multiple suite rows
    select lower(btrim(team_name)) as team_lc, event_date, avg(filled_pct) as filled_pct
    from icp_events
    where filled_pct is not null
    group by 1, 2
  ),
  m as (   -- events_master is the spine; an unbooked game has no fill row -> 0% -> sellable
    select e.id, e.team as team_name, e.opponent, e.event_date, e.event_time,
           coalesce(f.filled_pct, 0) as filled_pct,
           e.market_code as market_key, e.status
    from events_master e
    left join fill f on f.team_lc = e.team and f.event_date = e.event_date
    where e.event_date >= current_date
  )
  select m.id, m.team_name, m.opponent, m.event_date, m.event_time, m.filled_pct,
    m.market_key, market_label(m.market_key),
    (p.market_key is not null) as matched,
    case
      when m.status <> 'scheduled' then 'skip'
      when p.market_key is null then 'skip'
      when coalesce(m.filled_pct,0) >= 90 then 'skip'
      when (m.event_date - current_date) > r.forward_window_days then 'skip'
      when s.last_send is not null and (current_date - s.last_send) < r.cooldown_floor_days then 'skip'
      else 'send'
    end as decision,
    'email' as channel,
    case
      when m.status <> 'scheduled' then 'game_' || m.status
      when p.market_key is null then 'no_history'
      when coalesce(m.filled_pct,0) >= 90 then 'nearly_full'
      when (m.event_date - current_date) > r.forward_window_days then 'too_early'
      when s.last_send is not null and (current_date - s.last_send) < r.cooldown_floor_days then 'cooldown'
      else 'ok'
    end as reason_code,
    p.n_blasts, p.open_rate_w, p.ctr_w, p.unsub_rate,
    t.template_name, t.best_open, t.best_ctr, d.dow,
    (m.event_date - current_date)::int as days_until,
    (current_date - s.last_send)::int  as days_since_send,
    (s.last_send is not null and (current_date - s.last_send) < r.cross_strategy_fatigue_days) as fatigue_warning,
    (p.unsub_rate is not null and p.unsub_rate > r.optout_ceiling_pct) as optout_warning,
    coalesce(m.filled_pct, 50) as priority
  from m
  cross join r
  left join v_market_performance   p on p.market_key = m.market_key
  left join v_market_best_template t on t.market_key = m.market_key
  left join v_market_best_dow      d on d.market_key = m.market_key
  left join sends                  s on s.market_key = m.market_key
  order by (m.market_key is null),
           (case when p.market_key is not null and coalesce(m.filled_pct,0) < 90
                  and (m.event_date - current_date) <= r.forward_window_days then 0 else 1 end),
           coalesce(m.filled_pct, 50) asc, m.event_date asc;
$function$;

grant execute on function public.rpc_event_recommendations() to anon, authenticated, service_role;
revoke execute on function public.rpc_event_recommendations() from anon;  -- 052

-- ---------------------------------------------------------------------------
-- 4. Expose the status on the queue. Return type changes, so drop + recreate (see 044, 045, 048).
--
-- Rows already IN the queue are the whole point: the decider gate above only stops NEW rows being
-- queued, and a game is usually cancelled after its blast was queued, not before.
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
   rejected_at timestamp with time zone, reject_note text,
   event_status text)
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
    q.reject_note,
    -- A placeholder row with no event_id has no game to be cancelled; null, not 'scheduled'.
    em.status as event_status
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role;
revoke execute on function public.get_campaign_queue() from anon;  -- 052

-- ---------------------------------------------------------------------------
-- NOTE FOR THE JS SIDE — this migration is only half the change, same as 048.
--
--   api/queue-tick.js    must hold rows whose event_status <> 'scheduled'. Unlike the
--                        game-already-played hold, a CANCELLED game also blocks "Send now":
--                        "the game was played" is a judgement an operator may override,
--                        "the game does not exist" is not.
--   api/price-refresh.js must exclude them from the price window — otherwise every run pays
--                        Gemini to look up a price for a game nobody can attend.
--   scripts/load-schedule.js must send `status` per row, or nothing above ever fires.
-- ---------------------------------------------------------------------------
