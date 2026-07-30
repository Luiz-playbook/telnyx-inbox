-- Prices need to say which currency they are in.
--
-- The Blue Jays play in Toronto, and SeatGeek/Ticketmaster serve that market from their .ca
-- sites in CAD. Every price was stored as a bare number and rendered with a "$", so a CAD
-- get-in was displayed as though it were USD — roughly a 35% overstatement, silently, on
-- exactly the markets migration 027 added.
--
-- 12 of the 13 Canadian NHL markets and the Blue Jays are affected once those seasons come
-- into the price window, so this is not a corner case.
--
-- Currency is stored per price rather than inferred from the market at read time: the model
-- reports which site it read, and a Canadian buyer can be quoted USD by a .com listing. What
-- was actually read is the fact worth keeping.

alter table public.events_master        add column if not exists price_currency text;
alter table public.events_master_price_history add column if not exists price_currency text;

-- Backfill: everything priced so far came from US listings except the Canadian markets, whose
-- prices are suspect and are cleared rather than guessed at.
update public.events_master em
   set price_currency = 'USD'
 where em.best_price is not null
   and em.price_currency is null
   and coalesce((select gr.country from public.geo_region gr where gr.code = em.state_code), 'US') = 'US';

update public.events_master em
   set best_price = null, price_source = null, price_url = null, priced_at = null
 where em.best_price is not null
   and (select gr.country from public.geo_region gr where gr.code = em.state_code) = 'CA';

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
       set best_price     = (r->>'price_usd')::numeric,
           price_source   = nullif(r->>'source',''),
           price_currency = coalesce(nullif(r->>'currency',''), 'USD'),
           price_url      = coalesce(nullif(r->>'url',''), price_url),
           priced_at      = now()
     where external_id = (r->>'external_id')
       and (r->>'price_usd') is not null
    returning id, league into v_id, v_league;
    if found then
      n := n + 1;
      insert into public.events_master_price_history (event_id, league, best_price, price_source, price_currency)
      values (v_id, v_league, (r->>'price_usd')::numeric, nullif(r->>'source',''),
              coalesce(nullif(r->>'currency',''), 'USD'));
    end if;
  end loop;
  return n;
end;
$function$;

grant execute on function public.set_event_prices(jsonb) to anon, authenticated, service_role;
