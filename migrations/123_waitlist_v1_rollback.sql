-- Rollback for 123_waitlist_v1.sql. Restores waitlist_board() exactly as migration 120 wrote it
-- (25 days hardcoded, the old ordering, no day0_held), and removes the settings and helpers.
-- api/queue-tick.js and ui/index.html fall back cleanly: a board row with no day0_held reads as
-- "held" whenever held_until is set, which is 120's behaviour.
drop function if exists public.waitlist_repliers(uuid);
drop function if exists public.waitlist_alerts();
drop function if exists public.waitlist_board(uuid);

create or replace function public.waitlist_board(p_proposal uuid default null)
returns table (
  code text, name text, untouched boolean, warm boolean, note text,
  icp_emails bigint, icp_phones bigint, scp_emails bigint, scp_phones bigint, other_emails bigint, other_phones bigint,
  last_blast_any date, days_since_any int, last_blast_waitlist date, held_until date,
  in_proposal boolean, pm_id uuid, signups bigint, threshold int,
  day0_sent_at timestamptz, day3_sent_at timestamptz, day10_sent_at timestamptz, day45_sent_at timestamptz,
  formal_at timestamptz, formal_sent_at timestamptz, event_date date, venue text,
  stage text, step_due text
)
language sql stable security definer set search_path = public as $$
  with cool as (
    select r.cooldown_floor_days from public.decider_rules r where r.id = 1
  ),
  reach as (
    select s.code,
      sum(s.emails) filter (where s.segment = 'ICP')   as icp_emails,
      sum(s.phones) filter (where s.segment = 'ICP')   as icp_phones,
      sum(s.emails) filter (where s.segment = 'SCP')   as scp_emails,
      sum(s.phones) filter (where s.segment = 'SCP')   as scp_phones,
      sum(s.emails) filter (where s.segment not in ('ICP','SCP') or s.segment is null) as other_emails,
      sum(s.phones) filter (where s.segment not in ('ICP','SCP') or s.segment is null) as other_phones
    from public.state_segment_summary_mv s group by s.code
  ),
  hist as (
    select l.market_code as code,
      max(l.sent_on) as last_any,
      max(l.sent_on) filter (where l.strategy = 'event_waitlist') as last_waitlist
    from public.market_blast_log l group by l.market_code
  ),
  su as (
    select s.code, count(*) as n from public.proposal_signups s where s.proposal_id = p_proposal group by s.code
  ),
  base as (
    select w.code, g.name, w.untouched, w.warm, w.note,
      coalesce(r.icp_emails,0) icp_emails, coalesce(r.icp_phones,0) icp_phones,
      coalesce(r.scp_emails,0) scp_emails, coalesce(r.scp_phones,0) scp_phones,
      coalesce(r.other_emails,0) other_emails, coalesce(r.other_phones,0) other_phones,
      h.last_any, (current_date - h.last_any)::int as days_since_any, h.last_waitlist,
      -- 25 days, not the ticket floor: the waitlist doc sets its own global cooldown.
      case when h.last_any is not null and h.last_any + 25 > current_date then h.last_any + 25 end as held_until,
      pm.id as pm_id, (pm.id is not null) as in_proposal,
      coalesce(su.n, 0) as signups, p.threshold,
      pm.day0_sent_at, pm.day3_sent_at, pm.day10_sent_at, pm.day45_sent_at, pm.formal_at, pm.formal_sent_at,
      pm.event_date, pm.venue
    from public.waitlist_markets w
    join public.geo_region g on g.code = w.code
    left join reach r on r.code = w.code
    left join hist  h on h.code = w.code
    left join public.proposal_markets pm on pm.code = w.code and pm.proposal_id = p_proposal
    left join public.event_proposals p on p.id = p_proposal
    left join su on su.code = w.code
  )
  select b.code, b.name, b.untouched, b.warm, b.note,
    b.icp_emails, b.icp_phones, b.scp_emails, b.scp_phones, b.other_emails, b.other_phones,
    b.last_any, b.days_since_any, b.last_waitlist, b.held_until,
    b.in_proposal, b.pm_id, b.signups, b.threshold,
    b.day0_sent_at, b.day3_sent_at, b.day10_sent_at, b.day45_sent_at, b.formal_at, b.formal_sent_at, b.event_date, b.venue,
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
  order by b.untouched desc, b.in_proposal desc, b.icp_emails desc, b.name;
$$;
grant execute on function public.waitlist_board(uuid) to anon, authenticated, service_role;

drop function if exists public.miles_between(numeric, numeric, numeric, numeric);
alter table public.waitlist_markets drop column if exists lat, drop column if exists lng;
drop table if exists public.waitlist_settings;
