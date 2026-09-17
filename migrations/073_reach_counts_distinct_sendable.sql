-- 073: make the audience counters count PEOPLE REACHED, not table rows.
--
-- WHAT WAS WRONG
--
-- market_counts and market_segment_counts both counted rows:
--
--     count(*) filter (where phone is not null) as phone_count
--
-- market_contacts holds one row per CONTACT, and several contacts at one organisation share
-- that organisation's switchboard number. So a number shared by four people was counted four
-- times, and the figure on screen was a count of contact records wearing the label "phone
-- numbers".
--
-- The send has always deduplicated (api/queue-tick.js builds a Set of normalised numbers before
-- handing anything to Telnyx), so nobody was ever texted twice. The damage was entirely in the
-- reporting: the operator approved a blast believing it would reach 3,753 people in Minnesota
-- when 2,388 would.
--
-- Measured live on 2026-09-16, top five markets by displayed reach:
--
--     market   displayed   distinct   actually sendable
--     MN        3,753       2,644        2,388
--     CA        3,688       3,366        3,236
--     TX        3,030       2,822        2,729
--     FL        2,907       2,750        2,571
--     OH        1,999       1,815        1,733
--     totals   15,377      13,397       12,657
--
-- Minnesota's figure was 1.57x the truth. Across these five it is 1.2x.
--
-- DISTINCT ALONE IS NOT ENOUGH, which is why this migration does more than add one keyword.
-- Between "distinct" and "actually sendable" sits junk that will never receive anything:
-- market_contacts holds values like '01 (650) 658 6823' and '(098) 765-4321'. api/queue-tick.js
-- normalises to E.164 and drops whatever does not match, so those are discarded at send time and
-- were being counted as reach right up until then.
--
-- THE TARGET IS EXACT AGREEMENT WITH THE SEND. After this, phone_count is the count of distinct
-- numbers api/queue-tick.js will actually resolve for that market — not an estimate of it. A
-- counter that is merely closer to the truth still has to be explained; one that matches does
-- not. That is why norm_phone_e164() below is a deliberate, line-by-line port of normPhone in
-- api/queue-tick.js rather than a tidier equivalent.
--
-- IF EITHER SIDE CHANGES, BOTH MUST. normPhone/validPhone in api/queue-tick.js and
-- norm_phone_e164 here are one rule expressed twice, and they will drift silently: the symptom
-- would be a reach figure that no longer matches what sends, which is exactly the bug being
-- fixed. There is no test suite in this repo to catch it (checked: no package.json, no runner).

