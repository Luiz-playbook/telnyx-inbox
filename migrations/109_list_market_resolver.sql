-- Resolve a CakeMail list name to a market WITHOUT needing a hand-written row for every list.
--
-- WHY. v_blast_scored inner-joined market_bridge_list on an exact list_name match, so any list
-- nobody had bridged contributed nothing to v_market_performance and its market read
-- `no_history`. That was survivable while Cole named lists by metro and reused them
-- ('Louisville', 'Washington DC'). It stopped being survivable for two reasons:
--
--   1. The production sender names a list per blast with the matchup and segment baked in:
--      'Lions at Arizona Cardinals - Arizona - ICP - AZ'. Every send mints a brand new
--      list_name, so an exact-match bridge can never catch up.
--   2. The CakeMail accounts are NOT exclusive to this app. People send blasts by hand, naming
--      lists whatever they like. No convention the app follows can cover those.
--
-- So exact matching stays as the authority, and two fallbacks run underneath it. 21 list names
-- covering 37 campaigns and ~173k sent emails were unbridged when this was written.
--
-- PRECEDENCE, highest first. A list resolved at one level never falls through to a lower one,
-- which is what makes an explicit 'other' row a real veto rather than a suggestion:
--
--   exact       market_bridge_list.list_name = list_name           (hand-authored, authoritative)
--   state_code  trailing 2-letter code: '... - ICP - AZ' -> AZ     (the production naming)
--   state_name  a state name appearing anywhere in the list name   ('Wisconsin', 'Oregon')
--
-- BOTH FALLBACKS ONLY FIRE FOR SINGLE-MARKET STATES. market_state maps market_key ->
-- state_code and 10 of its states hold more than one market (CA has anaheim, los_angeles,
-- sacramento, san_diego, san_francisco; FL has three; AB/MO/NY/OH/ON/PA/TN/TX have two). For
-- those, guessing would silently credit a blast to the wrong city, which is worse than reading
-- `no_history` — an unmapped market is visibly missing, a mismapped one is quietly wrong. They
-- stay manual. 'ZZ' is the test pseudo-state and is excluded outright.
--
-- MEASURED on the live data before committing this:
--   state_code  'Lions at Arizona Cardinals - Arizona - ICP - AZ' -> phoenix
--   state_name  Illinois -> chicago, Iowa -> iowa, Oregon -> portland, Wisconsin -> milwaukee
--   no false positives: 'Teammate AI VB' -> VB and 'Teammate AI VB II' -> II match no state.
--
-- The trailing-code regex requires a NON-LETTER before the two letters, so ordinary words do
-- not become state codes — 'We're hiring blast' does not resolve to 'st'.

-- ---------------------------------------------------------------------------
-- State / province names. market_state only carries codes, and a human types
-- 'Wisconsin', not 'WI'. Covers every US state plus the Canadian provinces that appear in
-- market_state (AB, BC, MB, ON, QC). 'washington dc' is listed ahead of 'washington' by being
-- longer — by_name prefers the longest match, so DC does not get swallowed by WA.
-- ---------------------------------------------------------------------------
create table if not exists public.state_name_code (
  state_name_lc text primary key,
  state_code    text not null
);

insert into public.state_name_code (state_name_lc, state_code)
select v.n, v.c from (values
  ('alabama','AL'),('alaska','AK'),('alberta','AB'),('arizona','AZ'),('arkansas','AR'),
  ('british columbia','BC'),('california','CA'),('colorado','CO'),('connecticut','CT'),
  ('delaware','DE'),('district of columbia','DC'),('washington dc','DC'),('florida','FL'),
  ('georgia','GA'),('hawaii','HI'),('idaho','ID'),('illinois','IL'),('indiana','IN'),
  ('iowa','IA'),('kansas','KS'),('kentucky','KY'),('louisiana','LA'),('maine','ME'),
  ('manitoba','MB'),('maryland','MD'),('massachusetts','MA'),('michigan','MI'),
  ('minnesota','MN'),('mississippi','MS'),('missouri','MO'),('montana','MT'),
  ('nebraska','NE'),('nevada','NV'),('new hampshire','NH'),('new jersey','NJ'),
  ('new mexico','NM'),('new york','NY'),('north carolina','NC'),('north dakota','ND'),
  ('ohio','OH'),('oklahoma','OK'),('ontario','ON'),('oregon','OR'),('pennsylvania','PA'),
  ('quebec','QC'),('rhode island','RI'),('saskatchewan','SK'),('south carolina','SC'),
  ('south dakota','SD'),('tennessee','TN'),('texas','TX'),('utah','UT'),('vermont','VT'),
  ('virginia','VA'),('washington','WA'),('west virginia','WV'),('wisconsin','WI'),
  ('wyoming','WY')
) as v(n, c)
where not exists (select 1 from public.state_name_code s where s.state_name_lc = v.n);

