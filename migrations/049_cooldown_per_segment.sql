-- COOLDOWN PER MARKET × SEGMENT.
--
-- Vhea, 2026-08-03: "the cooldown will cool per market segment too — example Ontario ICP sent,
-- Ontario SCP and Ontario Other is still open."
--
-- Today a send cools the WHOLE market for cooldown_floor_days. With one queue row per market
-- that was right. With three rows per market (ICP / SCP / Other, migration 048) it is wrong in
-- the most damaging direction available: blasting ICP on Monday would silently lock SCP and
-- Other out for two weeks, and since ICP is the primary target and therefore usually goes
-- first, the other two segments would effectively never send at all. The bug would look like
-- "the decider just doesn't pick SCP much", which is close to unfindable.
--
-- ---------------------------------------------------------------------------------------
-- THERE ARE TWO COOLDOWN SYSTEMS AND THEY DO NOT TALK. Both need this.
--
--   1. rpc_event_recommendations  — the deterministic floor. Reads ticketblaster_market_blasts_log,
--                                   keyed on market_key ('san_francisco'). Written by the jsonb
--                                   log_market_blast(p_rows).
--   2. market_cooldowns()         — the send-time guard in api/queue-tick.js and the Queue UI.
--                                   Reads market_blast_log, keyed on market_code ('CA').
--                                   Written by log_market_blast(p_code, p_name, p_channel, ...).
--
-- docs/OPENCLAW_QUEUE_RULES.md already says "nothing writes both". Segmenting only one of them
-- would leave the other cooling whole markets, which is the behaviour being removed.
-- ---------------------------------------------------------------------------------------
--
-- NULL SEGMENT MEANS "THE WHOLE MARKET", and that reading matters for history. Every log row
-- written before this migration was a whole-market send, so it must cool ALL THREE segments —
-- not none of them. Treating a legacy row as segment-less-therefore-harmless would reopen every
-- market that was blasted in the last two weeks the moment this deploys.

-- ---------------------------------------------------------------------------
-- 1. Columns on both logs.
-- ---------------------------------------------------------------------------
alter table public.market_blast_log
  add column if not exists segment text;
alter table public.ticketblaster_market_blasts_log
  add column if not exists segment text;

comment on column public.market_blast_log.segment is
  'ICP | SCP | Other — the audience slice this send went to. NULL = whole market, which cools every segment. See migration 049.';
comment on column public.ticketblaster_market_blasts_log.segment is
  'ICP | SCP | Other — the audience slice this send went to. NULL = whole market, which cools every segment. See migration 049.';

alter table public.market_blast_log
  drop constraint if exists market_blast_log_segment_check;
alter table public.market_blast_log
  add constraint market_blast_log_segment_check
  check (segment is null or segment in ('ICP', 'SCP', 'Other'));

alter table public.ticketblaster_market_blasts_log
  drop constraint if exists tb_market_blasts_log_segment_check;
alter table public.ticketblaster_market_blasts_log
  add constraint tb_market_blasts_log_segment_check
  check (segment is null or segment in ('ICP', 'SCP', 'Other'));

-- ---------------------------------------------------------------------------
-- 2. Writers.
--
-- The 4-arg log_market_blast is DROPPED, not overloaded. Adding p_segment with a default
-- alongside it would leave a 4-arg call ambiguous between the two candidates, and PostgREST
-- calls these by name — every existing call site would start erroring at runtime rather than
-- at deploy. One function, one signature.
-- ---------------------------------------------------------------------------
drop function if exists public.log_market_blast(text, text, text, uuid);

create function public.log_market_blast(
  p_code text, p_name text, p_channel text,
  p_queue_id uuid default null, p_segment text default null
) returns bigint
language sql volatile security definer set search_path to 'public'
as $function$
  insert into public.market_blast_log(market_code, market_name, channel, campaign_queue_id, segment)
  values (upper(btrim(p_code)), p_name, p_channel, p_queue_id,
          nullif(btrim(coalesce(p_segment, '')), ''))
  returning id;
$function$;

grant execute on function public.log_market_blast(text, text, text, uuid, text)
  to anon, authenticated, service_role;

