-- WHAT THE GET-IN PRICE IS ACTUALLY PER.
--
-- Vhea, 2026-08-03. The pricing prompt now prefers a listing for TWO SEATS TOGETHER and falls
-- back to a lone single only when no pair exists. The reported figure is per ticket either way,
-- so the number alone cannot tell you which happened — and the two are not the same claim. A
-- get-in read off a single is frequently a restricted-view seat nobody buying for two people can
-- use; quoting it in a blast sets an expectation the customer cannot act on.
--
-- So the model reports seat_quantity_used and it is stored beside the price, then shown in the
-- info panel next to the figure in the Queue.
--
-- NULL IS A REAL ANSWER here and is not backfilled: every price taken before this migration was
-- read under the old prompt, which never asked about seat count. Guessing '1' for those would
-- invent an observation nobody made, on exactly the field that exists to say how the number was
-- obtained.

alter table public.events_master
  add column if not exists price_seats smallint;
alter table public.events_master_price_history
  add column if not exists price_seats smallint;

comment on column public.events_master.price_seats is
  'How many seats the quoted get-in price was read off: 2 = a two-seats-together listing (preferred), 1 = a lone single, NULL = the model did not say. The price itself is PER TICKET in every case. See migration 053.';

alter table public.events_master
  drop constraint if exists events_master_price_seats_check;
alter table public.events_master
  add constraint events_master_price_seats_check
  check (price_seats is null or price_seats in (1, 2));

-- The writer. `seats` is written on EVERY run including back to NULL — a stale "2 seats" sitting
-- beside a price that was actually read off a single is a quiet lie to whoever opens the panel,
-- and the panel exists precisely so that question has an honest answer.
create or replace function public.set_event_prices(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path to 'public'
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
           price_seats    = (nullif(r->>'seats',''))::smallint,
           priced_at      = now()
     where external_id = (r->>'external_id')
       and (r->>'price_usd') is not null
    returning id, league into v_id, v_league;
    if found then
      n := n + 1;
      insert into public.events_master_price_history (event_id, league, best_price, price_source, price_currency, price_seats)
      values (v_id, v_league, (r->>'price_usd')::numeric, nullif(r->>'source',''),
              coalesce(nullif(r->>'currency',''), 'USD'), (nullif(r->>'seats',''))::smallint);
    end if;
  end loop;
  return n;
end;
$function$;

grant execute on function public.set_event_prices(jsonb) to anon, authenticated, service_role;
