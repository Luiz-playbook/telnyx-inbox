-- 123: Event Waitlist v1 (AI-1128) — settings instead of constants, a ranked board, follow-ups
--      that do not wait out the cooldown, the threshold alert, and replies that stop the re-asks.
--
-- 1. SETTINGS, NOT CONSTANTS. The ticket: "make the open calls config values, not hardcoded".
--    120 wrote 25 into waitlist_board(). The cooldown and the ranking weights now live in one
--    row of waitlist_settings and are changed with an UPDATE, no deploy.
--
-- 2. FOLLOW-UPS ARE EXEMPT FROM THE COOLDOWN (John, 2026-10-15). Day 3 and Day 10 land inside
--    25 days of Day 0 by design. Only the opening ask (Day 0) is held by the global cooldown;
--    the rest of a market's sequence runs on its own clock. The board reports `day0_held` so the
--    UI blocks only that step, and api/queue-tick.js skips its cooldown hold for the later steps.
--
-- 3. RANKED, STILL EXHAUSTIVE. Every market stays on the board; the order is a score from what
--    we can measure today — ICP and SCP reach, organisations in the state, Dan's warm flag, and
--    distance from the nearest state we HAVE hosted in (a state centroid each, below). BDA/AE
--    coverage and a nearby suite on the calendar are in the ticket but have no state-level data
--    yet (icp_suites carries a region like "Northeast", not a state), so they are not guessed at.
--
-- 4. THE THRESHOLD ALERT. waitlist_alerts() lists every market, on any open proposal, that has
--    reached its threshold and has no date confirmed. The app shows it to Cole; nothing is sent.
--
-- 5. REPLIES STOP THE RE-ASKS (the reply part of AI-1131). waitlist_repliers(queue row) is who
--    must NOT get a Day 3 / Day 10 / Day 45 follow-up: anyone who replied by email or text since
--    that market's Day 0, and anyone already recorded as a hand-raiser by email or phone. The
--    announcement (formal) is not filtered — the people who said yes are exactly who it is for.
--    Coverage is what we capture: email_replies and Telnyx inbound. Replies that land only in
--    the bulk sender or Salesmsg are not in these tables and are not seen here.
--
-- ONLY ADDS. No existing table, row or function is changed: the coordinates are a new table, and
-- the new board is waitlist_board_v2 beside 120's waitlist_board, which stays exactly as it is.
-- The UI reads v2 and falls back to the original when v2 is not there.
--
-- Rollback: 123_waitlist_v1_rollback.sql.

-- ── 1. Settings ────────────────────────────────────────────────────────────────────────────
create table if not exists public.waitlist_settings (
  id                    int primary key default 1 check (id = 1),
  cooldown_days         int     not null default 25,   -- global, any strategy, before a Day 0
  w_icp                 numeric not null default 3,    -- per ln(1 + ICP emails + phones)
  w_scp                 numeric not null default 2,    -- per ln(1 + SCP emails + phones)
  w_orgs                numeric not null default 1,    -- per ln(1 + organisations in the state)
  w_warm                numeric not null default 2,    -- Dan's warm flag (a presence, no date)
  w_per_100_miles       numeric not null default 0.5,  -- subtracted per 100 mi to the nearest hosted state
  updated_at            timestamptz not null default now()
);
insert into public.waitlist_settings (id) values (1) on conflict (id) do nothing;

alter table public.waitlist_settings enable row level security;
drop policy if exists waitlist_settings_anon_read on public.waitlist_settings;
drop policy if exists waitlist_settings_authenticated_read on public.waitlist_settings;
create policy waitlist_settings_anon_read on public.waitlist_settings for select to anon using (true);
create policy waitlist_settings_authenticated_read on public.waitlist_settings for select to authenticated using (true);

-- ── 2. Where each state is ─────────────────────────────────────────────────────────────────
-- Approximate centre of each state + DC. Good to tens of miles, which is all a ranking needs.
-- Its own table, not columns on waitlist_markets (this migration only adds).
create table if not exists public.waitlist_market_geo (
  code  text primary key references public.geo_region(code),
  lat   numeric not null,
  lng   numeric not null
);
alter table public.waitlist_market_geo enable row level security;
drop policy if exists waitlist_market_geo_anon_read on public.waitlist_market_geo;
drop policy if exists waitlist_market_geo_authenticated_read on public.waitlist_market_geo;
create policy waitlist_market_geo_anon_read on public.waitlist_market_geo for select to anon using (true);
create policy waitlist_market_geo_authenticated_read on public.waitlist_market_geo for select to authenticated using (true);

