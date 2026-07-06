-- Let the Companies UI (anon key) READ enriched_prospects. READ-ONLY.
-- SPIKE-ONLY exposure: ~22k sensitive prospect records become readable by anyone
-- with the site URL. Add auth before sharing the link.

drop policy if exists enriched_prospects_anon_read on public.enriched_prospects;
create policy enriched_prospects_anon_read
  on public.enriched_prospects for select
  to anon using (true);
