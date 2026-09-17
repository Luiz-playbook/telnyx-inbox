-- 077: scraped price candidates, and choosing one of them by hand (AI-969).
--
-- Prices now come from scraping the marketplaces themselves (lib/scrape-price.js) before the
-- search model is asked at all. A scrape does not produce one number, it produces several —
-- the cheapest pair on Gametime, the next two up, TickPick's get-in — and the refresh picks the
-- cheapest to pay. The rest used to be thrown away. They are the thing an operator most wants
-- when the picked price looks wrong: the other real listings for the same game, one click away.
--
-- WHAT A CANDIDATE IS. One element of events_master.price_candidates:
--   { source, url, price, all_in, currency, seats, section, row, section_group, quantities,
--     note, via, checked_at, chosen, chosen_by }
-- `price` is per ticket before fees — the definition best_price has always had. `all_in` is what
-- the buyer pays; candidates are ranked by it. Exactly one element carries chosen: true, and it is
-- the listing best_price/price_url/price_source/price_seats were copied from.
--
-- The column is overwritten on every refresh, INCLUDING back to NULL when a game is priced by the
-- model instead. A list of scraped listings sitting beside a price that did not come from any of
-- them would be offering the operator a basis the number does not have — the same reasoning that
-- overwrites price_seats every run.

alter table public.events_master
  add column if not exists price_candidates jsonb;

comment on column public.events_master.price_candidates is
  'Scraped listings behind best_price (AI-969): [{source,url,price,all_in,seats,section,row,section_group,chosen,...}]. '
  'Null when the price came from the search model or was typed by hand.';

-- ---------------------------------------------------------------------------------------------
-- 1. set_event_prices — now also stores the candidates a row carries.
--
-- Body is the live definition read back from the database on 2026-09-15, plus the one column.
-- The (p_league, p_rows) overload is left alone: nothing calls it since migration 038.
-- ---------------------------------------------------------------------------------------------
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
       set best_price       = (r->>'price_usd')::numeric,
           price_source     = nullif(r->>'source',''),
           price_currency   = coalesce(nullif(r->>'currency',''), 'USD'),
           price_url        = coalesce(nullif(r->>'url',''), price_url),
           -- Overwritten every run, including back to NULL: a stale "2 seats" sitting beside a
           -- price that was actually read off a single is a quiet lie to whoever opens the panel.
           price_seats      = (nullif(r->>'seats',''))::smallint,
           -- Same rule. A model-priced row sends no candidates and clears the old list.
           price_candidates = case when jsonb_typeof(r->'candidates') = 'array'
                                        and jsonb_array_length(r->'candidates') > 0
                                   then r->'candidates' else null end,
           priced_at        = now()
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

-- ---------------------------------------------------------------------------------------------
-- 2. set_event_price_candidate — an operator picks a different scraped listing.
--
-- Takes an INDEX into the stored list, not a price. The browser never gets to say what the price
-- is: it names a listing the refresh already read, and the number, link, source and seat count are
-- copied from the database's own copy. A tampered request can only choose among real listings.
--
-- Not locked, like a manual price (migration 055, decision 1): the next refresh re-ranks and may
-- pick a different listing. chosen_by records that a person made this one.
-- ---------------------------------------------------------------------------------------------
create or replace function public.set_event_price_candidate(p_event_id uuid, p_index integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_list   jsonb;
  v_pick   jsonb;
  v_league text;
  v_seats  smallint;
begin
  if p_event_id is null or p_index is null then
    raise exception 'set_event_price_candidate: p_event_id and p_index are required';
  end if;

  select price_candidates, league into v_list, v_league
    from public.events_master where id = p_event_id
   for update;

  if v_list is null or jsonb_typeof(v_list) <> 'array' then
    raise exception 'set_event_price_candidate: this game has no scraped prices to choose from';
  end if;
  if p_index < 0 or p_index >= jsonb_array_length(v_list) then
    raise exception 'set_event_price_candidate: no candidate at index % (have %)', p_index, jsonb_array_length(v_list);
  end if;

  v_pick := v_list -> p_index;
  if (v_pick->>'price') is null or (v_pick->>'price')::numeric <= 0 then
    raise exception 'set_event_price_candidate: candidate % has no usable price', p_index;
  end if;
  v_seats := case when (v_pick->>'seats') in ('1','2') then (v_pick->>'seats')::smallint else null end;

  -- Move the chosen flag: clear it everywhere, then set it on the pick.
  select jsonb_agg(
           case when ord - 1 = p_index
                then (elem - 'chosen' - 'chosen_by') || jsonb_build_object('chosen', true, 'chosen_by', 'operator')
                else elem - 'chosen' - 'chosen_by' end
           order by ord)
    into v_list
    from jsonb_array_elements(v_list) with ordinality as t(elem, ord);

  update public.events_master
     set best_price       = (v_pick->>'price')::numeric,
         price_source     = nullif(v_pick->>'source',''),
         price_url        = nullif(v_pick->>'url',''),
         price_currency   = coalesce(nullif(v_pick->>'currency',''), 'USD'),
         price_seats      = v_seats,
         price_candidates = v_list,
         priced_at        = now()
   where id = p_event_id;

  insert into public.events_master_price_history
         (event_id, league, best_price, price_source, price_currency, price_seats, set_by)
  values (p_event_id, v_league, (v_pick->>'price')::numeric, nullif(v_pick->>'source',''),
          coalesce(nullif(v_pick->>'currency',''), 'USD'), v_seats, auth.uid());

  return 1;
end;
$function$;

-- Same reach as set_event_price_manual: signed-in users and the service role, never anon.
-- PUBLIC has to be revoked explicitly — anon inherits EXECUTE through it, so revoking from anon
-- alone closes nothing on this instance.
revoke execute on function public.set_event_price_candidate(uuid, integer) from public, anon;
grant  execute on function public.set_event_price_candidate(uuid, integer) to authenticated, service_role;
