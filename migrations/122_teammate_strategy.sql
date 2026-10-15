-- 122: Teammate as its own strategy (AI-1129) — offers per market AND SPORT, Cole's templates.
--
-- WHAT THIS IS. Teammate AI outreach has no event and no date: the ask is a 15-minute feedback
-- call, worded for one sport ("AI tools for [SPORT] organizations"). So a Teammate offer is a
-- (market, sport) pair, and the people it reaches are that market's contacts who play that sport.
-- Until now the two Teammate templates (migration 096) were tagged ticket_blasts and could never
-- be picked for anything; they become the 'teammate' strategy's library here.
--
-- SENDER. Cole's templates as written (John, 2026-10-15: "use Cole's for now") — Will on email,
-- James on SMS — through the same sending accounts as every other blast. A Teammate domain and
-- numbers are an open question for Marx; when they exist they are a sender change, not a schema one.
--
-- SHARED RULES, NOT COPIES. Suppression (is_suppressed, migration 086) and the market cooldown
-- (market_cooldowns over market_blast_log) are the same tables every play reads, so a contact
-- suppressed or a market cooling from any Playbook blast is held here too, and a Teammate send
-- cools the market for everyone (log_market_blast with p_strategy = 'teammate').
--
-- Rollback: 122_teammate_strategy_rollback.sql.

-- ── 1. The strategy, and its templates ──────────────────────────────────────────────────────
insert into public.offer_strategies (code, label, offer_type, active, sort_order)
values ('teammate', 'Teammate', 'Teammate AI', true, 40)
on conflict (code) do update set active = true, label = excluded.label, offer_type = excluded.offer_type;

update public.message_templates set strategy = 'teammate' where slug in ('teammate-email', 'teammate-sms');

-- ── 2. The sport a queued row is for ────────────────────────────────────────────────────────
-- A ticket row's sport comes from its game (events_master, via get_campaign_queue). A Teammate
-- row has no game, so the sport rides on the row. Read straight off the table by the drafter and
-- the tick, like proposal_id / proposal_step (migration 120) — get_campaign_queue is not widened.
alter table public.campaign_queue add column if not exists target_sport text;

-- ── 3. One spelling per sport ───────────────────────────────────────────────────────────────
-- market_contacts.primary_sport is free text from several scrapers: "ice_hockey", "ice hockey",
-- "ice-hockey" and "hockey" are one sport, and a Teammate email to "ice_hockey organizations"
-- reads like a bug. The key folds separators and the known synonyms; unknowns return null and
-- are left out of Teammate (no sport means no sport-specific pitch).
create or replace function public.sport_key(p text)
returns text language sql immutable as $$
  with s as (select nullif(btrim(regexp_replace(lower(coalesce(p, '')), '[-_\s]+', ' ', 'g')), '') as k)
  select case
    when k is null or k in ('unknown', '(unknown)', 'other') then null
    when k in ('ice hockey', 'hockey')                        then 'hockey'
    when k in ('baseball softball')                           then 'baseball softball'
    when k in ('cheerleading', 'cheer')                       then 'cheer'
    when k in ('rock climbing', 'climbing')                   then 'climbing'
    when k in ('flagfootball', 'flag football')               then 'flag football'
    when k in ('golfs', 'golf')                               then 'golf'
    when k in ('multisport', 'multi sport')                   then 'multi sport'
    when k in ('swim', 'swimming', 'aquatic')                 then 'swimming'
    when k in ('track', 'track and field')                    then 'track and field'
    when k in ('ski', 'skiing')                               then 'skiing'
    when k in ('ice skating', 'skating')                      then 'skating'
    else k
  end from s;
$$;

-- ── 4. Recipients for one sport ─────────────────────────────────────────────────────────────
-- market_emails / market_phones with one more condition. Copies, not wrappers, so the allowlist
-- and suppression clauses read exactly as they do there; if those change, change these too.
create or replace function public.market_emails_sport(p_code text, p_segment text, p_sport text)
returns table(email text)
language sql stable security definer set search_path = public as $$
  select mc.email from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.email is not null
    and (p_segment is null or coalesce(mc.segment, 'Other') = p_segment)
    and public.sport_key(mc.primary_sport) = public.sport_key(p_sport)
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
    and not public.is_suppressed(mc.email, null, 'email')
  order by mc.email;
$$;

