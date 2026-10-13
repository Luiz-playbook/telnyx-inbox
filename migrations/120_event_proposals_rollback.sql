-- 120 ROLLBACK: remove the Event Waitlist board and put the blast-log function back.
-- Proposals, their markets and signups are DELETED — export first if any matter.

drop function if exists public.waitlist_board(uuid);
drop function if exists public.proposal_step_sent(uuid);
drop function if exists public.proposal_market_confirm(uuid, jsonb);
drop function if exists public.proposal_signup_remove(uuid);
drop function if exists public.proposal_signup_add(uuid, text, text, text, text, text, text);
drop function if exists public.proposal_set_markets(uuid, text[]);
drop function if exists public.proposal_update(uuid, jsonb);
drop function if exists public.proposal_create(jsonb);

alter table public.campaign_queue drop column if exists proposal_step;
alter table public.campaign_queue drop column if exists proposal_id;

drop table if exists public.proposal_signups;
drop table if exists public.proposal_markets;
drop table if exists public.event_proposals;
drop table if exists public.waitlist_markets;

drop function if exists public.log_market_blast(text, text, text, uuid, text, text);
create or replace function public.log_market_blast(
  p_code text, p_name text, p_channel text, p_queue_id uuid default null, p_segment text default null
) returns bigint
language sql security definer set search_path = public as $$
  insert into public.market_blast_log (market_code, market_name, channel, campaign_queue_id, segment)
  values (upper(btrim(p_code)), p_name, p_channel, p_queue_id, nullif(btrim(coalesce(p_segment, '')), ''))
  returning id;
$$;
drop index if exists public.market_blast_log_code_strategy_idx;
alter table public.market_blast_log drop column if exists strategy;

update public.offer_strategies set active = true where code = 'suites';
