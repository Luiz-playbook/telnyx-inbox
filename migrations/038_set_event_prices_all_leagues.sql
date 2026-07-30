-- Price writes must not be locked to one league.
--
-- set_event_prices(p_league, p_rows) filters `where league = p_league`, and the refresh job
-- passed the literal 'mlb'. Any NFL or NHL price would therefore be looked up, PAID FOR via
-- a grounded Gemini call, and then silently discarded — the update would match no row and the
-- run would still report it as priced. It is masked today because every NFL/NHL game is
-- outside the forward window and so never eligible, but it would start burning money the day
-- the season came into range.
--
-- external_id is globally unique across events_master (2,449 of 2,449 distinct), so the league
-- predicate was never doing any disambiguating work. This overload drops it and takes the
-- league from the row it actually updated, which is also what the history row should record.
--
-- The two-argument version is left in place: other callers may still use it, and it is now
-- simply the single-league special case.

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
