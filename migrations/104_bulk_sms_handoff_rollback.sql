-- 104 ROLLBACK: remove the two bulk-sender columns from campaign_queue.
--
-- SAFE: 092 only added two nullable columns and one partial index. No existing value was
-- changed, so undoing it is dropping what it made. Dropping a column takes its index and its
-- comment with it; the explicit index drop is belt-and-braces for a partial run.
--
-- WHAT THIS DESTROYS, said plainly: the link between any queue row and the bulk-sender
-- campaign it became. The campaign itself lives in the other app and is untouched, but
-- nothing here will be able to find it afterwards. On the day 092 lands that is zero rows.

drop index if exists public.idx_campaign_queue_bulk_campaign;

alter table public.campaign_queue
  drop column if exists bulk_campaign_id,
  drop column if exists bulk_census;

-- VERIFY, after running this. Both should come back 0:
--
--   select
--     (select count(*) from information_schema.columns
--       where table_schema='public' and table_name='campaign_queue'
--       and column_name in ('bulk_campaign_id','bulk_census')) as columns_left,
--     (select count(*) from pg_indexes where schemaname='public'
--       and indexname='idx_campaign_queue_bulk_campaign') as indexes_left;
