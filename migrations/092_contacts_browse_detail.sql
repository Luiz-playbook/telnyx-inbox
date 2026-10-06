-- 092 — the two reads behind the Contacts tab: the paged list, and one person in full.
--
-- WHY FUNCTIONS AND NOT TABLE READS. Nothing the browser holds can read any of the three
-- sources: contact_intel has RLS on with ZERO policies (so anon gets an empty array rather than
-- an error -- the trap AI-970 hit), and the hubspot and ticketblaster schemas are deliberately
-- not exposed to PostgREST (062, 090). Rather than expose two private schemas to serve one tab,
-- the join happens here and api/contacts.js calls it with the service key. Same reasoning as
-- api/market-history.js, over the same tables.
--
-- BOTH READ public.contact_directory, NOT THE SOURCE TABLES. One row per person, so a contact
-- held in both HubSpot and intel appears ONCE with both badges instead of twice with no way to
-- tell it is one person -- which is what 2,404 people would have done. The source "tabs" are
-- therefore presence filters over the directory, not separate queries, and a per-source count is
-- a count of people present in that source.
--
-- WHAT THAT TRADES AWAY, SAID PLAINLY. contact_intel holds 264,245 rows but only 178,113
-- distinct identities, so the directory is not a row-for-row view of it: rows sharing an address
-- merge, and a row with no usable address AND no usable number cannot be keyed at all and is
-- absent. For browsing people that is correct. For auditing raw intel rows it is not, and that
-- is what the detail modal shows -- every matching row from every source, unmerged.

