-- Bridge the production sender's event-scoped list names into market_bridge_list.
--
-- WHY. v_blast_scored inner-joins market_bridge_list on list_name, so a blast whose list has
-- no bridge row contributes NOTHING to v_market_performance and the market reads `no_history`.
-- The Lions/Cardinals blast of 2026-10-06 (campaigns 15501805, 15501800 on account 1761047)
-- is the first real send on the production account and it fell straight into that hole.
--
-- The metro was never the problem: market_bridge_list already carries 'Arizona' -> phoenix and
-- 'Phoenix Arizona' -> phoenix. What changed is the NAMING on the production sender. Cole's
-- lists are metro handles that repeat across sends:
--
--     Washington DC            Louisville            Yankees New York City
--
-- The production sender names a list per blast, with the matchup and the segment baked in:
--
--     Lions at Arizona Cardinals - Arizona - ICP - AZ
--     Lions at Arizona Cardinals - Arizona - SCP - AZ
--
-- So an exact-match bridge can never keep up: every future blast mints a brand new list_name
-- and lands unmapped again. These two rows fix the blast that already went out. They do NOT
-- fix the pattern.
--
-- THE REAL FIX, deliberately not done here because it changes a view every consumer reads:
-- normalise list_name before the join (strip the ' - <SEGMENT> - <ST>' tail and the
-- '<matchup> - ' head, leaving the metro), or bridge on the trailing state code. Either is a
-- change to v_blast_scored and wants its own migration and a look at all 51 existing rows.
-- Until then, `blast_templates_unmapped_lists` (already returned by api/cakemail-sync.js) is
-- the thing to watch after every production send.
--
-- Idempotent.

insert into public.market_bridge_list (list_name, market_key)
select v.list_name, v.market_key from (values
  ('Lions at Arizona Cardinals — Arizona · ICP — AZ', 'phoenix'),
  ('Lions at Arizona Cardinals — Arizona · SCP — AZ', 'phoenix')
) as v(list_name, market_key)
where not exists (
  select 1 from public.market_bridge_list b where b.list_name = v.list_name
);

-- The QA/test lists on the production account are mapped to 'other' so v_blast_scored drops
-- them (it inner-joins the bridge and 'other' is not a market), the same way
-- 'EZ Facility Sportsplex' is handled. See HISTORY_ACCOUNTS in api/cakemail-sync.js for the
-- same reasoning applied to the pbtest sub-account.
--
-- These rows do NOT remove the lists from blast_templates_unmapped_lists: that function
-- reports `b.list_name is null OR b.market_key = 'other'`, i.e. 'other' is deliberately still
-- flagged. The rows change what gets SCORED, not what gets REPORTED.
insert into public.market_bridge_list (list_name, market_key)
select v.list_name, v.market_key from (values
  ('Test Campaign (send-path check)', 'other'),
  ('Production Cakemail Campaign Test', 'other'),
  ('reply-path-test 2026-10-01T13-32-28-555Z', 'other')
) as v(list_name, market_key)
where not exists (
  select 1 from public.market_bridge_list b where b.list_name = v.list_name
);
