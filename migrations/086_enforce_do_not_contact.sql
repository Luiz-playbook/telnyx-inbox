-- 086: actually stop contacting the people on the do-not-contact list.
--
-- 085 built the list. 724,415 records are now in it and every one of them would still receive a
-- blast today, because nothing reads it. This closes that.
--
-- WHY HERE, AND ONLY HERE
--
-- market_phones and market_emails are the single gate every blast passes through — the hourly
-- cron, Send now, Add to Queue's immediate send, the agent, all of them resolve their audience
-- from these two functions and nothing else. Filtering here means suppression cannot be
-- forgotten by a caller, skipped by a new code path, or bypassed by whatever is written next
-- year. A check in api/queue-tick.js would cover today's callers and quietly miss tomorrow's.
--
-- It is also the honest place for it: after this, "who does this blast reach" has one answer,
-- and the reach counters, the queue's displayed numbers and the actual send all read it.
--
-- IT TOOK THREE ATTEMPTS TO MAKE THIS FAST ENOUGH TO APPLY, and the shape of the file is the
-- record of that. Both earlier versions timed out and rolled back cleanly — nothing applied,
-- nothing left half-done — and the before/after check is what caught the first one: zero drop
-- on every market, which the header below had already named as the signature of a failed match
-- rather than a successful no-op.
--
--   1st: is_suppressed() was SECURITY DEFINER. Postgres cannot inline one of those, so it became
--        a real call per row — ~500,000 of them, each an EXISTS against 724,415 rows.
--   2nd: the three counter views each normalised every value twice and ran their own NOT IN,
--        and the file then called refresh_market_contacts() on top, redoing the lot.
--   3rd: one shared view does the normalising and the suppression once; the counters are plain
--        GROUP BYs over it, and nothing is rebuilt twice.
--
-- IF IT STILL TIMES OUT, split it: everything above the counter views is small and instant, and
-- the three CREATE MATERIALIZED VIEW statements can be run one at a time.
--
-- MEASURED BEFORE APPLYING, against the live database:
--
--     market   phones  emails        expected suppressed: ~12.5% of phones, ~10.0% of emails
--     MN         3753    2301        (measured across the whole audience: 4,612 of 36,992
--     CA         3774    6037         phones and 5,690 of 56,675 emails)
--     TX         3083    3288
--     FL         2929    3018
--
-- Run the same four after applying. A drop of roughly a tenth is right. No drop at all means
-- the match is failing and the list is doing nothing; a collapse means something is wrong with
-- the normalisation and the send has just lost most of its audience.
--
-- WHAT IS NOT CHANGED: the returned shape. Both functions still return the raw stored value, so
-- every caller downstream is untouched — this adds a filter, nothing else.

-- ---------------------------------------------------------------------------
-- The test, written once.
--
-- A function rather than the same NOT EXISTS pasted into two places: the two would drift, and a
-- suppression rule that is enforced on email but not SMS is worse than one that is enforced on
-- neither, because nobody would go looking.
--
-- NORMALISES BOTH SIDES THROUGH sendable_phone / sendable_email. The list is stored normalised
-- (085) and market_contacts is not, so comparing the raw values would match almost nothing — the
-- list would sit there looking enforced while a blast went out to everyone on it. This is the
-- single most important line in the file.
--
-- EXPIRY IS RESPECTED: a row with expires_at in the past no longer suppresses. Every row today
-- is permanent (expires_at null), so this changes nothing yet and means a temporary suppression
-- works the day someone needs one.
--
-- CHANNEL: null on the list means every channel. A row scoped to 'sms' does not suppress email.
--
-- STABLE, so the planner may cache it within a statement. It is still called per row by the two
-- resolvers below — a few thousand rows per market, against an indexed lookup — but NOT by the
-- counter views, which anti-join instead. See their note.
-- ---------------------------------------------------------------------------
-- NOT security definer, and that is a performance decision as much as a security one: Postgres
-- CANNOT INLINE a SECURITY DEFINER function, so it becomes a real call with its own snapshot per
-- row — half a million of them across the three counter views, each an EXISTS against 724,415
-- rows. That is what made the first version of this migration time out and roll back.
--
-- Plain, it inlines, and the planner turns it into a subquery it can optimise. do_not_contact
-- has RLS with a read policy for anon and authenticated (085), so no elevation is needed to read
-- it; and the matviews below are built by the owner, which bypasses RLS anyway.
create or replace function public.is_suppressed(p_email text, p_phone text, p_channel text)
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.do_not_contact d
    where (d.expires_at is null or d.expires_at > now())
      and (d.channel is null or d.channel = p_channel)
      and (
            (p_email is not null and d.email is not null and d.email = public.sendable_email(p_email))
         or (p_phone is not null and d.phone is not null and d.phone = public.sendable_phone(p_phone))
      )
  );
$function$;

comment on function public.is_suppressed(text, text, text) is
  'True when this address or number is on the do-not-contact list for this channel. Normalises '
  'both sides through sendable_email/sendable_phone — the list is stored normalised and '
  'market_contacts is not, so a raw comparison would match almost nothing and the list would '
  'look enforced while suppressing no one. Migration 086.';

