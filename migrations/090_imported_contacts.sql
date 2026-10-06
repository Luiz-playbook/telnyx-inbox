-- 090 — a contact list Cole can upload himself.
--
-- WHY THIS TABLE EXISTS. The app had no way to add a contact. The only two uploads it has ever
-- had are the do-not-contact list (085) and the /lookup line-type checker, and both of those
-- READ a file to do something else with it — neither adds a person anyone can message. So a
-- lead that arrived by spreadsheet could not enter the audience at all, which is the gap Josh
-- described as "lists should match HubSpot one to one and be exhaustive, with lead uploads".
--
-- WHY `ticketblaster` AND NOT `public`. This is a third source of contacts sitting beside two
-- that already disagree with each other: public.contact_intel (264k rows, scraped) and
-- hubspot.hubspot_contacts (86k rows, mirrored, and only 1.8% overlapping). Uploaded rows are
-- neither — they are this app's own data, typed by a person — so they get their own home rather
-- than being mixed into a table something else owns and rebuilds. hubspot.* set the precedent.
--
-- NOT IN THE SEND PATH YET, DELIBERATELY. market_contacts is rebuilt from contact_intel +
-- company_intel by refresh_market_contacts() (050), and nothing here changes that. Wiring a new
-- source into the thing that decides who gets texted is a separate, louder decision than adding
-- a place to put the rows — and doing both in one migration would mean the first upload silently
-- enlarged every audience in the app. Imported contacts are visible and searchable immediately;
-- making them sendable is the follow-up.
--
-- NORMALISATION IS THE SEND PATH'S, NOT ITS OWN. email_key and phone_e164 are filled by
-- public.sendable_email / public.norm_phone_e164 — the SAME functions suppress_contacts (085)
-- and the send path use. A list that normalised differently would dedupe differently, and would
-- fail to match the do-not-contact entries meant to protect the very people on it.
--
-- PII. Real names, addresses and numbers. service_role only: anon and authenticated get no
-- USAGE on the schema at all, so PostgREST cannot reach the table to be filtered in the first
-- place. Reads go through api/contacts.js, which holds the service key.

create schema if not exists ticketblaster;
grant usage on schema ticketblaster to service_role;

create table if not exists ticketblaster.imported_contacts (
  id           uuid primary key default gen_random_uuid(),
  first_name   text,
  last_name    text,
  email        text,
  phone        text,

  -- The normalised forms, written by import_contacts() below and never by hand. Kept as columns
  -- rather than recomputed per query because they are what the unique index is built on.
  email_key    text,
  phone_e164   text,

  -- Provenance. "Why is this person in the database" is asked months later, and
  -- "cole-leads-oct.xlsx, uploaded by cole@" is the whole answer.
  source_file  text,
  source_kind  text,                                   -- csv | excel | google_sheet
  imported_by  text,
  imported_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- ONE IDENTITY PER PERSON, WHICHEVER HALF WE HAVE. A row may carry an email, a phone, or
  -- both, so neither column alone can be unique. Generated and stored so the unique index is
  -- over exactly what the upsert conflicts on — computing it in the RPC instead would let a
  -- direct insert bypass the dedupe.
  dedupe_key   text generated always as (coalesce(email_key, '') || '|' || coalesce(phone_e164, '')) stored
);

create unique index if not exists imported_contacts_dedupe_idx on ticketblaster.imported_contacts (dedupe_key);
create index if not exists imported_contacts_email_idx   on ticketblaster.imported_contacts (email_key);
create index if not exists imported_contacts_phone_idx   on ticketblaster.imported_contacts (phone_e164);
create index if not exists imported_contacts_imported_idx on ticketblaster.imported_contacts (imported_at desc);
-- The Contacts tab searches name/email/phone as you type. Without this it is a sequential scan
-- per keystroke; the tab debounces, but the debounce is not the index.
create index if not exists imported_contacts_search_idx on ticketblaster.imported_contacts
  using gin (lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(email,'') || ' ' || coalesce(phone,'')) gin_trgm_ops);

