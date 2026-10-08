-- 090 ROLLBACK: undo migrations/090_offer_strategy.sql completely.
--
-- Run this and the database is byte-for-byte back to where it was before 090: no offers tables,
-- no strategy columns, no indexes, no policies. Nothing else in the schema is touched.
--
-- SAFE TO RUN because 090 only ADDED things. It created two tables and two columns and
-- backfilled those columns; it altered no existing data and dropped nothing. So undoing it is
-- dropping what it made, and no original value has to be restored from anywhere.
--
-- THE ONE THING THIS DESTROYS, said plainly: any rows written into public.offers after 090 was
-- applied. On the day 090 lands that is zero, because nothing writes to it yet. Once the UI half
-- ships and ticket offers are being upserted, this stops being free — those rows are rebuildable
-- from events_master, but they are not backed up anywhere, so re-check before running it then.
--
-- ORDER MATTERS. The strategy columns carry a foreign key to offer_strategies, so the columns go
-- before the table they point at. Dropping the other way round needs a cascade, and a cascade is
-- a blunt instrument to reach for when the correct order is known and short.

-- 1. The columns added to existing tables, and their indexes. Dropping a column takes its
--    indexes and its foreign key with it, so the explicit index drops are belt-and-braces for a
--    partial run that got as far as the indexes but not the columns.
drop index if exists public.idx_campaign_queue_strategy;
drop index if exists public.idx_message_templates_strategy;

alter table public.campaign_queue    drop column if exists strategy;
alter table public.message_templates drop column if exists strategy;

-- 2. The new tables. Their policies, grants and indexes are owned by the tables and go with
--    them, so they need no separate statement.
drop table if exists public.offers;
drop table if exists public.offer_strategies;

-- VERIFY, after running this. All four numbers should come back 0:
--
--   select
--     (select count(*) from information_schema.tables
--       where table_schema='public' and table_name in ('offers','offer_strategies')) as tables_left,
--     (select count(*) from information_schema.columns
--       where table_schema='public' and table_name='campaign_queue' and column_name='strategy') as queue_col_left,
--     (select count(*) from information_schema.columns
--       where table_schema='public' and table_name='message_templates' and column_name='strategy') as tpl_col_left,
--     (select count(*) from pg_indexes where schemaname='public'
--       and indexname in ('idx_campaign_queue_strategy','idx_message_templates_strategy')) as indexes_left;
