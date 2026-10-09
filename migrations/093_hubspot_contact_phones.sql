-- 093 — mirror HubSpot's phone numbers, and let the directory match on them.
--
-- WHY. hubspot.hubspot_contacts (062) stored no phone at all, which cost two things:
--
--   1. MATCHING. contact_directory (091) merges people on sendable_email, falling back to
--      norm_phone_e164. With no phone column a HubSpot contact could only ever be matched by
--      address, so the 5,980 HubSpot contacts holding no email matched nothing and could not
--      even be keyed — they were dropped from the directory entirely. A phone gives them an
--      identity and a chance of merging with the intel row for the same person.
--
--   2. THE OBVIOUS ONE. This application sends SMS. A contact record in the tab that showed no
--      number for someone HubSpot has a number for is a contact record that cannot answer the
--      question it is open to answer.
--
-- TWO COLUMNS, BECAUSE HUBSPOT HAS TWO FIELDS. `phone` is the main number — often a switchboard
-- or an office line — and `mobilephone` is the handset. They are different facts about a person
-- and collapsing them on the way in would throw away the distinction permanently, so both are
-- stored and the choice is made at the point of use.
--
-- MOBILE WINS WHERE ONE HAS TO BE PICKED, which is the directory below. A blast from this app is
-- a text message: a mobile is reachable and a main line is not, so the number that represents
-- the person for SMS is the mobile where there is one. `phone` is the fallback, not the default.
--
-- EXISTING ROWS STAY EMPTY UNTIL A BACKFILL. The sync's watermark is max(hs_lastmodifieddate)
-- over the mirror itself, so adding a column does not re-read anything already stored — only
-- contacts modified from now on would arrive with a number. The workflow already has the way
-- out, built for exactly this case: POST {"since":"1970-01-01"} to its "Sync now" webhook
-- re-reads from the floor without truncating the table. Run that after deploying, and note that
-- HubSpot's search API refuses to page past 10,000 results per query, so a full re-read takes
-- several runs.

alter table hubspot.hubspot_contacts add column if not exists phone       text;
alter table hubspot.hubspot_contacts add column if not exists mobilephone text;

-- Matching in contact_detail is by normalised number, so the raw columns are not directly
-- useful as index keys. These support the "does HubSpot hold this number" lookup the panel does.
create index if not exists hubspot_contacts_phone_idx  on hubspot.hubspot_contacts (phone)       where phone is not null;
create index if not exists hubspot_contacts_mobile_idx on hubspot.hubspot_contacts (mobilephone) where mobilephone is not null;

comment on column hubspot.hubspot_contacts.phone is
  'HubSpot `phone` — usually a main or office line. See migration 093.';
comment on column hubspot.hubspot_contacts.mobilephone is
  'HubSpot `mobilephone` — the handset. Preferred over `phone` wherever one number must represent the person, because this app sends SMS. See migration 093.';


-- ---------------------------------------------------------------------------------------------
-- REBUILD contact_directory SO THE NEW COLUMNS ACTUALLY DO SOMETHING.
--
-- A materialized view has no CREATE OR REPLACE, so changing its definition means dropping it.
-- Dropping takes the indexes with it, hence the full recreation below rather than an ALTER —
-- and contact_directory_key_idx in particular is load-bearing: without a unique index
-- `refresh ... concurrently` is not allowed, and a non-concurrent refresh locks the view for
-- everyone reading the tab while it rebuilds.
--
-- The only change to the SELECT is the hubspot branch: phone_e164 stops being a hardcoded null.
-- Everything else is migration 091 verbatim.
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
