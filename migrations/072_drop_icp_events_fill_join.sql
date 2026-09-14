-- 072: stop inventing a 0% fill for every game in the country.
--
-- WHAT WAS WRONG
--
-- rpc_event_recommendations joined events_master to icp_events to attach "how full is this
-- game", on lower(team_name) + event_date, and then wrote:
--
--     coalesce(f.filled_pct, 0) as filled_pct
--
-- A LEFT JOIN that misses yields NULL, and that coalesce turned every miss into 0 — which does
-- not read as "we don't know", it reads as AN EMPTY STADIUM, the single strongest buy signal
-- the decider has. A missed join was indistinguishable from an unsold suite.
--
-- Measured against live data on 2026-09-15:
--
--   * events_master upcoming games ........................ 3,764
--   * icp_events rows in total ..............................  214
--   * icp_events rows carrying a filled_pct .................   82
--   * of those 82, how many join on (lower(team), date) ..... ZERO
--
-- Not "few". None. The two tables spell teams differently — events_master stores the bare
-- nickname it builds its market codes from ('senators', 'blue jays', 'rangers'), icp_events
-- stores whatever the source typed ('Chicago Blackhawks', 'Celtics', 'Rangers'). So the join
-- has never once matched, and rpc_event_recommendations returned filled_pct = 0 on all 1,000
-- rows of its output, with priority flat at 0 across every single game.
--
-- The decider's primary ranking input was a constant. Worse than absent: it actively told the
-- model that every game everywhere was completely unsold.
--
-- AND THE EXISTING SAFETY NET COULD NEVER FIRE. Further down the same query the author wrote
-- `coalesce(m.filled_pct, 50)` for priority — "if fill is unknown, treat it as middling", which
-- is exactly the right instinct. It was unreachable: the earlier coalesce had already replaced
-- every NULL with 0, so there was no NULL left for it to catch. The right defence was written
-- and then disarmed two lines above it.
--
-- WHY DELETE RATHER THAN REPAIR THE JOIN
--
-- Fixing the name matching would carry 82 fill numbers onto 3,764 games — about 2% coverage at
-- the absolute ceiling, if every one matched. It is not a plumbing problem, the data is not
-- there. And loosening the join is worse than leaving it: of the 82, exactly 2 match an
-- events_master team on NAME ALONE, and one of them is the trap — icp_events 'Rangers' is the
-- New York Rangers (NHL) while events_master 'rangers' is the Texas Rangers (MLB). A looser
-- join starts attaching one team's occupancy to a different team's game, in a different sport.
-- A wrong fill number is worse than no fill number, because it is believed.
--
-- So: events_master is the spine and now the whole skeleton. filled_pct is returned as NULL —
-- honestly unknown — and icp_events is no longer read by this function.
--
-- WHAT THIS CHANGES IN PRACTICE
--
--   * The decider ranks on days-until, market reach, prior blast performance and cooldown —
--     the signals that actually have coverage — instead of on a fabricated zero.
--   * `coalesce(m.filled_pct, 50)` becomes reachable and does its job. priority is a flat 50
--     rather than a flat 0. Both are flat; neither is read. `priority` appears in this
--     function's output and in NOTHING else in the repo — not the UI, not api/decide.js, not
--     api/trigger-decide.js. Verified before changing it.
--   * The UI needs no change: it already renders `r.filled_pct != null ? … : '—'`, so an
--     unknown fill displays as an em dash instead of a confident "0%".
--
-- WHAT WE ARE GIVING UP, DELIBERATELY
--
-- The `filled_pct >= 90 -> skip / 'nearly_full'` rule. It is kept in the CASE below but can no
-- longer fire, because NULL >= 90 is not true. This is a REAL decision and not a silent one:
-- after this, nothing in the system stops a blast going out on a game that is already sold out
-- except a human reading the queue.
--
-- It costs nothing today. That branch has never fired — every game reported 0% full, and the
-- live reason_code breakdown is {ok: 482, too_early: 392, no_history: 126} with not one
-- 'nearly_full' among 1,000 rows. We are deleting a dead guard, not a working one. If real
-- occupancy data ever arrives, reconnect it on a STABLE IDENTIFIER — events_master.external_id
-- or a proper key — never on a team-name string.

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
  -- The `fill` CTE and its join to icp_events are GONE (see the header). events_master is the
  -- only source of truth here now.
  m as (
    select e.id, e.team as team_name, e.opponent, e.event_date, e.event_time,
           -- NULL, not 0. We do not know how full this game is, and saying 0 is a claim that
           -- it is empty. Typed explicitly because the return signature declares numeric and
           -- an untyped NULL would be inferred as text.
           null::numeric as filled_pct,
           e.market_code as market_key, e.status
    from events_master e
    where e.event_date >= current_date
  )
  select m.id, m.team_name, m.opponent, m.event_date, m.event_time, m.filled_pct,
    m.market_key, market_label(m.market_key),
    (p.market_key is not null) as matched,
    case
      when m.status <> 'scheduled' then 'skip'
      when p.market_key is null then 'skip'
      -- Was `coalesce(m.filled_pct,0) >= 90`. Written against the raw column now: an unknown
      -- fill is NULL, NULL >= 90 is NULL, and a CASE does not take a branch on NULL — so this
      -- falls through rather than being judged on a substituted number. Same outcome as before
      -- (it never fired), but for an honest reason instead of an invented one.
      when m.filled_pct >= 90 then 'skip'
      when (m.event_date - current_date) > r.forward_window_days then 'skip'
      when s.last_send is not null and (current_date - s.last_send) < r.cooldown_floor_days then 'skip'
      else 'send'
    end as decision,
    'email' as channel,
    case
      when m.status <> 'scheduled' then 'game_' || m.status
      when p.market_key is null then 'no_history'
      when m.filled_pct >= 90 then 'nearly_full'
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
    -- Now reachable, and now meaning what it was written to mean: unknown fill is middling,
    -- not maximally sellable.
    coalesce(m.filled_pct, 50) as priority
  from m
  cross join r
  left join v_market_performance   p on p.market_key = m.market_key
  left join v_market_best_template t on t.market_key = m.market_key
  left join v_market_best_dow      d on d.market_key = m.market_key
  left join sends                  s on s.market_key = m.market_key
  order by (m.market_key is null),
           -- The fill test drops out of the sort for the same reason it dropped out of the
           -- CASE: `coalesce(...) < 90` was true for every row on earth, so it sorted nothing.
           -- What remains is real: games in a market we have blasted before and that are inside
           -- the forward window come first.
           (case when p.market_key is not null
                  and (m.event_date - current_date) <= r.forward_window_days then 0 else 1 end),
           -- Soonest first. With no occupancy signal, urgency is the honest primary ordering,
           -- and it has 100% coverage. This was already the effective order — every row tied at
           -- filled_pct 0 and fell through to this — so the queue does not reshuffle today.
           m.event_date asc;
$function$;

-- Grants reproduced unchanged. create-or-replace keeps the existing ACL, so these are here to
-- state the intended end position rather than to move it (52 revoked anon; see its note).
revoke execute on function public.rpc_event_recommendations() from public, anon;
grant  execute on function public.rpc_event_recommendations() to authenticated, service_role;
