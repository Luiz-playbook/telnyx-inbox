-- Let the Companies UI (anon key) READ the n8n scraper output.
-- READ-ONLY: no insert/update/delete for anon — writes stay with n8n/service role.
-- SPIKE-ONLY exposure: this table holds sensitive business intelligence and the
-- site has no login yet. Gate behind auth before sharing the URL widely.

drop policy if exists hubspot_company_scrapes_anon_read on public.hubspot_company_scrapes;
create policy hubspot_company_scrapes_anon_read
  on public.hubspot_company_scrapes for select
  to anon using (true);

-- realtime so freshly-scraped companies appear live in the UI
do $$ begin
  alter publication supabase_realtime add table public.hubspot_company_scrapes;
exception when duplicate_object then null; end $$;
