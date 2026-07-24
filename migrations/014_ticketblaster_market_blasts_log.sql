-- Market-level blast log for the Ticket Blaster cooldown.
--
-- Replaces the fragile cooldown source in rpc_event_recommendations. Previously the
-- decider derived "last send per market" from campaign_send_log (which has NO market
-- column) via event_id -> icp_events.team_name -> market_bridge_team -> market_key.
-- This table stores market_key + blasted_at directly, so cooldown is a plain
-- current_date - max(blasted_at) per market.
--
-- source tags where a row came from: 'test' (Trigger Blast button, nothing actually
-- sent), 'manual', 'cron', 'salesmsg'. Test rows DO count toward cooldown by design.

create table if not exists public.ticketblaster_market_blasts_log (
  id              uuid primary key default gen_random_uuid(),
  market_key      text not null,                 -- the cooldown key
  state_code      text,
  event_id        uuid,                          -- optional link back to the event
  channel         text,                          -- 'email' | 'sms'
  template_name   text,
  recipient_count integer,
  source          text not null default 'manual',-- test | manual | cron | salesmsg
  blasted_at      timestamptz not null default now(),  -- cooldown reads this
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists tb_market_blasts_market_idx
  on public.ticketblaster_market_blasts_log (market_key, blasted_at desc);

alter table public.ticketblaster_market_blasts_log enable row level security;
grant all on public.ticketblaster_market_blasts_log to anon, authenticated, service_role;

-- Insert one or more blast-log rows. SECURITY DEFINER so anon (browser) can log
-- through it without a direct-table RLS policy, matching the queue_* helpers.
create or replace function public.log_market_blast(p_rows jsonb)
returns setof public.ticketblaster_market_blasts_log
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    return query
    insert into public.ticketblaster_market_blasts_log
      (market_key, state_code, event_id, channel, template_name, recipient_count, source, notes)
    values (
      r->>'market_key',
      nullif(r->>'state_code',''),
      (nullif(r->>'event_id',''))::uuid,
      nullif(r->>'channel',''),
      nullif(r->>'template_name',''),
      (nullif(r->>'recipient_count',''))::int,
      coalesce(nullif(r->>'source',''), 'manual'),
      nullif(r->>'notes','')
    )
    returning *;
  end loop;
end;
$function$;

grant execute on function public.log_market_blast(jsonb) to anon, authenticated, service_role;

-- Repoint the decider's cooldown/fatigue at the new market blast log.
create or replace function public.rpc_event_recommendations()
 returns table(event_id uuid, team text, opponent text, event_date date, event_time time without time zone, filled_pct numeric, market_key text, market_label text, matched boolean, decision text, channel text, reason_code text, n_blasts bigint, open_rate_w numeric, ctr_w numeric, unsub_rate numeric, best_template text, best_open numeric, best_ctr numeric, best_dow integer, days_until integer, days_since_send integer, fatigue_warning boolean, optout_warning boolean, priority numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with r as (select * from decider_rules where id = 1),
  sends as (   -- last actual blast per market (cooldown / fatigue), market-keyed directly
    select market_key, max(blasted_at)::date as last_send
    from ticketblaster_market_blasts_log
    group by market_key
  ),
  ev as (
    select id, team_name, opponent, event_date, event_time, filled_pct
    from icp_events where event_date >= current_date
  ),
  m as (
    select ev.*, tb.market_key from ev
    left join market_bridge_team tb on tb.team_lc = lower(btrim(ev.team_name))
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
