-- Manual company entries: let the browser (anon) create/edit/delete ONLY rows
-- tagged source='manual'. AI-scraped rows remain read-only from the browser.

drop policy if exists hubspot_company_scrapes_anon_insert on public.hubspot_company_scrapes;
create policy hubspot_company_scrapes_anon_insert
  on public.hubspot_company_scrapes for insert to anon
  with check (source = 'manual');

drop policy if exists hubspot_company_scrapes_anon_update on public.hubspot_company_scrapes;
create policy hubspot_company_scrapes_anon_update
  on public.hubspot_company_scrapes for update to anon
  using (source = 'manual') with check (source = 'manual');

drop policy if exists hubspot_company_scrapes_anon_delete on public.hubspot_company_scrapes;
create policy hubspot_company_scrapes_anon_delete
  on public.hubspot_company_scrapes for delete to anon
  using (source = 'manual');
