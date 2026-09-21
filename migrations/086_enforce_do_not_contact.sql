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
-- STABLE, not VOLATILE, so the planner may cache it within a statement — this is called once per
-- candidate row across tens of thousands of them.
-- ---------------------------------------------------------------------------
create or replace function public.is_suppressed(p_email text, p_phone text, p_channel text)
returns boolean
language sql
stable
security definer
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
-- market_counts and market_segment_counts are what the operator reads before approving a blast.
-- Leaving them counting suppressed people would put a number on screen that the send cannot
-- deliver — which is precisely the class of bug 073 was written to remove, arriving by a
-- different door.
--
-- Same shape as 073/080, with the suppression test added. Rebuilt rather than refreshed because
-- the definition changes.
-- ---------------------------------------------------------------------------
drop materialized view if exists public.market_counts;

create materialized view public.market_counts as
  select code,
         max(state_name) as name,
         count(distinct public.sendable_phone(phone)) filter (where not public.is_suppressed(null, phone, 'sms'))   as phone_count,
         count(distinct public.sendable_email(email)) filter (where not public.is_suppressed(email, null, 'email')) as email_count
  from public.market_contacts
  group by code;

create unique index if not exists market_counts_pk on public.market_counts (code);
grant select on public.market_counts to anon, authenticated, service_role;

drop materialized view if exists public.market_segment_counts;

create materialized view public.market_segment_counts as
  select code,
         coalesce(segment, 'Other') as segment,
         max(state_name) as name,
         count(distinct public.sendable_phone(phone)) filter (where not public.is_suppressed(null, phone, 'sms'))   as phone_count,
         count(distinct public.sendable_email(email)) filter (where not public.is_suppressed(email, null, 'email')) as email_count
  from public.market_contacts
  group by code, coalesce(segment, 'Other');

create unique index if not exists market_segment_counts_pk on public.market_segment_counts (code, segment);
grant select on public.market_segment_counts to anon, authenticated, service_role;

drop materialized view if exists public.market_sport_counts;

create materialized view public.market_sport_counts as
  select code,
         coalesce(segment, 'Other')            as segment,
         coalesce(primary_sport, '(unknown)')  as sport,
         count(distinct public.sendable_phone(phone)) filter (where not public.is_suppressed(null, phone, 'sms'))   as phone_count,
         count(distinct public.sendable_email(email)) filter (where not public.is_suppressed(email, null, 'email')) as email_count
  from public.market_contacts
  group by code, coalesce(segment, 'Other'), coalesce(primary_sport, '(unknown)');

create unique index if not exists market_sport_counts_pk on public.market_sport_counts (code, segment, sport);
grant select on public.market_sport_counts to anon, authenticated, service_role;

comment on materialized view public.market_counts is
  'Distinct sendable reach per market, EXCLUDING anyone on the do-not-contact list (086). Counts '
  'what a blast would actually deliver to, so the number on screen and the number that receives '
  'the message are the same.';

-- ---------------------------------------------------------------------------
-- Populate. refresh_market_contacts rebuilds all three and already carries its own 300s
-- statement timeout (082) — which matters more now, since each counted row runs a suppression
-- lookup against 724,415 rows.
-- ---------------------------------------------------------------------------
select public.refresh_market_contacts();
