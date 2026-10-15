-- Rollback for 122_teammate_strategy.sql. 122 only added, so this only removes what it added.
-- Teammate rows already queued keep strategy = 'teammate'; archive them first if any are pending.
drop function if exists public.teammate_board(text);
drop function if exists public.teammate_sports();
drop function if exists public.market_phones_sport(text, text, text);
drop function if exists public.market_emails_sport(text, text, text);
drop function if exists public.sport_key(text);
drop function if exists public.queue_set_target_sport(uuid, text);
drop table if exists public.queue_target_sport;
delete from public.offer_strategies where code = 'teammate';