insert into public.waitlist_market_geo (code, lat, lng)
select v.code, v.lat, v.lng from (values
  ('AL',32.806671,-86.791130),('AK',61.370716,-152.404419),('AZ',33.729759,-111.431221),('AR',34.969704,-92.373123),
  ('CA',36.116203,-119.681564),('CO',39.059811,-105.311104),('CT',41.597782,-72.755371),('DE',39.318523,-75.507141),
  ('DC',38.897438,-77.026817),('FL',27.766279,-81.686783),('GA',33.040619,-83.643074),('HI',21.094318,-157.498337),
  ('ID',44.240459,-114.478828),('IL',40.349457,-88.986137),('IN',39.849426,-86.258278),('IA',42.011539,-93.210526),
  ('KS',38.526600,-96.726486),('KY',37.668140,-84.670067),('LA',31.169546,-91.867805),('ME',44.693947,-69.381927),
  ('MD',39.063946,-76.802101),('MA',42.230171,-71.530106),('MI',43.326618,-84.536095),('MN',45.694454,-93.900192),
  ('MS',32.741646,-89.678696),('MO',38.456085,-92.288368),('MT',46.921925,-110.454353),('NE',41.125370,-98.268082),
  ('NV',38.313515,-117.055374),('NH',43.452492,-71.563896),('NJ',40.298904,-74.521011),('NM',34.840515,-106.248482),
  ('NY',42.165726,-74.948051),('NC',35.630066,-79.806419),('ND',47.528912,-99.784012),('OH',40.388783,-82.764915),
  ('OK',35.565342,-96.928917),('OR',44.572021,-122.070938),('PA',40.590752,-77.209755),('RI',41.680893,-71.511780),
  ('SC',33.856892,-80.945007),('SD',44.299782,-99.438828),('TN',35.747845,-86.692345),('TX',31.054487,-97.563461),
  ('UT',40.150032,-111.862434),('VT',44.045876,-72.710686),('VA',37.769337,-78.169968),('WA',47.400902,-121.490494),
  ('WV',38.491226,-80.954453),('WI',44.268543,-89.616508),('WY',42.755966,-107.302490)
) as v(code, lat, lng)
where exists (select 1 from public.geo_region g where g.code = v.code)
on conflict (code) do nothing;

-- Great-circle miles. Plain SQL so it needs no extension.
create or replace function public.miles_between(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric language sql immutable as $$
  select 3958.8 * 2 * asin(sqrt(
    power(sin(radians((lat2 - lat1) / 2)), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians((lng2 - lng1) / 2)), 2)));
$$;

