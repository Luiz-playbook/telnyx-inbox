-- 100 — a state on uploaded contacts, so they can belong to a market.
--
-- WHY. A blast goes to a MARKET: "Illinois", "Toronto". The upload format was First Name, Last
-- Name, Email, Phone Number and carried no location at all, so an uploaded contact could never
-- be targeted by anything — the rows were searchable in the Contacts tab and invisible to every
-- send. That is the one thing stopping uploads being useful rather than merely stored.
--
-- NORMALISED THROUGH public.state_alias AND THEN public.geo_region. refresh_market_contacts() joins
-- scraped contacts to markets through it (`state_alias sa on sa.alias = upper(btrim(ci.state))`),
-- and it holds 103 aliases covering both forms: CALIFORNIA -> CA and CA -> CA. Reusing it means
-- an uploaded "California" lands in exactly the market a scraped "California" does. A second
-- normaliser here would be a second opinion that drifts.
--
-- TWO COLUMNS, RAW AND RESOLVED, for the same reason the table already keeps email beside
-- email_key: `state` is what the spreadsheet said, kept verbatim so a row can be audited against
-- its source, and `state_code` is what it resolved to. An unrecognised value keeps its raw text
-- and resolves to null, which is visible as "no market" rather than silently dropped — a
-- spreadsheet full of "Calif." should be a question, not a quiet 0.
--
-- STILL NOT IN THE SEND AUDIENCE. market_contacts is rebuilt from contact_intel + company_intel
-- by refresh_market_contacts(); nothing here changes that, so an uploaded contact with a state
-- is targetABLE, not yet targeted. Wiring a third source into the thing that decides who gets
-- texted stays a separate, louder decision.

alter table ticketblaster.imported_contacts add column if not exists state      text;
alter table ticketblaster.imported_contacts add column if not exists state_code text;

create index if not exists imported_contacts_state_idx
  on ticketblaster.imported_contacts (state_code) where state_code is not null;

comment on column ticketblaster.imported_contacts.state is
  'The location column as the spreadsheet wrote it, verbatim. See migration 100.';
comment on column ticketblaster.imported_contacts.state_code is
  'state resolved through public.state_alias to a market code, or null when it matched nothing.';


-- ---------------------------------------------------------------------------------------------
-- The importer now carries it. Signature is unchanged: p_rows is jsonb, so a new field per row
-- needs no new argument and api/contacts.js keeps calling it the same way.
create or replace function ticketblaster.import_contacts(
  p_rows        jsonb,
  p_source_file text default null,
  p_source_kind text default null,
  p_imported_by text default null
) returns table (inserted integer, updated integer, skipped integer)
language plpgsql
security definer
set search_path = ticketblaster, public, pg_temp
as $$
declare
  v_total integer;
begin
  v_total := coalesce(jsonb_array_length(p_rows), 0);

  return query
  with src as (
    select
      nullif(btrim(r->>'first_name'), '') as first_name,
      nullif(btrim(r->>'last_name'),  '') as last_name,
      nullif(btrim(r->>'email'),      '') as email,
      nullif(btrim(r->>'phone'),      '') as phone,
      nullif(btrim(r->>'state'),      '') as state,
      public.sendable_email(r->>'email')  as email_key,
      public.norm_phone_e164(r->>'phone') as phone_e164,
      -- TWO LOOKUPS, BECAUSE ONE IS NOT ENOUGH. state_alias is what refresh_market_contacts()
      -- joins through, so it comes first and uploaded contacts resolve exactly as scraped ones
      -- do. But it holds 103 aliases and ALL of them are US: "Ontario" resolved to null, and
      -- Toronto is a live market that has been blasted. geo_region is the table Offers and the
      -- Queue already build their own market lists from, and it carries Canada, so it is the
      -- fallback — matched on the code and then on the full name, since a spreadsheet may say
      -- either. No match still leaves state_code null with the raw text intact.
      coalesce(
        (select sa.code from public.state_alias sa
          where sa.alias = upper(btrim(coalesce(r->>'state', ''))) limit 1),
        (select g.code from public.geo_region g
          where upper(g.code) = upper(btrim(coalesce(r->>'state', ''))) limit 1),
        (select g.code from public.geo_region g
          where upper(g.name) = upper(btrim(coalesce(r->>'state', ''))) limit 1)
      ) as state_code
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
  ),
  usable as (
    select * from src where email_key is not null or phone_e164 is not null
  ),
  deduped as (
    select distinct on (coalesce(email_key, '') || '|' || coalesce(phone_e164, '')) *
    from usable
    order by coalesce(email_key, '') || '|' || coalesce(phone_e164, ''), first_name nulls last
  ),
  up as (
    insert into ticketblaster.imported_contacts
      (first_name, last_name, email, phone, email_key, phone_e164, state, state_code,
       source_file, source_kind, imported_by)
    select first_name, last_name, email, phone, email_key, phone_e164, state, state_code,
           p_source_file, p_source_kind, p_imported_by
    from deduped
    on conflict (dedupe_key) do update set
      first_name  = coalesce(excluded.first_name, imported_contacts.first_name),
      last_name   = coalesce(excluded.last_name,  imported_contacts.last_name),
      email       = coalesce(excluded.email,      imported_contacts.email),
      phone       = coalesce(excluded.phone,      imported_contacts.phone),
      email_key   = coalesce(excluded.email_key,  imported_contacts.email_key),
      phone_e164  = coalesce(excluded.phone_e164, imported_contacts.phone_e164),
      -- Same rule as the rest: a re-upload fills a blank, it does not erase a state we already
      -- had with an empty cell.
      state       = coalesce(excluded.state,       imported_contacts.state),
      state_code  = coalesce(excluded.state_code,  imported_contacts.state_code),
      source_file = coalesce(excluded.source_file, imported_contacts.source_file),
      source_kind = coalesce(excluded.source_kind, imported_contacts.source_kind),
      imported_by = coalesce(excluded.imported_by, imported_contacts.imported_by),
      updated_at  = now()
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert)::integer,
    count(*) filter (where not was_insert)::integer,
    (v_total - count(*))::integer
  from up;
end;
$$;

revoke all on function ticketblaster.import_contacts(jsonb, text, text, text) from public, anon, authenticated;
grant execute on function ticketblaster.import_contacts(jsonb, text, text, text) to service_role;


-- ---------------------------------------------------------------------------------------------
-- NOT DONE HERE: contact_directory still reads `null::text as state` for uploaded rows (091/093),
-- so an uploaded contact's state will not appear in the Contacts tab or its state filter until
-- the matview is rebuilt to select it. That needs a DROP, which cannot be issued from the
-- migration tooling used here — the statement is in migrations/093b_RUN_BY_HAND.sql.
