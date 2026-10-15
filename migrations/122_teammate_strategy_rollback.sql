-- Rollback for 122_teammate_strategy.sql.
-- Teammate rows already queued keep strategy = 'teammate' and their target_sport is dropped;
-- archive or re-tag them first if any are still pending.
drop function if exists public.teammate_board(text);
drop function if exists public.teammate_sports();
drop function if exists public.market_phones_sport(text, text, text);
drop function if exists public.market_emails_sport(text, text, text);
drop function if exists public.sport_key(text);
alter table public.campaign_queue drop column if exists target_sport;
update public.message_templates set strategy = 'ticket_blasts' where slug in ('teammate-email', 'teammate-sms');
update public.offer_strategies set active = false where code = 'teammate';