revoke execute on function public.is_suppressed(text, text, text) from public;
grant  execute on function public.is_suppressed(text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The two resolvers. Migration 054's bodies verbatim, plus one clause each.
--
-- Everything else is deliberately untouched: the segment filter, the ORDER BY that makes offset
-- paging safe (api/queue-tick.js depends on it), and the send_allowlist gate that is the test
-- mode switch.
-- ---------------------------------------------------------------------------
create or replace function public.market_phones(p_code text, p_segment text default null)
 returns table(phone text) language sql stable security definer set search_path to 'public'
as $function$
  select mc.phone from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.phone is not null
    and (p_segment is null or coalesce(mc.segment, 'Other') = p_segment)
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
    -- Migration 086. Nobody on the do-not-contact list for SMS.
    and not public.is_suppressed(null, mc.phone, 'sms')
  order by mc.phone;
$function$;

create or replace function public.market_emails(p_code text, p_segment text default null)
 returns table(email text) language sql stable security definer set search_path to 'public'
as $function$
  select mc.email from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.email is not null
    and (p_segment is null or coalesce(mc.segment, 'Other') = p_segment)
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
    -- Migration 086. Nobody on the do-not-contact list for email.
    and not public.is_suppressed(mc.email, null, 'email')
  order by mc.email;
$function$;

-- ---------------------------------------------------------------------------
-- The counters have to agree with the send, or the screen lies.
--
-- market_counts and the two beside it are what the operator reads before approving a blast.
-- Leaving them counting suppressed people would put a number on screen that the send cannot
-- deliver — the same class of bug 073 removed, arriving by a different door.
--
-- ONE SHARED VIEW, THREE AGGREGATES. The second attempt at this file still timed out, and the
-- reason was duplicated work rather than any single slow step:
--
--   * each of the three views normalised every phone and email TWICE — once to count it, once
--     to test it against the list;
--   * each ran its own NOT IN against 724,415 rows;
--   * and the file then called refresh_market_contacts(), which rebuilt all three AGAIN on top
--     of the CREATE that had just populated them. The whole job, twice.
--
-- v_sendable_contacts does the normalising and the suppression ONCE. The three views become
-- plain GROUP BYs over it, which is what they always should have been, and the trailing refresh
-- is gone because CREATE MATERIALIZED VIEW populates.
--
-- LEFT JOIN ... IS NULL rather than NOT IN: NOT IN against a subquery that can contain NULL
-- silently returns no rows at all, and this is the last place to discover that. The anti-join
-- also lets the planner hash the list once and probe 84,650 rows against it.
-- ---------------------------------------------------------------------------
create or replace view public.v_sendable_contacts as
  with sup_phone as (
    select distinct phone from public.do_not_contact
     where phone is not null and (channel is null or channel = 'sms')
       and (expires_at is null or expires_at > now())
  ),
  sup_email as (
    select distinct email from public.do_not_contact
     where email is not null and (channel is null or channel = 'email')
       and (expires_at is null or expires_at > now())
  ),
  norm as (
    select mc.code, mc.state_name,
           coalesce(mc.segment, 'Other')           as segment,
           coalesce(mc.primary_sport, '(unknown)') as sport,
           public.sendable_phone(mc.phone) as p,
           public.sendable_email(mc.email) as e
    from public.market_contacts mc
  )
  select n.code, n.state_name, n.segment, n.sport,
         -- NULL where suppressed, which is what makes count(distinct ...) skip them without a
         -- second test: an unusable value and a suppressed one are both "nobody to send to".
         case when sp.phone is null then n.p end as phone,
         case when se.email is null then n.e end as email
  from norm n
  left join sup_phone sp on sp.phone = n.p
  left join sup_email se on se.email = n.e;

comment on view public.v_sendable_contacts is
  'market_contacts normalised and with the do-not-contact list already applied (086). phone and '
  'email are NULL where the contact is unusable OR suppressed. The three counter views aggregate '
  'this so the normalising and the suppression happen once, not six times.';

grant select on public.v_sendable_contacts to anon, authenticated, service_role;

drop materialized view if exists public.market_counts;
create materialized view public.market_counts as
  select code, max(state_name) as name,
         count(distinct phone) as phone_count,
         count(distinct email) as email_count
  from public.v_sendable_contacts group by code;
create unique index if not exists market_counts_pk on public.market_counts (code);
grant select on public.market_counts to anon, authenticated, service_role;

drop materialized view if exists public.market_segment_counts;
create materialized view public.market_segment_counts as
  select code, segment, max(state_name) as name,
         count(distinct phone) as phone_count,
         count(distinct email) as email_count
  from public.v_sendable_contacts group by code, segment;
create unique index if not exists market_segment_counts_pk on public.market_segment_counts (code, segment);
grant select on public.market_segment_counts to anon, authenticated, service_role;

drop materialized view if exists public.market_sport_counts;
create materialized view public.market_sport_counts as
  select code, segment, sport,
         count(distinct phone) as phone_count,
         count(distinct email) as email_count
  from public.v_sendable_contacts group by code, segment, sport;
create unique index if not exists market_sport_counts_pk on public.market_sport_counts (code, segment, sport);
grant select on public.market_sport_counts to anon, authenticated, service_role;

comment on materialized view public.market_counts is
  'Distinct sendable reach per market, EXCLUDING anyone on the do-not-contact list (086). What a '
  'blast would actually deliver to, so the number on screen and the number that receives the '
  'message are the same.';

-- NO TRAILING refresh_market_contacts(). CREATE MATERIALIZED VIEW populates, and that call would
-- rebuild market_contacts and re-refresh all three on top of work just done — which is a large
-- part of why the earlier attempts ran out of time. The daily cron still calls it, unchanged.
