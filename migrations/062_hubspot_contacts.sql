-- 062 — AI-971 step 1: mirror HubSpot contacts into our own database.
--
-- WHY MIRROR AT ALL. Market History needs to say something about the people a blast reached, and
-- asking HubSpot live would mean one API call per blast — 303 of them to paint one table. Held
-- here, it is a normal SQL join.
--
-- The cost of a mirror is a sync that can quietly stop, which is exactly how Market History sat
-- three months stale under AI-970. Three defences, none optional:
--   * upsert on hs_object_id, so a re-run can never duplicate;
--   * synced_at on every row, so "how current is this?" is answerable from the data;
--   * incremental on hs_lastmodifieddate, so a catch-up run is cheap.
--
-- OWN SCHEMA, NOT EXPOSED. Mirrored third-party data is not this app's own data, and keeping it
-- apart means it can be dropped and rebuilt without touching anything else. `hubspot` is
-- deliberately NOT added to the project's exposed schemas, so PostgREST serves none of it — the
-- n8n sync writes over a direct Postgres connection instead.
--
-- PII. These are the names and email addresses of real people. The schema is granted to
-- service_role only; anon and authenticated have no USAGE on it at all, which is stronger than RLS
-- alone — they cannot reach the table to be filtered in the first place.

create schema if not exists hubspot;

grant usage on schema hubspot to service_role;

create table if not exists hubspot.hubspot_contacts (
  hs_object_id        bigint primary key,
  email               text,
  firstname           text,
  lastname            text,
  company             text,
  state               text,
  lifecyclestage      text,
  hs_lastmodifieddate timestamptz,
  synced_at           timestamptz not null default now()
);

-- Lookups come in two shapes: by id (the recordid CakeMail carries on each list contact) and by
-- address. Half the sampled CakeMail contacts had no recordid at all, so the email path is a
-- fallback that will be used, not a nicety.
create index if not exists hubspot_contacts_email_idx on hubspot.hubspot_contacts (lower(email));
create index if not exists hubspot_contacts_modified_idx on hubspot.hubspot_contacts (hs_lastmodifieddate desc);

alter table hubspot.hubspot_contacts enable row level security;
revoke all on hubspot.hubspot_contacts from anon, authenticated;
grant all on hubspot.hubspot_contacts to service_role;

-- The watermark the sync reads to fetch only what changed, and the same value the UI can show as
-- "synced X ago". Read by the sync over its own connection: select * from hubspot.sync_state()
create or replace function hubspot.sync_state()
returns table (source text, rows bigint, newest_modified timestamptz, last_synced timestamptz)
language sql
stable
security definer
set search_path to 'hubspot'
as $function$
  select 'contacts', count(*), max(hs_lastmodifieddate), max(synced_at) from hubspot.hubspot_contacts;
$function$;

grant execute on function hubspot.sync_state() to service_role;
