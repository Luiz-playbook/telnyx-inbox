-- 080: carry the organisation's own sport through to the audience layer.
--
-- WHAT WAS MISSING
--
-- company_intel.primary_sport says what each organisation actually does — 108,045 of them,
-- and it is well populated:
--
--   other 26.4%   multi_sport 10.3%   soccer 9.6%   baseball 7.7%   basketball 7.2%
--   dance 5.0%    hockey 4.7%         fitness 4.5%  football 3.5%   volleyball 2.5%
--   lacrosse 2.5% softball 2.1%       tennis 1.7%   pickleball 1.2% martial_arts 1.2%
--   only 1.8% have none set
--
-- refresh_market_contacts() flattens company_intel + contact_intel into market_contacts, which
-- is what every count and every send reads — and it DROPPED primary_sport on the way. So the
-- audience layer has never known what kind of organisation it is talking to. A blast could be
-- split by state and by ICP/SCP/Other, and by nothing else.
--
-- WHY IT MATTERS MORE THAN IT SOUNDS. Nothing filters recipients by sport today, and that is
-- correct — a dance studio buying a suite for a Wild game is a perfectly good customer, they
-- want a night out for their families, not a hockey connection. The point is not to start
-- excluding people. It is that for a baseball game the NON-baseball audience is 92.3% of the
-- list, and there has been no way to see that, let alone target it deliberately.
--
-- This migration adds the dimension. It changes no send behaviour on its own: market_phones and
-- market_emails are untouched, so every existing blast resolves exactly the same audience it did
-- yesterday.

alter table public.market_contacts
  add column if not exists primary_sport text;

comment on column public.market_contacts.primary_sport is
  'The organisation''s own sport, from company_intel.primary_sport, lower-cased and trimmed. '
  'Null where the source has none. Written by refresh_market_contacts (migration 080). Does NOT '
  'affect who a blast reaches — market_phones/market_emails do not filter on it.';

create index if not exists market_contacts_code_sport_idx
  on public.market_contacts (code, primary_sport);

-- ---------------------------------------------------------------------------
-- 1. Carry it at refresh.
--
-- Migration 050's function verbatim, with primary_sport added to the column list and the select.
-- Everything else — the truncate-and-rebuild, the state_alias join, the ICP/SCP/Other
-- normalisation, the "has a phone or an email" filter — is unchanged and must stay so: this runs
-- on a daily cron and rebuilds the entire audience layer.
--
-- NORMALISED THE SAME WAY THE SEGMENT IS, lower/trim, so 'Baseball' and 'baseball ' group as one
-- value. Left as NULL rather than bucketed into 'other' when absent: 'other' is a real value in
-- this data (26.4% of organisations chose it) and folding "unknown" into it would silently
-- inflate the largest category with 1,910 organisations nobody has classified.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_market_contacts()
returns void
language plpgsql volatile security definer set search_path to 'public'
as $function$
begin
  truncate public.market_contacts;
  insert into public.market_contacts
    (code, state_name, organization_name, city, contact_name, title, phone, email, segment,
     primary_sport)
  select s.code,
         s.name,
         ci.organization_name,
         ci.city,
         nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
         c.title,
         nullif(btrim(c.phone), ''),
         nullif(lower(btrim(c.email)), ''),
         case lower(btrim(coalesce(ci.lead_segment, '')))
           when 'icp' then 'ICP'
           when 'scp' then 'SCP'
           else 'Other'
         end,
         nullif(lower(btrim(coalesce(ci.primary_sport, ''))), '')
  from public.contact_intel c
  join public.company_intel ci on ci.id = c.company_intel_id
  join public.state_alias  sa on sa.alias = upper(btrim(ci.state))
  join public.us_states     s on s.code = sa.code
  where (c.phone is not null and btrim(c.phone) <> '')
     or (c.email is not null and btrim(c.email) <> '');
  refresh materialized view public.market_counts;
  refresh materialized view public.market_segment_counts;
  refresh materialized view public.market_sport_counts;
end;
$function$;

grant execute on function public.refresh_market_contacts() to service_role;

-- ---------------------------------------------------------------------------
-- 2. Reach, by market and segment and sport.
--
-- A third counts view rather than more columns on the existing two: the grain is different, and
-- widening market_segment_counts would make every existing reader carry a dimension it does not
-- use.
--
-- COUNTED THE SAME WAY 073 COUNTS — distinct sendable numbers and addresses, through
-- sendable_phone/sendable_email — so a figure here means the same thing as a figure there and
-- the two can be compared without a footnote. Counting rows here while counting people there
-- would have reintroduced exactly the inflation 073 removed.
-- ---------------------------------------------------------------------------
drop materialized view if exists public.market_sport_counts;

create materialized view public.market_sport_counts as
  select code,
         coalesce(segment, 'Other')            as segment,
         coalesce(primary_sport, '(unknown)')  as sport,
         count(distinct public.sendable_phone(phone)) as phone_count,
         count(distinct public.sendable_email(email)) as email_count
  from public.market_contacts
  group by code, coalesce(segment, 'Other'), coalesce(primary_sport, '(unknown)');

create unique index if not exists market_sport_counts_pk
  on public.market_sport_counts (code, segment, sport);

grant select on public.market_sport_counts to anon, authenticated, service_role;

comment on materialized view public.market_sport_counts is
  'Distinct sendable reach per market x segment x the organisation''s own sport (migration 080). '
  'Counted through sendable_phone/sendable_email so it means the same as market_counts. Refreshed '
  'by refresh_market_contacts. Sums across sport equal the segment total only where a contact has '
  'one sport, which is always — a contact belongs to one organisation.';

-- ---------------------------------------------------------------------------
-- 3. Populate now.
--
-- market_contacts is rebuilt wholesale by the function above, so the new column is null on every
-- row until it runs. Running it here means the migration leaves the data correct rather than
-- correct-tomorrow — and the UI reads these counts immediately.
--
-- It truncates and reinserts ~82,000 rows and refreshes three matviews. Seconds, not minutes,
-- but it is the heaviest statement in this file.
-- ---------------------------------------------------------------------------
select public.refresh_market_contacts();