-- ── 3. The board ───────────────────────────────────────────────────────────────────────────
-- Same columns as 120's waitlist_board, in the same order, with the new ones appended. A new
-- function, not a replacement: 120's stays untouched for anything still calling it.
create or replace function public.waitlist_board_v2(p_proposal uuid default null)
returns table (
  code text, name text, untouched boolean, warm boolean, note text,
  icp_emails bigint, icp_phones bigint, scp_emails bigint, scp_phones bigint, other_emails bigint, other_phones bigint,
  last_blast_any date, days_since_any int, last_blast_waitlist date, held_until date,
  in_proposal boolean, pm_id uuid, signups bigint, threshold int,
  day0_sent_at timestamptz, day3_sent_at timestamptz, day10_sent_at timestamptz, day45_sent_at timestamptz,
  formal_at timestamptz, formal_sent_at timestamptz, event_date date, venue text,
  stage text, step_due text,
  -- 123
  orgs bigint, last_blast_playbook date, days_since_waitlist int, signups_left int,
  nearest_hosted text, miles_to_hosted int, rank_score numeric, cooldown_days int, day0_held boolean
)
language sql stable security definer set search_path = public as $$
  with cfg as (select * from public.waitlist_settings where id = 1),
  reach as (
    select s.code,
      sum(s.emails) filter (where s.segment = 'ICP')   as icp_emails,
      sum(s.phones) filter (where s.segment = 'ICP')   as icp_phones,
      sum(s.emails) filter (where s.segment = 'SCP')   as scp_emails,
      sum(s.phones) filter (where s.segment = 'SCP')   as scp_phones,
      sum(s.emails) filter (where s.segment not in ('ICP','SCP') or s.segment is null) as other_emails,
      sum(s.phones) filter (where s.segment not in ('ICP','SCP') or s.segment is null) as other_phones,
      sum(s.companies) as orgs
    from public.state_segment_summary_mv s group by s.code
  ),
  hist as (
    select l.market_code as code,
      max(l.sent_on) as last_any,
      max(l.sent_on) filter (where l.strategy = 'event_waitlist') as last_waitlist,
      -- "this brand": every Playbook play. Teammate AI is a different brand (migration 122).
      max(l.sent_on) filter (where l.strategy is distinct from 'teammate') as last_playbook
    from public.market_blast_log l group by l.market_code
  ),
  su as (
    select s.code, count(*) as n from public.proposal_signups s where s.proposal_id = p_proposal group by s.code
  ),
  -- The nearest state we have hosted in: anything NOT on Dan's never-hosted list.
  near as (
    select w.code, n.code as nearest, n.miles
    from public.waitlist_markets w
    join public.waitlist_market_geo wg on wg.code = w.code
    left join lateral (
      select h.code, public.miles_between(wg.lat, wg.lng, hg.lat, hg.lng) as miles
      from public.waitlist_markets h
      join public.waitlist_market_geo hg on hg.code = h.code
      where not h.untouched and h.code <> w.code
      order by 2 limit 1
    ) n on true
  ),
  base as (
    select w.code, g.name, w.untouched, w.warm, w.note,
      coalesce(r.icp_emails,0) icp_emails, coalesce(r.icp_phones,0) icp_phones,
      coalesce(r.scp_emails,0) scp_emails, coalesce(r.scp_phones,0) scp_phones,
      coalesce(r.other_emails,0) other_emails, coalesce(r.other_phones,0) other_phones,
      coalesce(r.orgs,0) orgs,
      h.last_any, (current_date - h.last_any)::int as days_since_any, h.last_waitlist, h.last_playbook,
      case when h.last_any is not null and h.last_any + cfg.cooldown_days > current_date
           then h.last_any + cfg.cooldown_days end as held_until,
      pm.id as pm_id, (pm.id is not null) as in_proposal,
      coalesce(su.n, 0) as signups, p.threshold,
      pm.day0_sent_at, pm.day3_sent_at, pm.day10_sent_at, pm.day45_sent_at, pm.formal_at, pm.formal_sent_at,
      pm.event_date, pm.venue,
      n.nearest, round(n.miles)::int as miles,
      cfg.cooldown_days,
      round((
          cfg.w_icp  * ln(1 + coalesce(r.icp_emails,0) + coalesce(r.icp_phones,0))
        + cfg.w_scp  * ln(1 + coalesce(r.scp_emails,0) + coalesce(r.scp_phones,0))
        + cfg.w_orgs * ln(1 + coalesce(r.orgs,0))
        + case when w.warm then cfg.w_warm else 0 end
        - cfg.w_per_100_miles * coalesce(n.miles, 0) / 100
      )::numeric, 2) as rank_score
    from public.waitlist_markets w
    cross join cfg
    join public.geo_region g on g.code = w.code
    left join reach r on r.code = w.code
    left join hist  h on h.code = w.code
    left join near  n on n.code = w.code
    left join public.proposal_markets pm on pm.code = w.code and pm.proposal_id = p_proposal
    left join public.event_proposals p on p.id = p_proposal
    left join su on su.code = w.code
  ),
  staged as (
    select b.*,
      case
        when not b.in_proposal                           then 'not_selected'
        when b.formal_sent_at is not null                then 'formal_sent'
        when b.formal_at is not null                     then 'formal'
        when b.threshold is not null and b.signups >= b.threshold then 'enough'
        when b.day0_sent_at is null                      then 'not_asked'
        when b.day45_sent_at is not null                 then 'dormant'
        else 'following_up'
      end as stage,
      case
        when not b.in_proposal                                                   then null
        when b.formal_at is not null and b.formal_sent_at is null                then 'formal'
        when b.formal_at is not null                                             then null
        when b.threshold is not null and b.signups >= b.threshold                then null   -- Dan's call now
        when b.day0_sent_at is null                                              then 'day0'
        when b.day3_sent_at  is null and b.day0_sent_at + interval '3 days'  <= now() then 'day3'
        when b.day10_sent_at is null and b.day0_sent_at + interval '10 days' <= now() then 'day10'
        when b.day45_sent_at is null and b.day0_sent_at + interval '45 days' <= now() then 'day45'
        else null
      end as step_due
    from base b
  )
  select s.code, s.name, s.untouched, s.warm, s.note,
    s.icp_emails, s.icp_phones, s.scp_emails, s.scp_phones, s.other_emails, s.other_phones,
    s.last_any, s.days_since_any, s.last_waitlist, s.held_until,
    s.in_proposal, s.pm_id, s.signups, s.threshold,
    s.day0_sent_at, s.day3_sent_at, s.day10_sent_at, s.day45_sent_at, s.formal_at, s.formal_sent_at, s.event_date, s.venue,
    s.stage, s.step_due,
    s.orgs, s.last_playbook, (current_date - s.last_waitlist)::int,
    case when s.in_proposal and s.threshold is not null then greatest(0, s.threshold - s.signups)::int end,
    s.nearest, s.miles, s.rank_score, s.cooldown_days,
    -- Only the opening ask waits out the cooldown (point 2 above).
    (s.step_due = 'day0' and s.held_until is not null)
  from staged s
  order by s.untouched desc, s.rank_score desc, s.name;
