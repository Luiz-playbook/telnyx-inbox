-- Two more recipients on the ZZ test market: cole@ and josh@callplaybook.com.
--
-- Both already appear in the Queue's "Send from" list (CakeMail account 1679383), but a
-- sender is not a recipient — neither address existed anywhere in contact_intel, so neither
-- of them has ever actually received a test blast. They join the same test company migration
-- 022 created, which takes ZZ from 3 unique recipients to 5.
--
-- hubspot_synced_at is stamped now() exactly as in 022, so the external HubSpot sync treats
-- these as already synced and never pushes them. Idempotent — safe to re-run.

insert into public.contact_intel
  (company_intel_id, first_name, title, email, hubspot_synced_at, raw_payload)
select c.id, v.fn, v.title, v.email, now(), '{}'::jsonb
from (select id from public.company_intel where organization_name = 'Playbook Sports Test' limit 1) c
cross join (values
  ('Cole', 'Test Recipient', 'cole@callplaybook.com'),
  ('Josh', 'Test Recipient', 'josh@callplaybook.com')
) as v(fn, title, email)
where not exists (
  select 1 from public.contact_intel ci where lower(ci.email) = lower(v.email)
);

-- Rebuild market_contacts (+ market_counts) so the new addresses are actually sendable.
select public.refresh_market_contacts();
