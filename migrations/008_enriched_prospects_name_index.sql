-- Index so the Companies list can order/browse 22k+ rows without hitting the
-- statement timeout (a full sort on an unindexed column times out for anon).
create index if not exists idx_enriched_prospects_name
  on public.enriched_prospects (organization_name);
