-- Rollback for 123_waitlist_v1.sql. 123 only added, so this only removes what it added.
-- 120's waitlist_board was never touched and needs nothing; the UI falls back to it.
drop function if exists public.waitlist_repliers(uuid);
drop function if exists public.waitlist_alerts();
drop function if exists public.waitlist_board_v2(uuid);
drop function if exists public.miles_between(numeric, numeric, numeric, numeric);
drop table if exists public.waitlist_market_geo;
drop table if exists public.waitlist_settings;