-- ---------------------------------------------------------------------------
-- 1. The shared normalisation.
--
-- Port of:
--   const normPhone  = p => { let d=(p||'').replace(/[^\d+]/g,'');
--                             if(d&&d[0]!=='+'){ if(d.length===10)d='+1'+d;
--                                                else if(d.length===11&&d[0]==='1')d='+'+d; }
--                             return d; };
--   const validPhone = p => /^\+\d{10,15}$/.test(p||'');
--
-- Note the JS keeps '+' wherever it appears and returns early when the string already starts
-- with one, so '6+1555...' survives normalisation and is then rejected by validPhone. This does
-- the same, so both sides reject the same strings for the same reason.
--
-- IMMUTABLE because it depends only on its argument — required for it to be usable in the
-- materialized views below and in an index if one is ever wanted.
-- ---------------------------------------------------------------------------
create or replace function public.norm_phone_e164(p text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  with d as (select regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g') as v)
  select case
           when v = ''                                   then null
           when left(v, 1) = '+'                         then v
           when length(v) = 10                           then '+1' || v
           when length(v) = 11 and left(v, 1) = '1'      then '+'  || v
           else v            -- left alone, and rejected by the pattern below
         end
  from d;
$function$;

comment on function public.norm_phone_e164(text) is
  'E.164 normalisation, a port of normPhone in api/queue-tick.js. Change one and you must change '
  'the other: the reach counters use this so that the number shown equals the number the send '
  'resolves. Returns a string that still has to pass ^\+[0-9]{10,15}$ to be sendable.';

-- A number is reachable only if it normalises to E.164. Kept as its own function so the two
-- materialized views cannot drift from each other, and so the rule has one name.
create or replace function public.sendable_phone(p text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case when public.norm_phone_e164(p) ~ '^\+[0-9]{10,15}$'
              then public.norm_phone_e164(p) end;
$function$;

-- Port of validEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/. market_contacts already stores these
-- lower-cased and trimmed (refresh_market_contacts, migration 050), so no further normalisation
-- is needed — only the same validity test the send applies.
create or replace function public.sendable_email(e text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case when lower(btrim(coalesce(e, ''))) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
              then lower(btrim(e)) end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. The two counters.
--
-- DROP AND RECREATE, because a materialized view has no CREATE OR REPLACE.
--
-- market_counts is OLDER THAN THIS MIGRATION FOLDER — no file creates it, so its definition is
-- reproduced below from the live object rather than copied from a previous migration. It was
-- confirmed empirically before being rewritten: market_phones('MN') returns exactly 3,753 rows
-- and market_counts.phone_count read 3,753; market_emails('MN') returned 2,301 against an
-- email_count of 2,301. That pins the aggregate to `count(*) filter (where … is not null)` over
-- market_contacts grouped by code, which is what market_segment_counts (migration 050, the
-- sibling written by the same hand) does explicitly.
--
-- SAFE TO DROP: every reference to these two in the repo is from a FUNCTION —
-- market_recipient_counts (016), state_summary (032), get_campaign_queue (060/071) and
-- api/refresh-contacts.js. Postgres functions do not register a dependency on the objects they
-- query, so nothing is cascaded and nothing else needs recreating. Deliberately NOT using
-- `cascade`: if some view added later does depend on one of these, this should fail loudly here
-- rather than quietly delete it.
-- ---------------------------------------------------------------------------
drop materialized view if exists public.market_counts;

create materialized view public.market_counts as
  select code,
         max(state_name) as name,
         count(distinct public.sendable_phone(phone)) as phone_count,
         count(distinct public.sendable_email(email)) as email_count
  from public.market_contacts
  group by code;

-- count(distinct …) ignores NULLs, which is what carries the validity filter: an unsendable
-- number normalises to NULL and simply is not counted. No separate WHERE is needed, and adding
-- one would change the grouping.

create unique index if not exists market_counts_pk
  on public.market_counts (code);

grant select on public.market_counts to anon, authenticated, service_role;

drop materialized view if exists public.market_segment_counts;

create materialized view public.market_segment_counts as
  select code,
         coalesce(segment, 'Other') as segment,
         max(state_name) as name,
         count(distinct public.sendable_phone(phone)) as phone_count,
         count(distinct public.sendable_email(email)) as email_count
  from public.market_contacts
  group by code, coalesce(segment, 'Other');

-- THE SEGMENT FIGURES WILL NOT SUM TO THE MARKET FIGURE, and that is correct rather than a
-- rounding artefact. A switchboard number shared by an ICP contact and an SCP contact is one
-- distinct number in the market and one in each segment, so the segments total more than the
-- market. Each number is counted once per audience that would actually be sent to, which is
-- what each figure is used to decide. Anyone reconciling the two should read this first.

create unique index if not exists market_segment_counts_pk
  on public.market_segment_counts (code, segment);

grant select on public.market_segment_counts to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Populate.
--
-- CREATE MATERIALIZED VIEW populates on creation, so the two above already hold current data and
-- this is belt-and-braces for a re-run of this file. refresh_market_contacts() (migration 050)
-- is unchanged and keeps refreshing both on the daily cron.
-- ---------------------------------------------------------------------------
refresh materialized view public.market_counts;
refresh materialized view public.market_segment_counts;