-- ---------------------------------------------------------------------------------------------
-- contacts_browse(...) -> one page of people, plus how many matched.
--
-- DYNAMIC SQL, AND IT IS NOT OPTIONAL. The first version of this built the search pattern in a
-- CTE and joined it on (`from contact_directory d, f where d.search_text like f.pat`). That is
-- correct and it is also 3.6 SECONDS, because a pattern the planner cannot see at plan time
-- cannot be matched against the trigram index -- so every keystroke sequential-scanned 256k
-- rows. The identical filter with the pattern as a literal runs in 38ms off
-- contact_directory_search_idx. So the pattern is injected as a literal, via quote_literal.
--
-- quote_literal IS THE WHOLE DEFENCE, so nothing else may be interpolated. Every other fragment
-- of the WHERE clause below is chosen from a fixed set by an IF on the parameter value -- never
-- built from one -- and the two numbers are cast through ::integer before they are formatted.
-- A caller-supplied string reaches the SQL text in exactly one place and it is escaped there.
--
-- THE COUNT IS CAPPED AT 10,000 ON PURPOSE. An exact total means counting every matching row:
-- fine for "sportsplex" (324), ruinous for "a" (most of the table) on every keystroke. Counting
-- to 10,001 bounds the worst case while staying exact for every number small enough for a
-- person to care about.
--
-- HOW "CAPPED" IS SIGNALLED, AND WHY IT IS NOT A SEPARATE COLUMN. total comes back as 10001
-- when there are more than 10,000 matches, and api/contacts.js turns that into "10,000+" for
-- the UI. An extra boolean column would read better here but would change the function's
-- return type, which Postgres cannot do with CREATE OR REPLACE -- it needs a DROP, and dropping
-- a function the deployed app is calling is a worse trade than one documented sentinel.
create or replace function public.contacts_browse(
  p_source   text    default 'all',      -- all | hubspot | intel | imported
  p_q        text    default null,
  p_state    text    default null,
  p_presence text    default null,       -- hubspot_and_intel | hubspot_only | intel_only
  p_limit    integer default 50,
  p_offset   integer default 0
) returns table (
  total        bigint,
  identity_key text,
  in_hubspot   boolean,
  in_intel     boolean,
  in_imported  boolean,
  first_name   text,
  last_name    text,
  email        text,
  phone        text,
  company      text,
  state        text,
  updated_at   timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  c_cap constant integer := 10000;
  v_where text := 'true';
  v_q     text := nullif(btrim(coalesce(p_q, '')), '');
  v_state text := nullif(btrim(upper(coalesce(p_state, ''))), '');
  v_lim   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
begin
  -- Source. Compared against fixed strings; an unrecognised value is rejected rather than
  -- quietly falling through to 'all', which would show the whole directory on a typo'd filter
  -- and look like it had worked.
  if    p_source in ('all', '')      or p_source is null then null;
  elsif p_source = 'hubspot'  then v_where := v_where || ' and in_hubspot';
  elsif p_source = 'intel'    then v_where := v_where || ' and in_intel';
  elsif p_source = 'imported' then v_where := v_where || ' and in_imported';
  else raise exception 'unknown contact source: %', p_source;
  end if;

  -- Presence, same treatment.
  if    p_presence in ('', 'any') or p_presence is null then null;
  elsif p_presence = 'hubspot_and_intel' then v_where := v_where || ' and in_hubspot and in_intel';
  elsif p_presence = 'hubspot_only'      then v_where := v_where || ' and in_hubspot and not in_intel';
  elsif p_presence = 'intel_only'        then v_where := v_where || ' and in_intel and not in_hubspot';
  else raise exception 'unknown presence filter: %', p_presence;
  end if;

  -- The one caller-supplied string that reaches the SQL text. LIKE metacharacters are escaped
  -- first so a search for "100% off" or an address with an underscore matches literally instead
  -- of silently becoming a wildcard; quote_literal then makes it a safe literal.
  if v_q is not null then
    v_where := v_where || ' and search_text like ' || quote_literal(
      '%' || lower(replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_')) || '%');
  end if;

  if v_state is not null then
    v_where := v_where || ' and upper(coalesce(state, '''')) = ' || quote_literal(v_state);
  end if;

  execute format(
    'select count(*) from (select 1 from public.contact_directory where %s limit %s) z',
    v_where, (c_cap + 1)::integer
  ) into v_total;

  return query execute format(
    'select %s::bigint, identity_key, in_hubspot, in_intel, in_imported,
            first_name, last_name, email, phone, company, state, updated_at
       from public.contact_directory
      where %s
      -- nulls last so rows with no timestamp sink rather than heading the list; identity_key
      -- breaks ties so paging is stable and a row cannot appear on two consecutive pages.
      order by updated_at desc nulls last, identity_key
      limit %s offset %s',
    v_total::bigint, v_where, v_lim::integer, v_off::integer
  );
end;
$fn$;

revoke all on function public.contacts_browse(text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.contacts_browse(text, text, text, text, integer, integer) to service_role;


-- ---------------------------------------------------------------------------------------------
-- contacts_stats() -> the headline numbers for the tab.
--
-- The overlap figures are the point of the tab, not decoration: "77,993 people in HubSpot who
-- are in no sendable audience" is the answer to the question the ticket asks, and it has to be
-- on screen rather than derivable. refreshed_at travels with them so a stale directory is
-- visible rather than merely wrong.
create or replace function public.contacts_stats()
returns jsonb
language sql
security definer
set search_path = public, hubspot, pg_temp
as $fn$
  select jsonb_build_object(
    'people',            count(*),
    'in_hubspot',        count(*) filter (where in_hubspot),
    'in_intel',          count(*) filter (where in_intel),
    'in_imported',       count(*) filter (where in_imported),
    'hubspot_and_intel', count(*) filter (where in_hubspot and in_intel),
    'hubspot_only',      count(*) filter (where in_hubspot and not in_intel),
    'intel_only',        count(*) filter (where in_intel and not in_hubspot),
    'have_email',        count(*) filter (where email is not null),
    'have_phone',        count(*) filter (where phone is not null),
    'refreshed_at',      (select refreshed_at from public.contact_directory_state where id),
    'refresh_ms',        (select ms from public.contact_directory_state where id),
    'hubspot_synced_at', (select max(synced_at) from hubspot.hubspot_contacts)
  )
  from public.contact_directory;
$fn$;

revoke all on function public.contacts_stats() from public, anon, authenticated;
grant execute on function public.contacts_stats() to service_role;


-- ---------------------------------------------------------------------------------------------
-- contact_detail(identity_key) -> everything we hold about one person, from every source.
--
-- UNMERGED, ON PURPOSE. The list merges; this does not. Every matching row from every source is
-- returned as its own object, because the question the modal answers is "what do we actually
-- know, and which system told us" -- and a merged answer cannot say that. Where two sources
-- disagree about a name or a company the modal shows both rather than picking, which is not a
-- hypothetical: HubSpot holds "Ajstock Stock" for a contact intel names properly, and that
-- disagreement is worth seeing rather than resolving silently.
--
-- market_blasts IS NOT A RECEIVED-MESSAGE LIST, AND MUST NOT READ AS ONE. Nobody ever recorded
-- who an SMS blast went to: campaign_queue keeps only phone_count/sms_count/email_count, and
-- recipients are resolved live at send time from market_phones/market_emails and discarded. So
-- these are blasts sent to the MARKET this contact sits in -- evidence that messaging reached
-- their state, not proof it reached them. The UI label has to carry that distinction, the same
-- way api/market-history.js labels its CakeMail roster as today's list rather than the roster at
-- send time.
create or replace function public.contact_detail(p_identity_key text)
returns jsonb
language sql
security definer
set search_path = public, hubspot, ticketblaster, pg_temp
as $fn$
  with d as (
    select * from public.contact_directory where identity_key = p_identity_key
  ),
  -- The normalised keys this person is known by, used to match the tables that carry no
  -- directory id. Derived from the directory row rather than parsed out of identity_key:
  -- identity_key is a single value (the email key, or the phone when there is no address), so
  -- splitting it would silently match nobody for every phone-only contact.
  k as (
    select public.sendable_email(d.email)  as ek,
           public.norm_phone_e164(d.phone) as pk
    from d
  ),
  hs_contact as (
    select to_jsonb(c) as j from hubspot.hubspot_contacts c, d
    where c.hs_object_id::text = d.hubspot_id
  ),
  hs_companies as (
    select coalesce(jsonb_agg(to_jsonb(co) order by co.name), '[]'::jsonb) as j
    from hubspot.hubspot_companies co, d
    where d.hubspot_id is not null
      and co.associated_contact_ids @> array[d.hubspot_id::bigint]
  ),
  hs_deals as (
    select coalesce(jsonb_agg(
             to_jsonb(dl) || jsonb_build_object('stage_label', st.stage_label, 'pipeline_label', st.pipeline_label)
             order by dl.closedate desc nulls last), '[]'::jsonb) as j
    from hubspot.hubspot_deals dl
    left join hubspot.hubspot_deal_stages st on st.stage_id = dl.dealstage, d
    where d.hubspot_id is not null
      and dl.associated_contact_ids @> array[d.hubspot_id::bigint]
  ),
  -- EVERY matching intel row, not just the directory's chosen one: an address can appear on
  -- several scraped rows under different companies, and that is itself worth seeing.
  intel_rows as (
    select coalesce(jsonb_agg(
             to_jsonb(ci) || jsonb_build_object('company', to_jsonb(co))
             order by ci.updated_at desc nulls last), '[]'::jsonb) as j
    from public.contact_intel ci
    left join public.company_intel co on co.id = ci.company_intel_id, k
    where (k.ek is not null and public.sendable_email(ci.email) = k.ek)
       or (k.pk is not null and public.norm_phone_e164(ci.phone) = k.pk)
  ),
  imported_rows as (
    select coalesce(jsonb_agg(to_jsonb(ic) order by ic.imported_at desc), '[]'::jsonb) as j
    from ticketblaster.imported_contacts ic, k
    where (k.ek is not null and ic.email_key = k.ek)
       or (k.pk is not null and ic.phone_e164 = k.pk)
  ),
  -- Is this person actually sendable today, and in which markets? market_contacts is the
  -- snapshot the Queue and Compose count from, so this answers "would a blast to that market
  -- include them" rather than "are they in a table somewhere". An empty array here on a contact
  -- that plainly exists is the single most useful thing this modal shows.
  reach as (
    select coalesce(jsonb_agg(distinct jsonb_build_object(
             'code', mc.code, 'state_name', mc.state_name, 'segment', mc.segment,
             'organization_name', mc.organization_name, 'city', mc.city,
             'has_email', mc.email is not null, 'has_phone', mc.phone is not null
           )), '[]'::jsonb) as j
    from public.market_contacts mc, k
    where (k.ek is not null and public.sendable_email(mc.email) = k.ek)
       or (k.pk is not null and public.norm_phone_e164(mc.phone) = k.pk)
  ),
  -- Suppression is the one fact that overrides every other panel: a contact can look perfectly
  -- reachable and be deliberately silenced. Shown first in the modal for that reason.
  suppressed as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'email', dnc.email, 'phone', dnc.phone, 'reason', dnc.reason,
             'source', dnc.source, 'created_at', dnc.created_at
           )), '[]'::jsonb) as j
    from public.do_not_contact dnc, k
    where (k.ek is not null and public.sendable_email(dnc.email) = k.ek)
       or (k.pk is not null and public.norm_phone_e164(dnc.phone) = k.pk)
  ),
  blasts as (
    select coalesce(jsonb_agg(x order by x->>'blasted_at' desc), '[]'::jsonb) as j
    from (
      select jsonb_build_object(
               'market_key', b.market_key, 'state_code', b.state_code, 'channel', b.channel,
               'template_name', b.template_name, 'recipient_count', b.recipient_count,
               'segment', b.segment, 'source', b.source, 'blasted_at', b.blasted_at
             ) as x
      from public.ticketblaster_market_blasts_log b, d
      where d.state is not null and upper(b.state_code) = upper(d.state)
      order by b.blasted_at desc
      limit 25
    ) y
  )
  select jsonb_build_object(
    'found',         (select count(*) from d) > 0,
    'identity',      (select to_jsonb(d) from d),
    'hubspot',       jsonb_build_object(
                       'contact',   (select j from hs_contact),
                       'companies', (select j from hs_companies),
                       'deals',     (select j from hs_deals)
                     ),
    'intel',         (select j from intel_rows),
    'imported',      (select j from imported_rows),
    'reach',         (select j from reach),
    'suppressed',    (select j from suppressed),
    'market_blasts', (select j from blasts)
  );
$fn$;

revoke all on function public.contact_detail(text) from public, anon, authenticated;
grant execute on function public.contact_detail(text) to service_role;


-- ---------------------------------------------------------------------------------------------
-- PostgREST can only call functions in an exposed schema, and `ticketblaster` is deliberately
-- not one (090). A thin public wrapper is what makes the importer reachable from api/contacts.js
-- without exposing the schema that holds the rows.
create or replace function public.import_contacts(
  p_rows        jsonb,
  p_source_file text default null,
  p_source_kind text default null,
  p_imported_by text default null
) returns table (inserted integer, updated integer, skipped integer)
language sql
security definer
set search_path = public, ticketblaster, pg_temp
as $fn$
  select * from ticketblaster.import_contacts(p_rows, p_source_file, p_source_kind, p_imported_by);
$fn$;

revoke all on function public.import_contacts(jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.import_contacts(jsonb, text, text, text) to service_role;


-- ---------------------------------------------------------------------------------------------
-- TWO-LETTER CODES ONLY, AND ONLY ONES WITH REAL VOLUME. The state column is partly scraped
-- free text: 630 distinct values, of which 500 are full state names, addresses or junk. A
-- dropdown of 630 is not a filter, it is a haystack. Codes matching ^[A-Z]{2}$ with at least 10
-- people give 64 options -- the US states and Canadian provinces that actually appear -- and
-- cover 146,881 of the 161,532 people who carry any state at all.
--
-- THE OTHER 9% ARE NOT LOST, and that is why this is a filter and not an index: the search box
-- queries the full text, so a contact whose state reads "California" is still findable by name,
-- company or address. A filter that silently excluded them would be wrong; one that does not
-- offer a dropdown entry for every malformed value is merely tidy.
create or replace function public.contacts_states()
returns table (state text, n bigint)
language sql
security definer
set search_path = public, pg_temp
as $fn$
  select upper(btrim(state)) as state, count(*)::bigint as n
  from public.contact_directory
  where nullif(btrim(coalesce(state, '')), '') is not null
    and upper(btrim(state)) ~ '^[A-Z]{2}$'
  group by upper(btrim(state))
  having count(*) >= 10
  -- Busiest first: the filter is used to get to a big market, not to browse the alphabet.
  order by count(*) desc, 1;
$fn$;

revoke all on function public.contacts_states() from public, anon, authenticated;
grant execute on function public.contacts_states() to service_role;
