-- RUN THIS BY HAND in the Supabase SQL editor, after migration 100.
--
-- Two statements that could not be issued from the migration tooling used here: a DELETE and a
-- DROP. Everything else in 100 is already applied to production (snfmggrnyjayuuxafats).
--
-- Neither is urgent. Part 1 is tidiness; Part 2 is what makes an uploaded contact's state
-- visible in the Contacts tab.


-- =============================================================================================
-- PART 1 — remove the fifteen test contacts created while verifying the State field.
--
-- All @example.com fixtures from the migration 100 acceptance checks: the state resolver
-- (California/il/new york/Ontario/ALBERTA/"Calif."), the Canadian fallback, and one end-to-end
-- import through the route. None are in the send audience.
-- =============================================================================================

delete from ticketblaster.imported_contacts
where source_file in ('state-check.csv', 'state-check2.csv', 'e2e-state.csv');

-- Should be 0 afterwards, until a real list is uploaded.
select count(*) as imported_rows from ticketblaster.imported_contacts;


-- =============================================================================================
-- PART 2 — let an uploaded contact's state reach the Contacts tab.
--
-- contact_directory still reads `null::text as state` for uploaded rows: that was correct when
-- the table had no state column (091/093) and is now simply out of date. Until this runs, an
-- uploaded contact with a state shows a blank State column and is missing from the state filter.
--
-- This is the SAME matview definition as 093 with one line changed -- the `im` CTE selects
-- state_code instead of null. state_code rather than the raw `state`, because the rest of the
-- directory holds two-letter codes and mixing "California" in beside "CA" would split the filter
-- in two.
--
-- WHILE IT IS DROPPED the Contacts tab errors, for roughly the 15-20s the rebuild takes. A
-- materialized view has no CREATE OR REPLACE, so a definition change means dropping it.
-- =============================================================================================

drop materialized view if exists public.contact_directory;

create materialized view public.contact_directory as
with hs as (
  select public.sendable_email(email)                        as email_key,
         public.norm_phone_e164(coalesce(mobilephone, phone)) as phone_e164,
         hs_object_id::text                                   as sid,
         firstname as first_name, lastname as last_name,
         email, coalesce(mobilephone, phone) as phone, company, state,
         hs_lastmodifieddate                                  as updated_at
  from hubspot.hubspot_contacts
),
ci as (
  select public.sendable_email(c.email)  as email_key,
         public.norm_phone_e164(c.phone) as phone_e164,
         c.id::text                      as sid,
         c.first_name, c.last_name, c.email, c.phone,
         co.organization_name            as company,
         co.state, c.updated_at
  from public.contact_intel c
  left join public.company_intel co on co.id = c.company_intel_id
),
im as (
  select email_key, phone_e164, id::text as sid,
         first_name, last_name, email, phone,
         null::text as company,
         -- CHANGED (migration 100): was null. The resolved code, not the raw text, so this
         -- column holds one vocabulary.
         state_code as state,
         updated_at
  from ticketblaster.imported_contacts
),
unioned as (
  select 'hubspot'::text  as src, * from hs
  union all
  select 'intel'::text    as src, * from ci
  union all
  select 'imported'::text as src, * from im
),
keyed as (
  select coalesce(email_key, phone_e164) as identity_key, *
  from unioned
  where coalesce(email_key, phone_e164) is not null
)
select
  identity_key,
  bool_or(src = 'hubspot')  as in_hubspot,
  bool_or(src = 'intel')    as in_intel,
  bool_or(src = 'imported') as in_imported,
  max(sid) filter (where src = 'hubspot')  as hubspot_id,
  max(sid) filter (where src = 'intel')    as intel_id,
  max(sid) filter (where src = 'imported') as imported_id,
  coalesce(max(first_name) filter (where src = 'hubspot'),
           max(first_name) filter (where src = 'intel'),
           max(first_name) filter (where src = 'imported')) as first_name,
  coalesce(max(last_name)  filter (where src = 'hubspot'),
           max(last_name)  filter (where src = 'intel'),
           max(last_name)  filter (where src = 'imported')) as last_name,
  coalesce(max(email)      filter (where src = 'hubspot'),
           max(email)      filter (where src = 'intel'),
           max(email)      filter (where src = 'imported')) as email,
  coalesce(max(phone)      filter (where src = 'hubspot'),
           max(phone)      filter (where src = 'intel'),
           max(phone)      filter (where src = 'imported')) as phone,
  coalesce(max(company)    filter (where src = 'hubspot'),
           max(company)    filter (where src = 'intel'))    as company,
  -- An uploaded row is now a THIRD source of state, last in the order for the same reason it is
  -- last everywhere else: HubSpot is maintained by a person, intel is scraped, an upload is a
  -- one-off.
  coalesce(max(state)      filter (where src = 'hubspot'),
           max(state)      filter (where src = 'intel'),
           max(state)      filter (where src = 'imported'))  as state,
  max(updated_at) as updated_at,
  lower(concat_ws(' ',
    coalesce(max(first_name) filter (where src = 'hubspot'), max(first_name) filter (where src = 'intel'), max(first_name) filter (where src = 'imported')),
    coalesce(max(last_name)  filter (where src = 'hubspot'), max(last_name)  filter (where src = 'intel'), max(last_name)  filter (where src = 'imported')),
    coalesce(max(email)      filter (where src = 'hubspot'), max(email)      filter (where src = 'intel'), max(email)      filter (where src = 'imported')),
    coalesce(max(phone)      filter (where src = 'hubspot'), max(phone)      filter (where src = 'intel'), max(phone)      filter (where src = 'imported')),
    coalesce(max(company)    filter (where src = 'hubspot'), max(company)    filter (where src = 'intel'))
  )) as search_text
from keyed
group by identity_key;

create unique index contact_directory_key_idx      on public.contact_directory (identity_key);
create index        contact_directory_search_idx   on public.contact_directory using gin (search_text gin_trgm_ops);
create index        contact_directory_state_idx    on public.contact_directory (state);
create index        contact_directory_presence_idx on public.contact_directory (in_hubspot, in_intel, in_imported);

revoke all on public.contact_directory from anon, authenticated;
grant select on public.contact_directory to service_role;

comment on materialized view public.contact_directory is
  'One row per person across hubspot_contacts, contact_intel and imported_contacts, merged on sendable_email/norm_phone_e164. Rebuild with refresh_contact_directory(). See migrations 091, 093 and 100.';

-- Sets contact_directory_state, which the Contacts tab prints as "rebuilt".
select * from public.refresh_contact_directory();
