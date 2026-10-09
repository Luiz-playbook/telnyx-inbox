-- 094 — a filter that composes, and edit/delete for the rows we own.
--
-- PART 1: `not_intel`.
--
-- The Contacts tab shipped with two controls answering overlapping questions: source tabs
-- (All / HubSpot / Contact Intel / Self Import) and a presence dropdown (In HubSpot and Intel /
-- In HubSpot only / In Intel only). Picking "HubSpot" in one and "In Intel only" in the other is
-- a contradiction the UI accepted and silently returned nothing for.
--
-- The dropdown is gone from the UI. What it was actually FOR — "show me the people no blast can
-- reach", the 77,993 — becomes one checkbox, and this is the filter behind it. It asks a
-- different question from the tabs (reachability, not provenance) so the two COMPOSE: HubSpot +
-- not_intel is the 77,993, All + not_intel is everyone unreachable from any source.
--
-- The three old values stay accepted. Nothing in the UI sends them any more, but a saved link or
-- a bookmarked query that does should keep working rather than raising "unknown presence
-- filter".

create or replace function public.contacts_browse(
  p_source   text    default 'all',      -- all | hubspot | intel | imported
  p_q        text    default null,
  p_state    text    default null,
  p_presence text    default null,       -- not_intel | hubspot_and_intel | hubspot_only | intel_only
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
      order by updated_at desc nulls last, identity_key
      limit %s offset %s',
    v_total::bigint, v_where, v_lim::integer, v_off::integer
  );
end;
$fn$;

revoke all on function public.contacts_browse(text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.contacts_browse(text, text, text, text, integer, integer) to service_role;


-- ---------------------------------------------------------------------------------------------
-- PART 2: edit and delete, for uploaded contacts ONLY.
--
-- WHY ONLY THOSE. ticketblaster.imported_contacts is the one contact table this application
-- owns. contact_intel is rebuilt by a scrape and hubspot.hubspot_contacts is a mirror whose
-- upstream is HubSpot — editing either here would be writing to something that overwrites itself
-- on the next sync, so the edit would appear to work and then vanish. That is worse than having
-- no button. A correction to a HubSpot contact belongs in HubSpot.
--
-- BOTH TAKE THE ROW id, NOT THE DIRECTORY'S identity_key. identity_key is
-- coalesce(email_key, phone_e164), so two uploaded rows sharing an address but carrying
-- different numbers collapse to one key — deleting by it could remove a row nobody pointed at.
-- The ids come from contact_detail, which returns every uploaded row unmerged.

create or replace function public.update_imported_contact(
  p_id         uuid,
  p_first_name text default null,
  p_last_name  text default null,
  p_email      text default null,
  p_phone      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, ticketblaster, pg_temp
as $fn$
declare
  v_email_key  text := public.sendable_email(nullif(btrim(p_email), ''));
  v_phone_e164 text := public.norm_phone_e164(nullif(btrim(p_phone), ''));
  v_row        ticketblaster.imported_contacts;
begin
  -- A row that identifies nobody cannot be stored: it would key as null and disappear from the
  -- directory while still occupying the table. Refused loudly rather than saved into limbo.
  if v_email_key is null and v_phone_e164 is null then
    raise exception 'a contact needs a usable email address or phone number';
  end if;

  update ticketblaster.imported_contacts set
    first_name = nullif(btrim(p_first_name), ''),
    last_name  = nullif(btrim(p_last_name),  ''),
    email      = nullif(btrim(p_email),      ''),
    phone      = nullif(btrim(p_phone),      ''),
    email_key  = v_email_key,
    phone_e164 = v_phone_e164,
    updated_at = now()
  where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'that uploaded contact no longer exists';
  end if;

  return to_jsonb(v_row);
exception
  -- dedupe_key is unique, so editing one row onto another's identity is a conflict. Say which
  -- rule was broken; "duplicate key value violates unique constraint" is not an answer anyone
  -- can act on.
  when unique_violation then
    raise exception 'another uploaded contact already has that email address and phone number';
end;
$fn$;

revoke all on function public.update_imported_contact(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_imported_contact(uuid, text, text, text, text) to service_role;


create or replace function public.delete_imported_contact(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, ticketblaster, pg_temp
as $fn$
declare
  v_row ticketblaster.imported_contacts;
begin
  delete from ticketblaster.imported_contacts where id = p_id returning * into v_row;
  if not found then
    raise exception 'that uploaded contact no longer exists';
  end if;
  -- Returned so the caller can say WHO was removed rather than "deleted." A confirmation that
  -- cannot name what it deleted is not a confirmation.
  return to_jsonb(v_row);
end;
$fn$;

revoke all on function public.delete_imported_contact(uuid) from public, anon, authenticated;
grant execute on function public.delete_imported_contact(uuid) to service_role;
