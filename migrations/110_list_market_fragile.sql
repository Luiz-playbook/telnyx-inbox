-- Which blast lists are mapped only by inference, and would silently un-map if their state
-- gained a second market.
--
-- WHY THIS EXISTS. v_list_market (migration 109) resolves a list name by exact bridge row
-- first, then by a trailing state code, then by a state name in the text. The two fallbacks
-- fire ONLY for states holding exactly one market, because guessing a city inside a
-- multi-market state would quietly credit a blast to the wrong place.
--
-- That rule has a sharp edge. Adding a market is a normal thing to do — and the moment a
-- single-market state gains a second market, every list resolved through it stops resolving.
-- No error, no migration failure: the blast simply drops out of v_blast_scored and its market
-- reads `no_history` again. Add `madison` to WI and the four Wisconsin blasts vanish from
-- milwaukee. Add a second AZ market and the 2026-10-06 Lions/Cardinals blast leaves Market
-- History the same day someone was pleased it finally appeared.
--
-- So: BEFORE inserting into market_state, read this view. Anything listed whose state you are
-- about to touch needs an explicit market_bridge_list row written in the SAME migration —
-- exact rows outrank both fallbacks, so the mapping survives the change.
--
-- Every row here is fragile by construction (how <> 'exact'). markets_in_state is carried
-- anyway because it is the number that has to stay at 1 for the row to keep working, and
-- stating it is cheaper than re-deriving why the row is listed.

create or replace view public.v_list_market_fragile as
select lm.list_name,
       lm.market_key,
       lm.how,
       ms.state_code,
       (select count(*) from public.market_state x
         where x.state_code = ms.state_code) as markets_in_state,
       (select count(*) from public.blast_templates bt
         where bt.list_name = lm.list_name) as campaigns,
       (select max(bt.scheduled_for) from public.blast_templates bt
         where bt.list_name = lm.list_name) as last_sent
  from public.v_list_market lm
  join public.market_state ms on ms.market_key = lm.market_key
 where lm.how <> 'exact';

grant select on public.v_list_market_fragile to anon, authenticated, service_role, readonly_preview;
