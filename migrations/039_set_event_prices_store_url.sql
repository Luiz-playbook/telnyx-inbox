-- Store the listing URL a price came from.
--
-- events_master.price_url has existed since migration 025 and is READ in four places
-- (event_targets, get_campaign_queue, and the Cheapest cell on both tabs link through it),
-- but nothing has ever WRITTEN it: the price prompt only asked for {ref, price_usd, source},
-- where source is a site NAME ("SeatGeek"), not a link. So the column has been null for every
-- game the refresh job has ever priced — 118 of 118 on the last run — and the price shown in
-- the UI was unverifiable.
--
-- lib/price.js now asks for the listing url and validates it as an absolute http(s) address.
-- This stores it.
--
-- A null url does NOT clear an existing one: the model finding no link this time is no reason
-- to throw away a good link found last time. The price itself is always overwritten, since a
-- stale price is worse than no price.

create or replace function public.set_event_prices(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb; n integer := 0; v_id uuid; v_league text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    update public.events_master
       set best_price   = (r->>'price_usd')::numeric,
           price_source = nullif(r->>'source',''),
           price_url    = coalesce(nullif(r->>'url',''), price_url),
           priced_at    = now()
     where external_id = (r->>'external_id')
       and (r->>'price_usd') is not null
    returning id, league into v_id, v_league;
    if found then
      n := n + 1;
      insert into public.events_master_price_history (event_id, league, best_price, price_source)
      values (v_id, v_league, (r->>'price_usd')::numeric, nullif(r->>'source',''));
    end if;
  end loop;
  return n;
end;
$function$;

grant execute on function public.set_event_prices(jsonb) to anon, authenticated, service_role;
