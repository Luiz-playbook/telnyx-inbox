-- 111 — sort the contact list by name, from the server.
--
-- WHY NOT IN THE BROWSER. The Contacts table is paginated at 50 rows against a directory of
-- 256,472. Sorting the rendered page would order those 50 and leave the other 256,422 where they
-- were, so "A–Z" would show whatever happened to be on page 1 of the recency order, alphabetised.
-- That is not a sort, it is a sort-shaped decoration. The ORDER BY has to run before the LIMIT.
-- Sorting the whole table client-side is the other option and it is worse: /api/contacts caps
-- limit at 200, so it is 1,283 round trips and roughly 40 MB of JSON to answer one click.
--
-- WHY A DROP. contacts_browse gains a seventh parameter. `create or replace` cannot add one — it
-- would define a second function, and PostgREST, handed six named arguments that both candidates
-- accept, answers "could not choose the best candidate function". So the six-argument signature
-- goes, inside this transaction, and the seven-argument one takes its place. Nothing calls it
-- positionally (api/contacts.js passes p_* by name), so the drop is invisible to callers.
--
-- The route tolerates this migration NOT having been applied: it omits p_sort for the default
-- order, and on PGRST202 for a name sort it retries without and returns sort_available: false.
-- So the tab keeps working either way; only the name sort needs this file.
--
-- WHY THE SORT KEY IS BUILT, NOT A COLUMN. The Name column renders
-- [first_name, last_name].filter(Boolean).join(' '), so sorting on first_name alone would
-- disagree with what is on screen for every row missing a first name. The key is the displayed
-- string, lowercased so 'alvarez' does not sort after 'Zuniga', and NULLIF'd so the 113,678
-- nameless rows — 44% of the directory: phone-only imports, HubSpot records with no name set —
-- collapse to NULL and land at the END of both directions rather than filling A–Z page 1 with
-- blanks.
--
-- LATIN NAMES FIRST, IN BOTH DIRECTIONS. This database is en_US.UTF-8, and under that collation
-- Hangul and CJK sort AHEAD of the Latin alphabet. Measured: plain `order by <name> asc` opened
-- A–Z with 이석식, 정선영, 박수용 and three rows whose entire name is "-". 123 rows start with
-- something other than a Latin letter, which at 50 a page is the first two and a half pages
-- before "Aaron" — an operator clicking A–Z would reasonably conclude the sort was broken. So a
-- boolean term leads the ORDER BY and is DESC in both directions, which makes Z–A open at
-- 'Zzz Zamora' rather than being a strict reverse of A–Z. That is the intent: non-Latin and
-- nameless rows are a tail at the end of either ordering, reachable by paging, never the first
-- thing a sort shows.
--
-- p_sort IS WHITELISTED, NOT INTERPOLATED. This function builds its WHERE with format() and
-- quote_literal, and an ORDER BY cannot be parameterised. So p_sort selects a FIXED string from a
-- CASE below; the caller's text never reaches the SQL. An unknown value raises, matching how
-- p_source and p_presence already refuse what they do not recognise — a silently ignored sort
-- would read as "the data is in this order", which is the one lie this whole change is avoiding.
--
-- MEASURED before committing, on 256,472 rows:
--   order by updated_at desc (today's default)   68 ms, top-N heapsort over a parallel seq scan
--   order by the name key                       198 ms, same plan shape
--   + the Latin-first term                      265 ms, same plan shape, 31 kB sort memory
-- None of the three has a supporting index and none needs one at this size; the name sort is the
-- same shape of work the default has always done.

drop function if exists public.contacts_browse(text, text, text, text, integer, integer);

create or replace function public.contacts_browse(
  p_source   text    default 'all',      -- all | hubspot | intel | imported
  p_q        text    default null,
  p_state    text    default null,
  p_presence text    default null,       -- not_intel | hubspot_and_intel | hubspot_only | intel_only
  p_limit    integer default 50,
  p_offset   integer default 0,
  p_sort     text    default null        -- recent (default) | name_asc | name_desc
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
  -- The displayed name, as the table renders it. Named once and reused by both directions so
  -- A–Z and Z–A cannot drift into two nearly-identical expressions.
  c_name  constant text := $$nullif(btrim(lower(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))), '')$$;
  c_latin constant text := '(' || c_name || ' ~ ''^[a-z]'') desc nulls last';
  v_where text := 'true';
  v_order text;
  v_q     text := nullif(btrim(coalesce(p_q, '')), '');
  v_state text := nullif(btrim(upper(coalesce(p_state, ''))), '');
  v_lim   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
begin
  if    p_source in ('all', '')      or p_source is null then null;
  elsif p_source = 'hubspot'  then v_where := v_where || ' and in_hubspot';
  elsif p_source = 'intel'    then v_where := v_where || ' and in_intel';
  elsif p_source = 'imported' then v_where := v_where || ' and in_imported';
  else raise exception 'unknown contact source: %', p_source;
  end if;

  if    p_presence in ('', 'any') or p_presence is null then null;
  -- The one the checkbox sends. Deliberately NOT "hubspot_only": it is about reachability, so it
  -- means the same thing on every tab rather than quietly implying a source.
  elsif p_presence = 'not_intel'         then v_where := v_where || ' and not in_intel';
  elsif p_presence = 'hubspot_and_intel' then v_where := v_where || ' and in_hubspot and in_intel';
  elsif p_presence = 'hubspot_only'      then v_where := v_where || ' and in_hubspot and not in_intel';
  elsif p_presence = 'intel_only'        then v_where := v_where || ' and in_intel and not in_hubspot';
  else raise exception 'unknown presence filter: %', p_presence;
  end if;

  -- identity_key breaks every tie. It is unique, so each ORDER BY here is TOTAL — without it the
  -- 113,678 nameless rows are mutually equal and Postgres may arrange them differently per page,
  -- which paginates as some rows appearing twice and others never appearing at all.
  if    p_sort in ('', 'recent') or p_sort is null then
    v_order := 'updated_at desc nulls last, identity_key';
  elsif p_sort = 'name_asc'  then
    v_order := c_latin || ', ' || c_name || ' asc nulls last, identity_key';
  elsif p_sort = 'name_desc' then
    v_order := c_latin || ', ' || c_name || ' desc nulls last, identity_key';
  else raise exception 'unknown contact sort: %', p_sort;
  end if;

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
      order by %s
      limit %s offset %s',
    v_total::bigint, v_where, v_order, v_lim::integer, v_off::integer
  );
end;
$fn$;

revoke all on function public.contacts_browse(text, text, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.contacts_browse(text, text, text, text, integer, integer, text) to service_role;
