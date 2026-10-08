-- 107: the cheapest lower-bowl seat in each zone, per game (AI-1089).
--
-- WHY A SECOND COLUMN AND NOT MORE CANDIDATES. price_candidates (077) answers "what could this
-- game cost" — a ranked list the operator picks from, all of it competing to be THE price.
-- zone_prices answers a different question: "what does a seat in each part of the arena cost",
-- four numbers that coexist. Putting zones into price_candidates would make them compete to be
-- the get-in, which is the opposite of what the premium offer wants — the whole point (Josh,
-- Oct 7) is that the cheapest lower-bowl seat is usually behind the basket, and the offer wants
-- to quote centre court instead.
--
-- SHAPE. One object keyed by zone, matching cheapestByZone() in lib/section-zones.js:
--   {"center court": {all_in, price, section, row, source, url, confidence}, "sideline": {...}, …}
-- Zones are the four from the NBA_Arena_Section_Map: center court, sideline, corner,
-- behind basket. A zone with no lower-bowl listing is simply absent rather than null, so the UI
-- can tell "no seats in this zone" from "we never looked".
--
-- LOWER BOWL ONLY, and that is a deliberate narrowing. "Center court from $X" is a bowl claim;
-- a mezzanine seat carrying a bowl section number (Cavs M101-M126) or a suite whose name happens
-- to contain a bowl number ("Loge Suites 106") would undercut the quote with a seat nobody would
-- call centre court. lib/section-zones.js filters on the ring, preferring the one the listing states
-- over the one inferred from its number.
--
-- CONFIDENCE TRAVELS WITH THE PRICE. A third of the section map is "Derived" — placed by counting
-- around the bowl rather than read off a label. Those rows carry confidence 'Medium' and the
-- sheet says verify before quoting, so the number keeps that warning all the way to the operator
-- rather than losing it at the database boundary.
--
-- OVERWRITTEN EVERY RUN, including back to NULL, exactly like price_candidates. Stale zone prices
-- sitting beside a freshly refreshed get-in would be a quiet lie about which seats are available.

alter table public.events_master
  add column if not exists zone_prices jsonb;

comment on column public.events_master.zone_prices is
  'Cheapest LOWER-BOWL seat per zone (AI-1089): {"center court":{all_in,price,section,row,source,url,confidence},...}. '
  'Zones from the NBA_Arena_Section_Map. NBA only; null for every other league and for games whose '
  'listings carried no section. confidence=Medium means the section was derived by counting around '
  'the bowl, not read off a label — verify before quoting it.';

-- ---------------------------------------------------------------------------------------------
-- set_event_prices — same contract, plus the zone block.
--
-- Body is migration 077's definition with one column added. Null-safe in both directions: a row
-- that sends no zones clears the column, which is what a non-NBA game or a sectionless scrape
-- should do.
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
           price_seats      = (nullif(r->>'seats',''))::smallint,
           price_candidates = case when jsonb_typeof(r->'candidates') = 'array'
                                        and jsonb_array_length(r->'candidates') > 0
                                   then r->'candidates' else null end,
           -- An object with no keys is "we looked and found nothing", which stores as NULL for
           -- the same reason an empty candidate list does.
           zone_prices      = case when jsonb_typeof(r->'zone_prices') = 'object'
                                        and r->'zone_prices' <> '{}'::jsonb
                                   then r->'zone_prices' else null end,
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
