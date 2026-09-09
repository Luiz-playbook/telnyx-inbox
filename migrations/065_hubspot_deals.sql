-- 065 — AI-971 step 3: mirror HubSpot deals, and resolve "the deal for this contact".
--
-- Run 064 first; this migration extends hubspot.sync_state() to cover all three objects and the
-- resolver below reads hubspot.hubspot_companies.
--
-- WHY NOT public.deals_hubspot. Measured against the live portal (4313631) on 2026-09-09:
--
--     deals in HubSpot                                20,863
--     deals in public.deals_hubspot                      930
--     ...of which pipeline "Playbook NW Software"        926   (HubSpot has 12,350 in it)
--     ...lifecycle Onboarding 725 / Active Client 200
--
-- It is a won-clients table. Resolving "the latest deal on this contact" against it returns nothing
-- for the large majority of contacts, and — worse — returns an ANSWER for some of them that is not
-- the latest deal, just the latest one that happens to have been won. A resolver cannot tell those
-- two cases apart, so it would be confidently wrong rather than empty.
--
-- Its timestamps cannot rank deals either: "updatedAt" is null on 540 of its 930 rows, and null on
-- deal 31656107070 (Finesse Soccer), which HubSpot reports as modified 2026-09-09T10:06. Whatever
-- that column means, it is not the HubSpot modified date.
--
-- public.deals_hubspot stays untouched and is still the right place to read the rich fields —
-- contract_information, cs_deal_info, bda_ae_deal_evaluation_metrics, deal_csr. Once this table has
-- picked the deal, join hs_object_id::text to its "dealId" for those. Its id columns are text, so
-- the cast is on our side. If the row is missing there we still hold the correct deal id and simply
-- have no detail — which is the failure we want, rather than the wrong deal with full detail.
--
-- ASSOCIATIONS ON THE DEAL, for the reason set out in 064: 20,863 deals means ~209 batch
-- association calls where the contact side would be ~11,167, and it leaves hubspot.hubspot_contacts
-- untouched. Both edges fan out for real — 2,330 contacts have more than one deal (the heaviest,
-- 53284377, has 25) and 1,328 companies have more than one deal — so both are arrays and the
-- resolver reduces rather than assuming.

create schema if not exists hubspot;
grant usage on schema hubspot to service_role;

create table if not exists hubspot.hubspot_deals (
  hs_object_id           bigint primary key,
  dealname               text,
  pipeline               text,
  dealstage              text,
  amount                 numeric,
  closedate              timestamptz,
  associated_contact_ids bigint[] not null default '{}',
  associated_company_ids bigint[] not null default '{}',
  hs_lastmodifieddate    timestamptz,
  synced_at              timestamptz not null default now()
);

-- The sort key for "latest". Unlike public.deals_hubspot."updatedAt" this is HubSpot's own
-- hs_lastmodifieddate, copied verbatim by the sync.
create index if not exists hubspot_deals_modified_idx
  on hubspot.hubspot_deals (hs_lastmodifieddate desc);

create index if not exists hubspot_deals_contacts_idx
  on hubspot.hubspot_deals using gin (associated_contact_ids);
create index if not exists hubspot_deals_companies_idx
  on hubspot.hubspot_deals using gin (associated_company_ids);

alter table hubspot.hubspot_deals enable row level security;
revoke all on hubspot.hubspot_deals from anon, authenticated;
grant all on hubspot.hubspot_deals to service_role;

-- ------------------------------------------------------------------------------------------------
-- The watermark the sync reads. 062 returned a single hard-coded 'contacts' row; the sync's own code
-- node already keys its state by `source`, so adding rows here is backwards compatible and the
-- contacts workflow keeps working unchanged.
--
-- One row per object even when the table is empty, because the sync needs to see 'deals' with a null
-- watermark on the first run in order to know it should start from the epoch. A missing row would
-- read as "no such source" rather than "nothing synced yet".
-- ------------------------------------------------------------------------------------------------
create or replace function hubspot.sync_state()
returns table (source text, rows bigint, newest_modified timestamptz, last_synced timestamptz)
language sql
stable
security definer
set search_path to 'hubspot'
as $function$
  select 'contacts',  count(*), max(hs_lastmodifieddate), max(synced_at) from hubspot.hubspot_contacts
  union all
  select 'companies', count(*), max(hs_lastmodifieddate), max(synced_at) from hubspot.hubspot_companies
  union all
  select 'deals',     count(*), max(hs_lastmodifieddate), max(synced_at) from hubspot.hubspot_deals
$function$;

grant execute on function hubspot.sync_state() to service_role;

-- ------------------------------------------------------------------------------------------------
-- THE RESOLVER. Same shape and same reasoning as public.hubspot_ids_for_emails (063): `hubspot` is
-- not an exposed schema, so this narrow, batched function is the only question the app may ask.
--
-- The chain, as specified: the contact's OWN deals first, newest modified wins; if the contact has
-- none, fall back to the deals of the contact's companies, newest modified wins. `deal_via` says
-- which branch answered, because "this person's deal" and "someone at this person's club has a
-- deal" are different claims and the UI must not present them identically.
--
-- Ties break on hs_object_id so the answer is stable between calls — with 540-odd deals carrying no
-- usable timestamp anywhere in this portal's history, ties are not hypothetical, and a resolver that
-- returned a different deal on each refresh would be worse than one that returned none.
-- ------------------------------------------------------------------------------------------------
create or replace function public.hubspot_deal_for_emails(p_emails text[])
returns table (
  email        text,
  hs_object_id bigint,
  company_ids  bigint[],
  deal_id      bigint,
  deal_via     text
)
language sql
stable
security definer
set search_path to 'public', 'hubspot'
as $function$
  with c as (
    -- Lower-cased both sides, as in 063: CakeMail stores what the contact typed.
    select distinct lower(e) as email, hc.hs_object_id
      from unnest(p_emails) as e
      join hubspot.hubspot_contacts hc on lower(hc.email) = lower(e)
  ),
  comp as (
    select c.email, array_agg(distinct co.hs_object_id) as company_ids
      from c
      join hubspot.hubspot_companies co on co.associated_contact_ids @> array[c.hs_object_id]
     group by c.email
  ),
  own as (
    select c.email, d.hs_object_id as deal_id,
           row_number() over (partition by c.email
                              order by d.hs_lastmodifieddate desc nulls last, d.hs_object_id desc) as rn
      from c
      join hubspot.hubspot_deals d on d.associated_contact_ids @> array[c.hs_object_id]
  ),
  via_company as (
    select comp.email, d.hs_object_id as deal_id,
           row_number() over (partition by comp.email
                              order by d.hs_lastmodifieddate desc nulls last, d.hs_object_id desc) as rn
      from comp
      join hubspot.hubspot_deals d on d.associated_company_ids && comp.company_ids
  )
  select c.email,
         c.hs_object_id,
         coalesce(comp.company_ids, '{}'::bigint[]),
         coalesce(o.deal_id, v.deal_id),
         case when o.deal_id is not null then 'contact'
              when v.deal_id is not null then 'company'
              else null end
    from c
    left join comp        on comp.email = c.email
    left join own o       on o.email = c.email and o.rn = 1
    left join via_company v on v.email = c.email and v.rn = 1
$function$;

grant execute on function public.hubspot_deal_for_emails(text[]) to service_role;
