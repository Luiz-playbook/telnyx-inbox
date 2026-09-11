-- 066 — AI-971: resolve the deal the way Vhea specified, and return the company with it.
--
-- 065 got the fallback wrong. It took the newest deal across ALL of the contact's companies. The
-- rule is: the contact's LATEST MODIFIED COMPANY, and then THAT COMPANY'S latest modified deal.
--
-- Those differ whenever a contact sits on more than one company, which is not rare — contact
-- 53284377 is on four. Say company A was touched yesterday and its newest deal is from 2024, while
-- company B was touched last year and has a deal from this morning. The old query returned B's
-- deal because it was the newest deal anywhere. The rule says A's, because A is the live
-- relationship and the question being answered is "what is this person's current account", not
-- "what is the most recently edited deal that happens to be reachable from them".
--
-- THE COMPANY IS ALSO RETURNED NOW. It is reference data, not the answer — the UI shows the deal
-- and keeps the company as the quieter line under it — but it has to travel with the deal or the
-- caller has to make a second round trip to name the account the deal belongs to.
--
-- Ties break on hs_object_id in both stages, so the answer is stable between calls. That is not
-- hypothetical: 540 of the 930 rows in public.deals_hubspot carry no usable timestamp at all, and
-- a resolver that returned a different deal on each refresh would be worse than one returning none.

-- DROPPED, NOT REPLACED. 065 returned (email, hs_object_id, company_ids, deal_id, deal_via);
-- this adds company_id, and Postgres refuses to change the OUT columns of an existing function:
--   42P13: cannot change return type of existing function
-- Both are dropped first so a re-run is clean either way. hubspot_deals_for_emails goes first
-- because it calls the other — the body is a quoted string so Postgres tracks no dependency
-- between them, but dropping the caller first is the order that stays correct if that ever
-- changes.
--
-- Safe to drop: both are read-only helpers, called from api/market-history.js and the n8n lookup
-- over the service role. Nothing stores state in them, and they are recreated below in the same
-- transaction.
drop function if exists public.hubspot_deals_for_emails(text[]);
drop function if exists public.hubspot_deal_for_emails(text[]);

create function public.hubspot_deal_for_emails(p_emails text[])
returns table (
  email        text,
  hs_object_id bigint,
  company_ids  bigint[],
  company_id   bigint,
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
  -- Every company on the contact, kept for reference, plus which one is the latest.
  comp as (
    select c.email, co.hs_object_id as company_id, co.hs_lastmodifieddate,
           row_number() over (partition by c.email
                              order by co.hs_lastmodifieddate desc nulls last, co.hs_object_id desc) as rn
      from c
      join hubspot.hubspot_companies co on co.associated_contact_ids @> array[c.hs_object_id]
  ),
  comp_all as (
    select email, array_agg(company_id order by hs_lastmodifieddate desc nulls last) as company_ids
      from comp group by email
  ),
  -- STAGE ONE: the contact's own deals. Newest modified wins.
  own as (
    select c.email, d.hs_object_id as deal_id,
           row_number() over (partition by c.email
                              order by d.hs_lastmodifieddate desc nulls last, d.hs_object_id desc) as rn
      from c
      join hubspot.hubspot_deals d on d.associated_contact_ids @> array[c.hs_object_id]
  ),
  -- STAGE TWO: only the LATEST company (comp.rn = 1), and only ITS deals. Joining against the
  -- whole company_ids array here is exactly the bug this migration fixes.
  via_company as (
    select comp.email, comp.company_id, d.hs_object_id as deal_id,
           row_number() over (partition by comp.email
                              order by d.hs_lastmodifieddate desc nulls last, d.hs_object_id desc) as rn
      from comp
      join hubspot.hubspot_deals d on d.associated_company_ids @> array[comp.company_id]
     where comp.rn = 1
  )
  select c.email,
         c.hs_object_id,
         coalesce(ca.company_ids, '{}'::bigint[]),
         -- The latest company is named whether or not it produced the deal: when the deal came
         -- from the contact directly, this is still the account they belong to.
         (select company_id from comp where comp.email = c.email and comp.rn = 1),
         coalesce(o.deal_id, v.deal_id),
         case when o.deal_id is not null then 'contact'
              when v.deal_id is not null then 'company'
              else null end
    from c
    left join comp_all ca   on ca.email = c.email
    left join own o         on o.email = c.email and o.rn = 1
    left join via_company v on v.email = c.email and v.rn = 1
$function$;

grant execute on function public.hubspot_deal_for_emails(text[]) to service_role;

-- ------------------------------------------------------------------------------------------------
-- The batched read the Recipients tab actually calls. Same question as above, but it also returns
-- the deal and company DETAIL, so painting a page of 100 recipients is one round trip rather than
-- one per person plus a second pass to name each deal.
--
-- Kept separate from hubspot_deal_for_emails rather than widening it: that one answers "which
-- deal", is called by the n8n lookup, and should stay narrow. This one is for the screen.
-- ------------------------------------------------------------------------------------------------
create function public.hubspot_deals_for_emails(p_emails text[])
returns table (
  email          text,
  hs_object_id   bigint,
  deal_via       text,
  deal_id        bigint,
  deal_name      text,
  deal_stage     text,
  deal_pipeline  text,
  deal_amount    numeric,
  deal_closedate timestamptz,
  deal_modified  timestamptz,
  company_id     bigint,
  company_name   text,
  company_count  int
)
language sql
stable
security definer
set search_path to 'public', 'hubspot'
as $function$
  select r.email,
         r.hs_object_id,
         r.deal_via,
         r.deal_id,
         d.dealname,
         d.dealstage,
         d.pipeline,
         d.amount,
         d.closedate,
         d.hs_lastmodifieddate,
         r.company_id,
         co.name,
         coalesce(array_length(r.company_ids, 1), 0)
    from public.hubspot_deal_for_emails(p_emails) r
    left join hubspot.hubspot_deals d      on d.hs_object_id = r.deal_id
    left join hubspot.hubspot_companies co on co.hs_object_id = r.company_id
$function$;

grant execute on function public.hubspot_deals_for_emails(text[]) to service_role;