create or replace function public.market_phones_sport(p_code text, p_segment text, p_sport text)
returns table(phone text)
language sql stable security definer set search_path = public as $$
  select mc.phone from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.phone is not null
    and (p_segment is null or coalesce(mc.segment, 'Other') = p_segment)
    and public.sport_key(mc.primary_sport) = public.sport_key(p_sport)
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
    and not public.is_suppressed(null, mc.phone, 'sms')
  order by mc.phone;
$$;

-- ── 5. The sports there are, and the board for one ──────────────────────────────────────────
-- Counts come from market_sport_counts (already suppression-filtered via v_sendable_contacts,
-- refreshed with the other contact summaries), folded through sport_key.
create or replace function public.teammate_sports()
returns table(sport text, markets bigint, emails bigint, phones bigint)
language sql stable security definer set search_path = public as $$
  select public.sport_key(c.sport) as sport,
         count(distinct c.code) as markets,
         sum(c.email_count)::bigint as emails, sum(c.phone_count)::bigint as phones
  from public.market_sport_counts c
  where public.sport_key(c.sport) is not null
  group by 1
  order by sum(c.email_count) + sum(c.phone_count) desc;
$$;

-- One row per market that has anybody for this sport: reach per segment, the last blast of any
-- strategy, the last Teammate blast, and which segments are cooling right now (the same
-- market_cooldowns() the tick holds on, so the board and the sender agree).
create or replace function public.teammate_board(p_sport text)
returns table (
  code text, name text, country text,
  icp_emails bigint, icp_phones bigint, scp_emails bigint, scp_phones bigint, other_emails bigint, other_phones bigint,
  last_blast_any date, days_since_any int, last_blast_teammate date,
  icp_cooled boolean, scp_cooled boolean, other_cooled boolean, cooled_until date
)
language sql stable security definer set search_path = public as $$
  with reach as (
    select c.code,
      sum(c.email_count) filter (where c.segment = 'ICP')   as icp_emails,
      sum(c.phone_count) filter (where c.segment = 'ICP')   as icp_phones,
      sum(c.email_count) filter (where c.segment = 'SCP')   as scp_emails,
      sum(c.phone_count) filter (where c.segment = 'SCP')   as scp_phones,
      sum(c.email_count) filter (where c.segment not in ('ICP','SCP')) as other_emails,
      sum(c.phone_count) filter (where c.segment not in ('ICP','SCP')) as other_phones
    from public.market_sport_counts c
    where public.sport_key(c.sport) = public.sport_key(p_sport)
    group by c.code
  ),
  hist as (
    select l.market_code as code, max(l.sent_on) as last_any,
           max(l.sent_on) filter (where l.strategy = 'teammate') as last_tm
    from public.market_blast_log l group by l.market_code
  ),
  cd as (
    select upper(m.market_code) as code,
      bool_or(m.cooled) filter (where m.segment = 'ICP')   as icp_cooled,
      bool_or(m.cooled) filter (where m.segment = 'SCP')   as scp_cooled,
      bool_or(m.cooled) filter (where m.segment = 'Other') as other_cooled,
      max(current_date + m.days_left) filter (where m.cooled) as cooled_until
    from public.market_cooldowns() m group by 1
  )
  select r.code, g.name, g.country,
    coalesce(r.icp_emails,0)::bigint, coalesce(r.icp_phones,0)::bigint,
    coalesce(r.scp_emails,0)::bigint, coalesce(r.scp_phones,0)::bigint,
    coalesce(r.other_emails,0)::bigint, coalesce(r.other_phones,0)::bigint,
    h.last_any, (current_date - h.last_any)::int, h.last_tm,
    coalesce(cd.icp_cooled,false), coalesce(cd.scp_cooled,false), coalesce(cd.other_cooled,false), cd.cooled_until
  from reach r
  join public.geo_region g on g.code = r.code
  left join hist h on h.code = r.code
  left join cd on cd.code = r.code
  order by coalesce(r.icp_emails,0) + coalesce(r.icp_phones,0) + coalesce(r.scp_emails,0) + coalesce(r.scp_phones,0) desc, g.name;
$$;

grant execute on function public.sport_key(text)                               to anon, authenticated, service_role;
grant execute on function public.market_emails_sport(text, text, text)          to anon, authenticated, service_role;
grant execute on function public.market_phones_sport(text, text, text)          to anon, authenticated, service_role;
grant execute on function public.teammate_sports()                              to anon, authenticated, service_role;
grant execute on function public.teammate_board(text)                           to anon, authenticated, service_role;
