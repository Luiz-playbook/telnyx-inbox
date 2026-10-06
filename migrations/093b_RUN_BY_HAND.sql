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
-- The two columns (hubspot.hubspot_contacts.phone / .mobilephone) are already added. This is the
-- matview half of migration 093, which could not be applied because a materialized view has no
-- CREATE OR REPLACE — changing its definition means dropping it.
--
-- The full statement with its reasoning is in migrations/093_hubspot_contact_phones.sql. Run
-- that file from the line `drop materialized view if exists public.contact_directory;` to the
-- end, or paste it wholesale — the ALTER TABLEs above it are idempotent (`add column if not
-- exists`) so re-running the whole file is safe.
--
-- WHILE IT IS DROPPED the Contacts tab errors, for roughly the 15-20s the rebuild takes. There
-- is no way around that for a definition change; a concurrent refresh only helps for a refresh.
-- =============================================================================================

-- \i migrations/093_hubspot_contact_phones.sql
-- (or paste that file's contents here)


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

-- 3b. Then re-merge the directory so the new numbers reach the tab. Either hit the cron route
--     (/api/refresh-directory), press "Rebuild directory" in the Contacts tab, or:

select * from public.refresh_contact_directory();

-- 3c. Sanity-check that phones actually improved the match rate. in_hubspot AND in_intel should
--     rise above the 2,404 measured on 2026-10-06, and people with no email can now be keyed.

select count(*)                                              as people,
       count(*) filter (where in_hubspot and in_intel)       as matched_both,
       count(*) filter (where in_hubspot and not in_intel)   as hubspot_only,
       count(*) filter (where phone is not null)             as have_phone
from public.contact_directory;
