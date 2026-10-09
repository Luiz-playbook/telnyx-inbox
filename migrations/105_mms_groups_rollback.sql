-- 105 ROLLBACK: remove the group MMS tables.
--
-- SAFE in the sense that 093 touched nothing that existed before: two new tables, their
-- indexes and policies, and nothing else. Dropping them takes their policies, grants and
-- indexes along.
--
-- WHAT THIS DESTROYS, said plainly: the record of every group thread opened and every
-- message in it. There is no other copy - Telnyx has no group object and its webhooks do
-- not say which thread a message belonged to - so after this nobody can tell who was in a
-- thread or what the agent said in it. Fine for a POC with test threads; re-check before
-- running it once real leads have been in one.
--
-- ORDER: messages reference groups, so messages go first. (The FK is ON DELETE CASCADE, so
-- dropping groups alone would also work; the explicit order is for a partial run.)

drop table if exists public.mms_group_messages;
drop table if exists public.mms_groups;

-- VERIFY, after running this. Should come back 0:
--
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name in ('mms_groups','mms_group_messages');