-- The jsonb writer feeds the decider's floor. Same field, read off each row.
create or replace function public.log_market_blast(p_rows jsonb)
returns setof public.ticketblaster_market_blasts_log
language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  r jsonb;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    return query
    insert into public.ticketblaster_market_blasts_log
      (market_key, state_code, event_id, channel, template_name, recipient_count, source, notes, segment)
    values (
      r->>'market_key',
      nullif(r->>'state_code',''),
      (nullif(r->>'event_id',''))::uuid,
      nullif(r->>'channel',''),
      nullif(r->>'template_name',''),
      (nullif(r->>'recipient_count',''))::int,
      coalesce(nullif(r->>'source',''), 'manual'),
      nullif(r->>'notes',''),
      nullif(r->>'segment','')
    )
    returning *;
  end loop;
end;
$function$;

grant execute on function public.log_market_blast(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The send-time guard, now one row per market × segment.
--
-- RETURN TYPE CHANGES — a `segment` column is added, so every caller must key on the pair.
-- api/queue-tick.js and ui/index.html are updated in the same change; a caller still keying on
-- market_code alone will now see three rows per market and silently keep the last one.
--
-- The join is the whole rule: a log row cools segment S when it WAS segment S, or when it had
-- no segment at all (a whole-market send, which cools everything).
-- ---------------------------------------------------------------------------
drop function if exists public.market_cooldowns();

create function public.market_cooldowns()
returns table(market_code text, market_name text, segment text, last_sent date,
              days_since integer, days_left integer, cooled boolean)
language sql stable security definer set search_path to 'public'
as $function$
  with r as (select cooldown_floor_days as d from decider_rules where id = 1),
  segs as (select unnest(array['ICP','SCP','Other']) as segment),
  last as (
    select b.market_code,
           max(b.market_name) as market_name,
           s.segment,
           max(b.sent_on) as last_sent
    from public.market_blast_log b
    cross join segs s
    where b.segment is null or b.segment = s.segment
    group by b.market_code, s.segment
  )
  select l.market_code, l.market_name, l.segment, l.last_sent,
         (current_date - l.last_sent)::int as days_since,
         greatest(0, (select d from r) - (current_date - l.last_sent))::int as days_left,
         ((current_date - l.last_sent) < (select d from r)) as cooled
  from last l;
$function$;

grant execute on function public.market_cooldowns() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The decider's floor.
--
-- Only WHOLE-MARKET sends cool a market here. A segment-scoped send must not stop the event
-- being recommended, because the other two segments are still open — that is the entire point
-- of this migration.
--
-- This function still returns ONE ROW PER EVENT, not per event × segment, so it cannot express
-- "ICP is cooled but SCP is not". Segment-level refusal is enforced downstream instead: by
-- market_cooldowns() at send time, and by the queue's own per-(event, segment) dedupe. When
-- rpc_event_recommendations is rebuilt to return event × segment, the `sends` CTE below is
-- where the per-segment floor belongs, and this comment stops being true.
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
           e.market_code as market_key
    from events_master e
    left join fill f on f.team_lc = e.team and f.event_date = e.event_date
    where e.event_date >= current_date
  )
  select m.id, m.team_name, m.opponent, m.event_date, m.event_time, m.filled_pct,
    m.market_key, market_label(m.market_key),
    (p.market_key is not null) as matched,
    case
      when p.market_key is null then 'skip'
      when coalesce(m.filled_pct,0) >= 90 then 'skip'
      when (m.event_date - current_date) > r.forward_window_days then 'skip'
      when s.last_send is not null and (current_date - s.last_send) < r.cooldown_floor_days then 'skip'
      else 'send'
    end as decision,
    'email' as channel,
    case
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

-- ---------------------------------------------------------------------------
-- NOTE. Until the queue actually populates campaign_queue.segment, every send still writes
-- segment = null and therefore still cools the whole market — i.e. this migration changes
-- nothing observable on its own. That is deliberate: it lands the cooldown rule ahead of the
-- per-segment queue so the two do not have to go in together.
-- ---------------------------------------------------------------------------