$$;

-- ── 4. The threshold alert ─────────────────────────────────────────────────────────────────
create or replace function public.waitlist_alerts()
returns table (proposal_id uuid, proposal_name text, code text, name text, signups bigint, threshold int)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, pm.code, g.name, count(s.id), p.threshold
  from public.proposal_markets pm
  join public.event_proposals p on p.id = pm.proposal_id and p.status <> 'closed'
  join public.geo_region g on g.code = pm.code
  join public.proposal_signups s on s.proposal_id = pm.proposal_id and s.code = pm.code
  where pm.formal_at is null
  group by p.id, p.name, pm.code, g.name, p.threshold
  having count(s.id) >= p.threshold
  order by p.name, g.name;
$$;

-- ── 5. Who a re-ask must skip ──────────────────────────────────────────────────────────────
-- Empty for anything but a Day 3 / 10 / 45 row on a market whose Day 0 has gone out.
create or replace function public.waitlist_repliers(p_queue_id uuid)
returns table (email text, phone text)
language sql stable security definer set search_path = public as $$
  with q as (
    select c.proposal_id, c.proposal_step, upper(c.state_code) as code
    from public.campaign_queue c where c.id = p_queue_id
  ),
  pm as (
    select pm.proposal_id, pm.code, pm.day0_sent_at
    from public.proposal_markets pm join q on q.proposal_id = pm.proposal_id and q.code = pm.code
    where q.proposal_step in ('day3', 'day10', 'day45') and pm.day0_sent_at is not null
  )
  select lower(btrim(e.from_email)), null::text
    from public.email_replies e, pm where e.received_at >= pm.day0_sent_at and e.from_email is not null
  union
  select null::text, m.from_number
    from public.telnyx_messages m, pm where m.direction = 'inbound' and m.created_at >= pm.day0_sent_at
  union
  -- Hand-raisers recorded with an email or a phone in the contact field.
  select case when s.contact ~ '@' then lower(btrim(s.contact)) end,
         case when s.contact !~ '@' and regexp_replace(s.contact, '\D', '', 'g') ~ '^1?\d{10}$'
              then '+1' || right(regexp_replace(s.contact, '\D', '', 'g'), 10) end
    from public.proposal_signups s join pm on pm.proposal_id = s.proposal_id and pm.code = s.code
   where s.contact is not null;
$$;

grant execute on function public.miles_between(numeric, numeric, numeric, numeric) to anon, authenticated, service_role;
grant execute on function public.waitlist_board_v2(uuid)   to anon, authenticated, service_role;
grant execute on function public.waitlist_alerts()         to anon, authenticated, service_role;
grant execute on function public.waitlist_repliers(uuid)   to anon, authenticated, service_role;
