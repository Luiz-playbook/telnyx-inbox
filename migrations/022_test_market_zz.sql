-- TEST market: an isolated fake state 'ZZ' = "Test Market" that never mixes with real
-- leads. Lets us test the send pipeline (market_emails('ZZ')) against our own inboxes.
--
-- Company + contacts go in company_intel / contact_intel (the source of truth that
-- refresh_market_contacts rebuilds from). hubspot_synced_at is stamped now() on ALL of
-- them so the external HubSpot sync workflow (other project) treats them as already
-- synced and never pushes this test data. Idempotent — safe to re-run.

-- 1. Lookup rows so ZZ resolves through every state->market path.
insert into public.us_states (code, name)
  select 'ZZ','Test Market' where not exists (select 1 from public.us_states where code='ZZ');
insert into public.state_alias (alias, code)
  select 'ZZ','ZZ' where not exists (select 1 from public.state_alias where alias='ZZ');
insert into public.geo_region (code, name, country)
  select 'ZZ','Test Market','US' where not exists (select 1 from public.geo_region where code='ZZ');
insert into public.geo_alias (alias, code)
  select 'ZZ','ZZ' where not exists (select 1 from public.geo_alias where alias='ZZ');
insert into public.market_state (market_key, state_code)
  select 'test_market','ZZ' where not exists (select 1 from public.market_state where state_code='ZZ');

-- 2. Test company + 3 contacts (hubspot_synced_at set => excluded from external sync).
with existing as (
  select id from public.company_intel where organization_name = 'Playbook Sports Test' limit 1
),
ins_co as (
  insert into public.company_intel
    (organization_name, state, city, domain, source_type, lead_segment, hubspot_synced_at, raw_payload)
  select 'Playbook Sports Test','ZZ','Test City','playbooksports.test','manual','icp', now(), '{}'::jsonb
  where not exists (select 1 from existing)
  returning id
),
co as (select id from ins_co union all select id from existing)
insert into public.contact_intel
  (company_intel_id, first_name, title, email, hubspot_synced_at, raw_payload)
select (select id from co), v.fn, v.title, v.email, now(), '{}'::jsonb
from (values
  ('Vhea','PH AI Developer','vhea@callplaybook.com'),
  ('Luiz','PH AI Developer','john@callplaybook.com'),
  ('Marx','PH AI Manager','mgimutao@callplaybook.com')
) as v(fn, title, email)
where not exists (select 1 from public.contact_intel c where lower(c.email) = lower(v.email));

-- 3. Rebuild market_contacts (+ market_counts) so 'ZZ' becomes sendable.
select public.refresh_market_contacts();
