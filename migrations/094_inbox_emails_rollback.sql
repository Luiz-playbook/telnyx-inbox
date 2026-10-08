-- 094 ROLLBACK: remove the imported-mailbox table.
--
-- SAFE in that 094 added one table and nothing else. Its policies, grants and indexes go
-- with it.
--
-- WHAT THIS DESTROYS: every imported email and its classification. They are rebuildable -
-- the next daily sync over the same window re-imports them from Gmail, which remains the
-- source of truth - so this is a reset, not a loss. read_at marks would not come back.

drop table if exists public.inbox_emails;

-- VERIFY, after running this. Should come back 0:
--
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name='inbox_emails';
