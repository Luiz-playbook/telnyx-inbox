-- AI-829: Canadian markets defined by NHL metro areas.
--
-- The scrape pulled Canadian provinces but there was no market definition. Cole: only
-- Toronto, Montreal, Vancouver (occasionally Quebec) ever worked; Josh: use NHL cities as
-- market boundaries, ~50mi radius, expect 5-6 markets.
--
-- No lat/long exists on leads (company_intel has city + province text only), so the ~50mi
-- radius is approximated by a curated metro-city list per market (market_metro_city). This
-- also splits the two Alberta teams (Calgary vs Edmonton) which a province-only mapping
-- cannot. Leads whose city is in-province but outside the metro (Ottawa, London, Victoria,
-- Kelowna, ...) resolve to NULL = retained but unassigned.
--
-- Canadian markets flow through the SAME segment shape as US states: canadian_market_summary()
-- returns the same {companies, phones, icp, scp, other} columns as state_summary().

-- 1. the 6 NHL markets (toronto/vancouver/calgary/winnipeg already exist; add the rest)
insert into public.market_state (market_key, state_code)
select v.market_key, v.state_code from (values
  ('toronto','ON'), ('montreal','QC'), ('vancouver','BC'),
  ('calgary','AB'), ('edmonton','AB'), ('winnipeg','MB')
) as v(market_key, state_code)
where not exists (select 1 from public.market_state m where m.market_key = v.market_key);

-- 2. metro-city lists (~50mi). Cities normalized: lowercased, periods stripped.
create table if not exists public.market_metro_city (
  market_key text not null,
  province   text not null,          -- disambiguates AB (calgary vs edmonton)
  city_lc    text not null,          -- normalized city (lower, no periods)
  primary key (market_key, city_lc)
);
grant all on public.market_metro_city to anon, authenticated, service_role;
alter table public.market_metro_city enable row level security;
drop policy if exists market_metro_city_anon_read on public.market_metro_city;
create policy market_metro_city_anon_read on public.market_metro_city for select to anon using (true);

insert into public.market_metro_city (market_key, province, city_lc) values
  -- Toronto / Golden Horseshoe (~50mi)
  ('toronto','ON','toronto'),('toronto','ON','north york'),('toronto','ON','scarborough'),
  ('toronto','ON','etobicoke'),('toronto','ON','mississauga'),('toronto','ON','brampton'),
  ('toronto','ON','vaughan'),('toronto','ON','markham'),('toronto','ON','richmond hill'),
  ('toronto','ON','thornhill'),('toronto','ON','concord'),('toronto','ON','maple'),
  ('toronto','ON','oakville'),('toronto','ON','burlington'),('toronto','ON','milton'),
  ('toronto','ON','ajax'),('toronto','ON','pickering'),('toronto','ON','whitby'),
  ('toronto','ON','oshawa'),('toronto','ON','newmarket'),('toronto','ON','aurora'),
  ('toronto','ON','king city'),('toronto','ON','caledon'),('toronto','ON','halton hills'),
  ('toronto','ON','georgetown'),('toronto','ON','stouffville'),('toronto','ON','hamilton'),
  -- Montreal
  ('montreal','QC','montreal'),('montreal','QC','montreal-nord'),('montreal','QC','laval'),
  ('montreal','QC','longueuil'),('montreal','QC','brossard'),('montreal','QC','saint-laurent'),
  ('montreal','QC','st-laurent'),('montreal','QC','dorval'),('montreal','QC','pointe-claire'),
  ('montreal','QC','terrebonne'),('montreal','QC','repentigny'),('montreal','QC','boucherville'),
  ('montreal','QC','saint-lambert'),('montreal','QC','westmount'),('montreal','QC','verdun'),
  -- Vancouver / Lower Mainland (NOT Victoria/Kelowna)
  ('vancouver','BC','vancouver'),('vancouver','BC','north vancouver'),('vancouver','BC','west vancouver'),
  ('vancouver','BC','burnaby'),('vancouver','BC','richmond'),('vancouver','BC','surrey'),
  ('vancouver','BC','coquitlam'),('vancouver','BC','port coquitlam'),('vancouver','BC','port moody'),
  ('vancouver','BC','langley'),('vancouver','BC','delta'),('vancouver','BC','new westminster'),
  ('vancouver','BC','white rock'),('vancouver','BC','maple ridge'),('vancouver','BC','pitt meadows'),
  -- Calgary
  ('calgary','AB','calgary'),('calgary','AB','airdrie'),('calgary','AB','cochrane'),
  ('calgary','AB','okotoks'),('calgary','AB','chestermere'),('calgary','AB','strathmore'),
  -- Edmonton
  ('edmonton','AB','edmonton'),('edmonton','AB','st albert'),('edmonton','AB','saint albert'),
  ('edmonton','AB','sherwood park'),('edmonton','AB','spruce grove'),('edmonton','AB','leduc'),
  ('edmonton','AB','fort saskatchewan'),('edmonton','AB','stony plain'),('edmonton','AB','beaumont'),
  -- Winnipeg
  ('winnipeg','MB','winnipeg'),('winnipeg','MB','headingley'),('winnipeg','MB','west st paul'),
  ('winnipeg','MB','east st paul'),('winnipeg','MB','oak bluff'),('winnipeg','MB','stonewall')
