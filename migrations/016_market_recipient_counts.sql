-- Market -> recipient-count lookup for the Trigger Blast button.
--
-- The decider gives a market_key (metro, e.g. 'cincinnati'); recipients live by state
-- code. This resolves market_key -> market_state.state_code -> market_counts, exposing
-- phone/email reach in one anon-callable call (market_state has RLS with no anon policy,
-- so a SECURITY DEFINER wrapper is required).

create or replace function public.market_recipient_counts()
returns table(market_key text, state_code text, phone_count bigint, email_count bigint)
language sql
stable security definer
set search_path to 'public'
as $function$
  select ms.market_key, ms.state_code,
         coalesce(mc.phone_count, 0), coalesce(mc.email_count, 0)
  from market_state ms
  left join market_counts mc on mc.code = ms.state_code;
$function$;

grant execute on function public.market_recipient_counts() to anon, authenticated, service_role;
