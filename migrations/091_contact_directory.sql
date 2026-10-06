-- 091 — one row per PERSON across three contact sources that disagree with each other.
--
-- THE PROBLEM THIS SOLVES. There are three contact stores and they are nearly disjoint:
--   public.contact_intel            264,245 rows  (scraped; this IS the send audience)
--   hubspot.hubspot_contacts         86,377 rows  (mirrored every 6h; enrichment only)
--   ticketblaster.imported_contacts       new     (uploaded by hand, migration 090)
-- Measured 2026-10-06: of 132,741 distinct intel addresses and 80,397 HubSpot addresses, only
-- 2,404 appear in both. 77,993 HubSpot contacts are in no sendable audience at all.
--
-- A tab that merely FILTERED by source would therefore list those 2,404 people twice with
-- nothing to say they are one person, and -- worse -- would make the real finding invisible.
-- The gap between the two lists is the thing Josh asked about ("lists should match HubSpot one
-- to one and be exhaustive"), so it has to be a number on the screen, not an inference.
--
-- IDENTITY IS THE SEND PATH'S IDENTITY. The merge key is sendable_email(email), falling back to
-- norm_phone_e164(phone) -- the SAME functions suppress_contacts and the send path use.
-- Matching on anything else would group people differently from the way they are actually
-- deduped when a blast goes out, so the tab would disagree with the send it describes.
--
-- WHY EMAIL FIRST, AND WHAT THAT COSTS. hubspot.hubspot_contacts HAS NO PHONE COLUMN, so a
-- HubSpot contact can only ever be matched by address; 5,980 of them have no address either and
-- cannot be matched at all. Those are not dropped -- they appear as HubSpot-only rows, which is
-- the honest answer. A phone-only intel row likewise never merges with HubSpot. The tab says
-- "matched on email address" rather than implying a confidence it does not have.
--
-- A MATERIALIZED VIEW, AND THEREFORE A STALENESS PROBLEM. Merging 350k rows across three
-- schemas on every keystroke is not a query anyone can type behind a search box. The cost is
-- the failure migration 062 warns about: a snapshot that quietly stops refreshing. Two
-- defences, both load-bearing -- contact_directory_state records when it was last built, and
-- the Contacts tab SHOWS that timestamp beside the counts. A stale directory is visible rather
-- than merely wrong.

create materialized view if not exists public.contact_directory as
with hs as (
  select public.sendable_email(email)  as email_key,
         null::text                    as phone_e164,
         hs_object_id::text            as sid,
         firstname                     as first_name,
         lastname                      as last_name,
         email,
         null::text                    as phone,
         company,
         state,
         hs_lastmodifieddate           as updated_at
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
  select email_key,
         phone_e164,
         id::text        as sid,
         first_name,
         last_name,
         email,
         phone,
         null::text      as company,
         null::text      as state,
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
  -- A row with neither a usable address nor a usable number identifies nobody. Dropped here
  -- rather than grouped under an empty key, which would merge every such row into one nonsense
  -- person.
  select coalesce(email_key, phone_e164) as identity_key, *
  from unioned
  where coalesce(email_key, phone_e164) is not null
)
select
  identity_key,
  bool_or(src = 'hubspot')  as in_hubspot,
  bool_or(src = 'intel')    as in_intel,
  bool_or(src = 'imported') as in_imported,

  -- The row id in each source, so the detail modal can open any of them from one directory row.
  max(sid) filter (where src = 'hubspot')  as hubspot_id,
  max(sid) filter (where src = 'intel')    as intel_id,
  max(sid) filter (where src = 'imported') as imported_id,

  -- DISPLAY FIELDS PREFER HUBSPOT, THEN INTEL, THEN THE UPLOAD. Not arbitrary: HubSpot is the
  -- record a human maintains, intel is scraped, and an upload is a one-off. Where HubSpot has no
  -- value the next source fills it, so the row shows the most trustworthy value available
  -- rather than the value from whichever table happened to sort first.
  coalesce(max(first_name) filter (where src = 'hubspot'),
           max(first_name) filter (where src = 'intel'),
           max(first_name) filter (where src = 'imported')) as first_name,
  coalesce(max(last_name)  filter (where src = 'hubspot'),
           max(last_name)  filter (where src = 'intel'),
           max(last_name)  filter (where src = 'imported')) as last_name,
  coalesce(max(email)      filter (where src = 'hubspot'),
           max(email)      filter (where src = 'intel'),
           max(email)      filter (where src = 'imported')) as email,
  -- Phone prefers the sources that actually have one; HubSpot's column does not exist.
  coalesce(max(phone)      filter (where src = 'intel'),
           max(phone)      filter (where src = 'imported')) as phone,
  coalesce(max(company)    filter (where src = 'hubspot'),
           max(company)    filter (where src = 'intel'))    as company,
  coalesce(max(state)      filter (where src = 'hubspot'),
           max(state)      filter (where src = 'intel'))    as state,

  max(updated_at) as updated_at,

  -- Precomputed so the search box filters on an indexed expression instead of concatenating
  -- five columns per row, per keystroke, over 350k rows.
  lower(concat_ws(' ',
    coalesce(max(first_name) filter (where src = 'hubspot'), max(first_name) filter (where src = 'intel'), max(first_name) filter (where src = 'imported')),
    coalesce(max(last_name)  filter (where src = 'hubspot'), max(last_name)  filter (where src = 'intel'), max(last_name)  filter (where src = 'imported')),
    coalesce(max(email)      filter (where src = 'hubspot'), max(email)      filter (where src = 'intel'), max(email)      filter (where src = 'imported')),
    coalesce(max(phone)      filter (where src = 'intel'),   max(phone)      filter (where src = 'imported')),
    coalesce(max(company)    filter (where src = 'hubspot'), max(company)    filter (where src = 'intel'))
  )) as search_text
from keyed
group by identity_key;

-- REQUIRED, not an optimisation: `refresh materialized view concurrently` needs a unique index,
-- and without CONCURRENTLY a refresh takes an exclusive lock that makes the tab error for
-- everyone looking at it while it rebuilds.
create unique index if not exists contact_directory_key_idx      on public.contact_directory (identity_key);
create index        if not exists contact_directory_search_idx   on public.contact_directory using gin (search_text gin_trgm_ops);
create index        if not exists contact_directory_state_idx    on public.contact_directory (state);
create index        if not exists contact_directory_presence_idx on public.contact_directory (in_hubspot, in_intel, in_imported);

revoke all on public.contact_directory from anon, authenticated;
grant select on public.contact_directory to service_role;

comment on materialized view public.contact_directory is
  'One row per person across hubspot_contacts, contact_intel and imported_contacts, merged on sendable_email/norm_phone_e164. Rebuild with refresh_contact_directory(). See migration 091.';


-- ---------------------------------------------------------------------------------------------
-- WHEN WAS THIS LAST TRUE? A matview carries no build timestamp of its own, and "the directory
-- is three weeks stale" is indistinguishable from "nobody has been added in three weeks" unless
-- something records it. One row, overwritten on every refresh.
create table if not exists public.contact_directory_state (
  id           boolean primary key default true constraint contact_directory_state_one_row check (id),
  refreshed_at timestamptz not null default now(),
  row_count    bigint,
  ms           integer
);

insert into public.contact_directory_state (id) values (true) on conflict (id) do nothing;

revoke all on public.contact_directory_state from anon, authenticated;
grant select on public.contact_directory_state to service_role;


-- ---------------------------------------------------------------------------------------------
-- refresh_contact_directory() -> (row_count, ms)
--
-- CONCURRENTLY so the tab keeps serving the previous snapshot while this runs. The first build
-- cannot be concurrent (there is nothing to serve yet), which is why the fallback exists rather
-- than being a bug waiting for the first deploy.
create or replace function public.refresh_contact_directory()
returns table (row_count bigint, ms integer)
language plpgsql
security definer
set search_path = public, hubspot, ticketblaster, pg_temp
as $fn$
declare
  v_started timestamptz := clock_timestamp();
  v_rows    bigint;
  v_ms      integer;
begin
  begin
    refresh materialized view concurrently public.contact_directory;
  exception when object_not_in_prerequisite_state then
    -- "materialized view has not been populated" -- only ever the very first run.
    refresh materialized view public.contact_directory;
  end;

  select count(*) into v_rows from public.contact_directory;
  v_ms := (extract(epoch from (clock_timestamp() - v_started)) * 1000)::integer;

  update public.contact_directory_state
     set refreshed_at = now(), row_count = v_rows, ms = v_ms
   where id;

  return query select v_rows, v_ms;
end;
$fn$;

revoke all on function public.refresh_contact_directory() from public, anon, authenticated;
grant execute on function public.refresh_contact_directory() to service_role;