-- ---------------------------------------------------------------------------
-- The resolver. `how` is kept so a surprising mapping can be explained without re-deriving it.
-- ---------------------------------------------------------------------------
create or replace view public.v_list_market as
with single_state as (
  select state_code, max(market_key) as market_key
    from public.market_state
   where state_code <> 'ZZ'
   group by state_code
  having count(*) = 1
),
lists as (
  select distinct list_name from public.blast_templates where list_name is not null
),
exact as (
  select l.list_name, b.market_key, 'exact'::text as how
    from lists l
    join public.market_bridge_list b on b.list_name = l.list_name
),
by_code as (
  select distinct on (l.list_name) l.list_name, s.market_key, 'state_code'::text as how
    from lists l
    join single_state s
      on s.state_code = upper(substring(l.list_name from '[^A-Za-z]([A-Za-z]{2})\s*$'))
   where not exists (select 1 from exact e where e.list_name = l.list_name)
),
by_name as (
  select distinct on (l.list_name) l.list_name, s.market_key, 'state_name'::text as how
    from lists l
    join public.state_name_code n on position(n.state_name_lc in lower(l.list_name)) > 0
    join single_state s on s.state_code = n.state_code
   where not exists (select 1 from exact e where e.list_name = l.list_name)
     and not exists (select 1 from by_code c where c.list_name = l.list_name)
   order by l.list_name, length(n.state_name_lc) desc
)
select list_name, market_key, how from exact
union all
select list_name, market_key, how from by_code
union all
select list_name, market_key, how from by_name;

-- ---------------------------------------------------------------------------
-- Scoring now reads the resolver. Column list is unchanged, so every consumer
-- (v_market_performance, rpc_event_recommendations, the Market History tab) is untouched.
-- ---------------------------------------------------------------------------
create or replace view public.v_blast_scored as
 SELECT bt.id,
    bt.name,
    bt.campaign_id,
    bt.list_name,
    lm.market_key,
    bt.sent_emails,
    bt.open_rate,
    bt.click_rate,
    bt.clickthru_rate,
    bt.bounce_rate,
    bt.unsubscribe_rate,
    bt.scheduled_for,
    bt.email_template,
    bt.show_email_link_url,
    0.7 * COALESCE(bt.clickthru_rate, 0::numeric) + 0.3 * COALESCE(bt.open_rate, 0::numeric) AS perf_score
   FROM public.blast_templates bt
     JOIN public.v_list_market lm ON lm.list_name = bt.list_name
  WHERE lm.market_key <> 'other'::text;

-- ---------------------------------------------------------------------------
-- The gap report must agree with the resolver, or it keeps nagging about lists that now map
-- themselves. 'other' is still reported deliberately: it means "known and excluded", and
-- seeing it is how you notice something was excluded by mistake.
-- ---------------------------------------------------------------------------
create or replace function public.blast_templates_unmapped_lists()
 returns table(list_name text, campaigns bigint, last_sent timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select bt.list_name, count(*), max(bt.scheduled_for)
    from public.blast_templates bt
    left join public.v_list_market lm on lm.list_name = bt.list_name
   where bt.list_name is not null
     and (lm.list_name is null or lm.market_key = 'other')
   group by bt.list_name
   order by max(bt.scheduled_for) desc nulls last;
$function$;

-- ---------------------------------------------------------------------------
-- Non-market sends, excluded explicitly. These are not markets and never will be: a recruiting
-- blast to 74,370 people and four Teammate AI product sends. Left unmapped they sat in the gap
-- report inviting someone to bridge them; folded into a market they would wreck its averages.
-- ---------------------------------------------------------------------------
insert into public.market_bridge_list (list_name, market_key)
select v.list_name, v.market_key from (values
  ('We''re hiring blast', 'other'),
  ('Teammate AI Baseball', 'other'),
  ('Teammate AI Basketball Split 4-8', 'other'),
  ('Teammate AI VB', 'other'),
  ('Teammate AI VB II', 'other')
) as v(list_name, market_key)
where not exists (
  select 1 from public.market_bridge_list b where b.list_name = v.list_name
);