on conflict (market_key, city_lc) do nothing;

-- 3. resolver: city + province -> market_key (NULL = outside any metro = unassigned)
create or replace function public.canadian_market_for(p_city text, p_province text)
returns text
language sql stable
set search_path to 'public'
as $function$
  select m.market_key
  from public.market_metro_city m
  where m.province = upper(btrim(p_province))
    and m.city_lc = lower(btrim(regexp_replace(coalesce(p_city,''), '[.]', '', 'g')))
  limit 1;
$function$;
grant execute on function public.canadian_market_for(text, text) to anon, authenticated, service_role;

-- 4. per-market segment summary — same shape as state_summary(), so Canadian markets
-- flow through the same segment model. phones = contacts with a phone in that market.
create or replace function public.canadian_market_summary()
returns table(market_key text, market_label text, province text,
              companies bigint, phones bigint, icp bigint, scp bigint, other bigint)
language sql stable security definer
set search_path to 'public'
as $function$
  with can as (
    select ci.id, ci.state as province, lower(btrim(ci.lead_segment)) as seg,
           canadian_market_for(ci.city, ci.state) as market_key
    from company_intel ci
    where upper(btrim(coalesce(ci.state,''))) in ('ON','QC','BC','AB','MB')
  ),
  ph as (
    select c.id, count(ct.*) filter (where nullif(btrim(ct.phone),'') is not null) as has_phone
    from can c left join contact_intel ct on ct.company_intel_id = c.id
    group by c.id
  )
  select c.market_key, market_label(c.market_key), max(c.province),
         count(*)::bigint,
         coalesce(sum(case when p.has_phone > 0 then 1 else 0 end),0)::bigint,
         count(*) filter (where c.seg = 'icp')::bigint,
         count(*) filter (where c.seg = 'scp')::bigint,
         count(*) filter (where c.seg is null or c.seg not in ('icp','scp'))::bigint
  from can c left join ph p on p.id = c.id
  where c.market_key is not null
  group by c.market_key
  order by count(*) desc;
$function$;
grant execute on function public.canadian_market_summary() to anon, authenticated, service_role;

-- 5. retained-but-unassigned Canadian leads (in-province, outside every metro)
create or replace function public.canadian_unassigned_leads()
returns table(state text, city text, companies bigint)
language sql stable security definer
set search_path to 'public'
as $function$
  select ci.state, ci.city, count(*)::bigint
  from company_intel ci
  where upper(btrim(coalesce(ci.state,''))) in ('ON','QC','BC','AB','MB')
    and canadian_market_for(ci.city, ci.state) is null
  group by ci.state, ci.city
  order by count(*) desc;
$function$;
grant execute on function public.canadian_unassigned_leads() to anon, authenticated, service_role;
