-- AI-826 final: point the decider at events_master (the frozen game spine) instead of
-- live-scraped icp_events. icp_events stays as the source of booking fill %, joined in.
--
--   game list  <- events_master   (deterministic StatsAPI load; no hallucination)
--   filled_pct <- icp_events       (real suite bookings; null booking = 0% = sellable)
--   market     <- events_master.market_code (already resolved at load)
--
-- Signature unchanged, so the Campaigns UI is untouched.
create or replace function public.rpc_event_recommendations()
 returns table(event_id uuid, team text, opponent text, event_date date, event_time time without time zone, filled_pct numeric, market_key text, market_label text, matched boolean, decision text, channel text, reason_code text, n_blasts bigint, open_rate_w numeric, ctr_w numeric, unsub_rate numeric, best_template text, best_open numeric, best_ctr numeric, best_dow integer, days_until integer, days_since_send integer, fatigue_warning boolean, optout_warning boolean, priority numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with r as (select * from decider_rules where id = 1),
  sends as (
    select market_key, max(blasted_at)::date as last_send
    from ticketblaster_market_blasts_log
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
  left join v_market_performance  p on p.market_key = m.market_key
  left join v_market_best_template t on t.market_key = m.market_key
  left join v_market_best_dow      d on d.market_key = m.market_key
  left join sends                  s on s.market_key = m.market_key
  order by (m.market_key is null),
           (case when p.market_key is not null and coalesce(m.filled_pct,0) < 90
                  and (m.event_date - current_date) <= r.forward_window_days then 0 else 1 end),
           coalesce(m.filled_pct, 50) asc, m.event_date asc;
$function$;
