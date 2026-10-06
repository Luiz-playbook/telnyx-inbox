-- RUN THIS BY HAND in the Supabase SQL editor. Both statements below were blocked by the
-- agent tooling's guard on destructive SQL (DROP / DELETE), which is working as intended — they
-- are listed here rather than left undone so nothing is lost.
--
-- Everything else in migrations 090-093 is already applied to the production project
-- (snfmggrnyjayuuxafats). After running this, the contact directory picks up HubSpot phone
-- numbers and the test fixtures are gone.
--
-- ORDER MATTERS: run part 1 before part 2 only if you care about the row count being right
-- first time; otherwise either order works, since part 3 rebuilds the snapshot at the end.


-- =============================================================================================
-- PART 1 — remove the six test contacts the agent created while verifying the importer.
--
-- All six are @example.com fixtures from migration 090's acceptance checks. They are NOT in the
-- send audience (uploaded contacts never are, by design), so this is tidiness rather than a
-- correction.
-- =============================================================================================

delete from ticketblaster.imported_contacts
where source_file in ('test-batch-1.csv', 'test-batch-2.csv', 'wrapper-check.csv', 'e2e-test.csv');


-- =============================================================================================
-- PART 2 — rebuild contact_directory so HubSpot phone numbers count toward identity.
--
-- THIS IS THE STEP THAT ACTUALLY CHANGES THE MATCHING, and in the first version of this file it
-- was the only one that was not executable: it said "\i migrations/093...", i.e. a comment. Run
-- top-to-bottom, the file therefore did Parts 1, 3 and 4 and silently skipped this one, leaving
-- the phone columns populated and completely unused (matched_both stayed at exactly 2,404).
-- Inlined below so the file does what it says.
--
-- The two columns are already added by 093; only the matview half is left, because a
-- materialized view has no CREATE OR REPLACE and changing its definition means dropping it.
--
-- WHILE IT IS DROPPED the Contacts tab errors, for roughly the 15-20s the rebuild takes. There
-- is no way around that for a definition change; `refresh ... concurrently` only helps a
-- refresh, not a redefinition.
-- =============================================================================================

drop materialized view if exists public.contact_directory;

create materialized view public.contact_directory as
with hs as (
  select public.sendable_email(email)                       as email_key,
         -- MOBILE FIRST, then the main line. See the note above: the identity this app cares
         -- about is the one that can receive a text.
         public.norm_phone_e164(coalesce(mobilephone, phone)) as phone_e164,
         hs_object_id::text                                  as sid,
         firstname                                           as first_name,
         lastname                                            as last_name,
         email,
         coalesce(mobilephone, phone)                        as phone,
         company,
         state,
         hs_lastmodifieddate                                 as updated_at
  from hubspot.hubspot_contacts
),
ci as (
  select public.sendable_email(c.email)   as email_key,
         public.norm_phone_e164(c.phone)  as phone_e164,
         c.id::text                       as sid,
         c.first_name,
         c.last_name,
         c.email,
         c.phone,
         co.organization_name             as company,
         co.state,
         c.updated_at
  from public.contact_intel c
  left join public.company_intel co on co.id = c.company_intel_id
),
im as (
  select email_key, phone_e164, id::text as sid,
         first_name, last_name, email, phone,
         null::text as company, null::text as state, updated_at
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
  -- HubSpot first now that it has a number to give, matching every other display field here:
  -- it is the record a person maintains, where intel is scraped.
  coalesce(max(phone)      filter (where src = 'hubspot'),
           max(phone)      filter (where src = 'intel'),
           max(phone)      filter (where src = 'imported')) as phone,
  coalesce(max(company)    filter (where src = 'hubspot'),
           max(company)    filter (where src = 'intel'))    as company,
  coalesce(max(state)      filter (where src = 'hubspot'),
           max(state)      filter (where src = 'intel'))    as state,
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
  'One row per person across hubspot_contacts, contact_intel and imported_contacts, merged on sendable_email/norm_phone_e164. Rebuild with refresh_contact_directory(). See migrations 091 and 093.';


-- =============================================================================================
-- PART 3 — repopulate, in this order.
-- =============================================================================================

-- 3a. Backfill the phone numbers themselves. The sync's watermark is max(hs_lastmodifieddate)
--     over the mirror, so adding a column re-reads nothing: only contacts modified from now on
--     would arrive with a number. POST this to the workflow's "Sync now" webhook to re-read from
--     the floor without truncating anything:
--
--       curl -X POST https://playbooksports.app.n8n.cloud/webhook/hubspot-contacts-sync \
--            -H 'content-type: application/json' \
--            -d '{"since":"1970-01-01"}'
--
--     HubSpot's search API refuses to page past 10,000 results per query, so a full re-read
--     takes several runs. Repeat until this stops rising:
--
--       select count(*) filter (where phone is not null or mobilephone is not null) as with_phone,
--              count(*) as total
--       from hubspot.hubspot_contacts;

-- 3b. Re-merge the directory so newly arrived numbers reach the tab. Part 2 already populated
--     it on creation, so this is only needed after further backfill runs -- but it is cheap
--     and it sets contact_directory_state, which is what the tab prints as "rebuilt".
--     Either hit /api/refresh-directory, press "Rebuild directory" in the Contacts tab, or:

select * from public.refresh_contact_directory();

-- 3c. Sanity-check that phones actually improved the match rate. in_hubspot AND in_intel should
--     rise above the 2,404 measured on 2026-10-06, and people with no email can now be keyed.

select count(*)                                              as people,
       count(*) filter (where in_hubspot and in_intel)       as matched_both,
       count(*) filter (where in_hubspot and not in_intel)   as hubspot_only,
       count(*) filter (where phone is not null)             as have_phone
from public.contact_directory;


-- =============================================================================================
-- PART 4 (added 2026-10-06) — remove the two seeded rows used to verify blast_recipients (095).
--
-- Fake Washington numbers written while testing the send log and its retry guard. They are the
-- only rows in the table, since nothing has blasted since the migration landed. Blocked by the
-- same guard on destructive SQL as Part 1.
-- =============================================================================================

delete from ticketblaster.blast_recipients
where queue_id = '11111111-1111-1111-1111-111111111111';

-- Should return 0 afterwards, until the first real blast runs.
select count(*) as blast_recipient_rows from ticketblaster.blast_recipients;
