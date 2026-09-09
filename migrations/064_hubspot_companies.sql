-- 064 — AI-971 step 2: mirror HubSpot companies into our own schema.
--
-- WHY NOT public.clients_hubspot. That table already holds companies, and we deliberately do not
-- read it for this. Three reasons, all measured against the live portal (4313631) on 2026-09-09:
--
--   * WE DO NOT OWN IT. Something else writes it on its own schedule with its own filter. If that
--     filter changes, our deal resolution changes with it and says nothing.
--   * IT IS A CLIENT LIST, NOT A COMPANY MIRROR. Its sibling public.deals_hubspot holds 930 rows
--     against 20,863 deals in HubSpot — 926 of them one pipeline ("Playbook NW Software", where
--     HubSpot itself has 12,350) and all of them lifecycle Onboarding or Active Client. It answers
--     "which of our clients is this", not "what is this company".
--   * IT IS IN public. public is exposed to PostgREST under RLS; `hubspot` is not exposed at all.
--     These rows carry association arrays pointing at contact PII, so they belong behind the same
--     wall as hubspot.hubspot_contacts (062).
--
-- public.clients_hubspot stays exactly as it is and is still worth reading — join hs_object_id::text
-- to its "companyId" for the CSM, the Jira label, the Heroku domain. We enrich from it. We never
-- write it.
--
-- THE ASSOCIATIONS LIVE HERE, NOT ON THE CONTACT. A contact-to-company link is one fact and it can
-- be stored on either end. Storing it on the company is ~50x cheaper to sync:
--
--     companies   205,769  ->  ~2,058 batch association calls
--     contacts  1,116,689  ->  ~11,167
--
-- and `associated_contact_ids @> array[<id>]` over a GIN index answers "companies for this contact"
-- just as directly. The practical win: hubspot.hubspot_contacts needs no migration at all, so the
-- contacts sync that is already running is untouched.
--
-- The cardinality is real, not theoretical — contact 53284377 (John Guevara) is associated with four
-- companies: NJ Ravens FC, New Jersey Santos Rush, Lasker Rink and First Shot Soccer. Anything that
-- assumed one company per contact would have silently seen one of his four. Note in particular that
-- HubSpot's own `associatedcompanyid` property on a contact is the PRIMARY company only, which is
-- exactly that mistake with an official-looking name on it.

create schema if not exists hubspot;
grant usage on schema hubspot to service_role;

create table if not exists hubspot.hubspot_companies (
  hs_object_id           bigint primary key,
  name                   text,
  domain                 text,
  state                  text,
  lifecyclestage         text,
  -- Every contact HubSpot reports as associated with this company, primary or not.
  associated_contact_ids bigint[] not null default '{}',
  hs_lastmodifieddate    timestamptz,
  synced_at              timestamptz not null default now()
);

-- The watermark the incremental sync reads back.
create index if not exists hubspot_companies_modified_idx
  on hubspot.hubspot_companies (hs_lastmodifieddate desc);

-- The hot path: "which companies is this contact on?". GIN, because the question is containment
-- over an array and a btree cannot answer it.
create index if not exists hubspot_companies_contacts_idx
  on hubspot.hubspot_companies using gin (associated_contact_ids);

-- Enrichment joins against public.clients_hubspot go through the domain when the id is absent
-- there, and its "companyId" is text — so the id side of that join is cast, not this index.
create index if not exists hubspot_companies_domain_idx
  on hubspot.hubspot_companies (lower(domain));

alter table hubspot.hubspot_companies enable row level security;
revoke all on hubspot.hubspot_companies from anon, authenticated;
grant all on hubspot.hubspot_companies to service_role;