alter table ticketblaster.imported_contacts enable row level security;
revoke all on ticketblaster.imported_contacts from anon, authenticated;
grant all on ticketblaster.imported_contacts to service_role;

comment on table ticketblaster.imported_contacts is
  'Contacts uploaded by hand from a CSV, Excel file or public Google Sheet. Not part of the send audience — see migration 090.';

-- ---------------------------------------------------------------------------------------------
-- import_contacts(rows, source_file, source_kind, imported_by) -> (inserted, updated, skipped)
--
-- Called by api/contacts.js once per batch. The route holds the service key and authenticates
-- the caller; this function does the normalising, the deduping and the counting, for the same
-- reason suppress_contacts does: the browser must never decide what a row normalises to, or an
-- upload would dedupe differently from the send path that has to match it later.
--
-- DEDUPED TWICE, AND BOTH ARE NEEDED. `distinct on` collapses repeats WITHIN the batch, because
-- ON CONFLICT DO UPDATE raises "cannot affect row a second time" if one statement hits the same
-- key twice — and a spreadsheet listing a person on two lines is the normal case, not the odd
-- one. ON CONFLICT then collapses against rows already stored from an earlier upload.
--
-- A ROW WITH NEITHER AN EMAIL NOR A PHONE IS SKIPPED, NOT REJECTED. Spreadsheets carry blank
-- lines, totals rows and section headers. Counting them and carrying on is right; failing the
-- whole file because row 4,812 was a subtotal is not.
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
      public.sendable_email(r->>'email')  as email_key,
      public.norm_phone_e164(r->>'phone') as phone_e164
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
  ),
  usable as (
    -- Only rows we could actually reach someone with. sendable_email returns null for an
    -- address the send path would refuse, so a typo'd address is skipped here too rather than
    -- stored as a contact that can never be mailed.
    select * from src where email_key is not null or phone_e164 is not null
  ),
  deduped as (
    select distinct on (coalesce(email_key, '') || '|' || coalesce(phone_e164, '')) *
    from usable
    -- Last writer wins within a file: later rows in a spreadsheet are usually the corrections.
    order by coalesce(email_key, '') || '|' || coalesce(phone_e164, ''), first_name nulls last
  ),
  up as (
    insert into ticketblaster.imported_contacts
      (first_name, last_name, email, phone, email_key, phone_e164, source_file, source_kind, imported_by)
    select first_name, last_name, email, phone, email_key, phone_e164,
           p_source_file, p_source_kind, p_imported_by
    from deduped
    on conflict (dedupe_key) do update set
      -- COALESCE THE OTHER WAY ROUND ON PURPOSE: a re-upload fills blanks but does not erase a
      -- name we already had with an empty cell. Re-importing a thinner export of the same list
      -- should not strip detail off rows that were complete.
      first_name  = coalesce(excluded.first_name, imported_contacts.first_name),
      last_name   = coalesce(excluded.last_name,  imported_contacts.last_name),
      email       = coalesce(excluded.email,      imported_contacts.email),
      phone       = coalesce(excluded.phone,      imported_contacts.phone),
      email_key   = coalesce(excluded.email_key,  imported_contacts.email_key),
      phone_e164  = coalesce(excluded.phone_e164, imported_contacts.phone_e164),
      source_file = coalesce(excluded.source_file, imported_contacts.source_file),
      source_kind = coalesce(excluded.source_kind, imported_contacts.source_kind),
      imported_by = coalesce(excluded.imported_by, imported_contacts.imported_by),
      updated_at  = now()
    -- xmax = 0 is true only for a row this statement actually inserted, which is the only way
    -- to tell "added" from "already had it" in a single upsert.
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert)::integer,
    count(*) filter (where not was_insert)::integer,
    -- Everything the batch carried that did not end up as a row: no identifier, unusable
    -- address, or a duplicate of another line in the same file.
    (v_total - count(*))::integer
  from up;
end;
$$;

revoke all on function ticketblaster.import_contacts(jsonb, text, text, text) from public, anon, authenticated;
grant execute on function ticketblaster.import_contacts(jsonb, text, text, text) to service_role;
