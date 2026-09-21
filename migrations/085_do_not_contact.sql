-- 085: the do-not-contact list.
--
-- WHAT THIS IS FOR
--
-- People who have asked not to be contacted, held in one place so a blast can be checked against
-- them. Sheets of these exist today and live nowhere the system can see.
--
-- THE SEND PATH DOES NOT READ THIS YET, and that is deliberate rather than an oversight. This
-- migration builds the list and the way in; enforcing it changes who every blast reaches, which
-- is a bigger change than a new table and deserves its own migration, its own moment, and a
-- verified before/after. See the closing note.
--
-- A LIST THAT IS LOADED BUT NOT ENFORCED IS NOT NEUTRAL. It is evidence that you knew. So the
-- gap between this and the enforcement should be short, and the README in suppression/ says the
-- same thing rather than leaving it to be discovered.

create table if not exists public.do_not_contact (
  id uuid primary key default gen_random_uuid(),

  -- WHO. Both nullable, at least one required (the check below). Most rows will carry one: a
  -- sheet of email opt-outs has no phone numbers, and a verbal "stop texting me" has no address.
  --
  -- STORED NORMALISED, through the SAME functions the send path uses — norm_phone_e164 and the
  -- lower/trim of sendable_email, migrations 073 and 082. This is the whole ballgame: a
  -- suppression list that normalises differently from the send fails to match the very people it
  -- exists to protect, and fails silently. '(615) 555-0142' and '+16155550142' must be one entry
  -- because the send resolves them to one number.
  email text,
  phone text,

  -- Context, so a future reader can tell a legal opt-out from an internal "don't bother these".
  -- None of it is required: a bare address with no story is still a person not to contact.
  full_name text,
  organization text,
  reason text,

  -- WHICH CHANNEL. Null means every channel, and is the default — someone who says "stop"
  -- usually means stop, not "stop texting but keep emailing". Per-channel exists because the
  -- distinction is real when it is real (an email unsubscribe is not an SMS opt-out), not
  -- because it should be the common case.
  channel text check (channel is null or channel in ('email', 'sms')),

  -- PERMANENT BY DEFAULT. Null = forever, which is what an opt-out means unless someone says
  -- otherwise. The column exists because "we are not sure yet whether this is permanent" was the
  -- state when this was asked for, and a temporary suppression is far easier to express now than
  -- to retrofit once the table is full.
  expires_at timestamptz,

  -- WHERE IT CAME FROM. The filename and the import run, so a bad sheet can be found and undone
  -- without guessing. Without this, one mistaken import is indistinguishable from months of
  -- genuine opt-outs.
  source text,
  source_file text,
  imported_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A row that identifies nobody suppresses nobody. Rejected at the door rather than stored as
  -- a blank that quietly matches nothing forever.
  constraint do_not_contact_has_identifier check (email is not null or phone is not null)
);

comment on table public.do_not_contact is
  'People not to contact. Values are stored normalised the same way the send path normalises '
  'them, or matching would fail silently. NOT YET READ BY THE SEND PATH — migration 085 builds '
  'the list; enforcing it is a separate change.';

-- ---------------------------------------------------------------------------
-- One entry per person per channel.
--
-- Partial unique indexes rather than a plain unique constraint, because NULL is not equal to
-- itself in Postgres: a plain UNIQUE (email, channel) would happily accept the same address a
-- hundred times as long as channel stayed null, which is the common case.
--
-- coalesce(channel, 'all') collapses that: one row per (email, channel) where "no channel" is
-- itself a value. This is also what lets the importer upsert — re-running a file updates rather
-- than duplicates.
-- ---------------------------------------------------------------------------
create unique index if not exists do_not_contact_email_key
  on public.do_not_contact (email, coalesce(channel, 'all')) where email is not null;

create unique index if not exists do_not_contact_phone_key
  on public.do_not_contact (phone, coalesce(channel, 'all')) where phone is not null;

-- The lookups the enforcement will make: "is this address on the list", "is this number".
create index if not exists do_not_contact_email_idx on public.do_not_contact (email) where email is not null;
create index if not exists do_not_contact_phone_idx on public.do_not_contact (phone) where phone is not null;

alter table public.do_not_contact enable row level security;

-- RLS with no policy returns zero rows to the anon key — a trap this codebase has hit before,
-- and one that would be particularly bad here: a suppression check that silently returns nothing
-- suppresses nobody. Read is open to the signed-in app so a future UI can show the list.
-- Writing stays server-side: nothing in a browser should be able to add or, more importantly,
-- REMOVE someone from a do-not-contact list.
drop policy if exists do_not_contact_read on public.do_not_contact;
create policy do_not_contact_read on public.do_not_contact
  for select to anon, authenticated using (true);

grant select on public.do_not_contact to anon, authenticated;
grant all    on public.do_not_contact to service_role;

-- ---------------------------------------------------------------------------
-- The import, as one call.
--
-- Takes the rows as jsonb and normalises INSIDE the database, so the importer script cannot
-- normalise differently from the send path by accident — there is one implementation of "what
-- this phone number really is" and everything goes through it.
--
-- SET-BASED, NOT ROW-BY-ROW, and that is not premature optimisation. The first list to arrive is
-- 496,063 rows; a plpgsql loop doing a SELECT and an INSERT per identifier would be roughly a
-- million statements, which is hours and a statement timeout somewhere in the middle. Two
-- INSERT ... ON CONFLICT statements per batch is the same work in seconds.
--
-- DEDUPED WITHIN THE BATCH by the DISTINCT ON. Postgres refuses ON CONFLICT DO UPDATE if one
-- statement would touch the same row twice — "cannot affect row a second time" — and an export
-- of half a million contacts certainly repeats an address. Without this the whole batch fails,
-- not the duplicate row.
--
-- Upserts; deliberately never deletes. Removing someone from this list should not be a side
-- effect of importing a smaller sheet.
-- ---------------------------------------------------------------------------
create or replace function public.suppress_contacts(p_rows jsonb, p_source_file text default null)
returns table (inserted int, updated int, skipped int)
language sql
volatile
security definer
set search_path to 'public'
as $function$
  with src as (
    -- The same normalisation the send uses. sendable_* return NULL for anything unusable, so a
    -- malformed address or an undiallable number is dropped here rather than stored as an entry
    -- that can never match anything.
    select public.sendable_email(x->>'email')                       as email,
           public.sendable_phone(x->>'phone')                       as phone,
           nullif(btrim(coalesce(x->>'full_name','')), '')          as full_name,
           nullif(btrim(coalesce(x->>'organization','')), '')       as organization,
           nullif(btrim(coalesce(x->>'reason','')), '')             as reason,
           case when lower(btrim(coalesce(x->>'channel',''))) in ('email','sms')
                then lower(btrim(x->>'channel')) end                as channel,
           nullif(btrim(coalesce(x->>'source','')), '')             as source
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
  ),
  -- One row per identifier. A record carrying both an email and a phone becomes TWO entries,
  -- because the send checks one or the other and a combined row would only ever match half the
  -- time. Name, organisation and reason ride along on both, so the context is not lost.
  em as (
    select distinct on (email, coalesce(channel,'all'))
           email, full_name, organization, reason, channel, source
    from src where email is not null
    order by email, coalesce(channel,'all')
  ),
  ph as (
    select distinct on (phone, coalesce(channel,'all'))
           phone, full_name, organization, reason, channel, source
    from src where phone is not null
    order by phone, coalesce(channel,'all')
  ),
  -- xmax = 0 is true only for a freshly inserted row, which is how an upsert tells "added" from
  -- "already knew about this one". Worth having: on a re-import the difference between 0 added
  -- and 400,000 added is the difference between "ran twice" and "something is wrong".
  ie as (
    insert into public.do_not_contact (email, full_name, organization, reason, channel, source, source_file)
    select email, full_name, organization, reason, channel, source, p_source_file from em
    on conflict (email, coalesce(channel,'all')) where email is not null
    do update set full_name    = coalesce(excluded.full_name,    do_not_contact.full_name),
                  organization = coalesce(excluded.organization, do_not_contact.organization),
                  reason       = coalesce(excluded.reason,       do_not_contact.reason),
                  source_file  = excluded.source_file,
                  updated_at   = now()
    returning (xmax = 0) as was_new
  ),
  ip as (
    insert into public.do_not_contact (phone, full_name, organization, reason, channel, source, source_file)
    select phone, full_name, organization, reason, channel, source, p_source_file from ph
    on conflict (phone, coalesce(channel,'all')) where phone is not null
    do update set full_name    = coalesce(excluded.full_name,    do_not_contact.full_name),
                  organization = coalesce(excluded.organization, do_not_contact.organization),
                  reason       = coalesce(excluded.reason,       do_not_contact.reason),
                  source_file  = excluded.source_file,
                  updated_at   = now()
    returning (xmax = 0) as was_new
  )
  select (select count(*) from ie where was_new)::int
         + (select count(*) from ip where was_new)::int,
         (select count(*) from ie where not was_new)::int
         + (select count(*) from ip where not was_new)::int,
         -- Rows that identified nobody once cleaned: no usable address and no dialable number.
         (select count(*) from src where email is null and phone is null)::int;
$function$;

comment on function public.suppress_contacts(jsonb, text) is
  'Bulk-load do-not-contact records. Normalises inside the database through sendable_email/'
  'sendable_phone so an importer cannot normalise differently from the send path. Set-based and '
  'deduped per batch — the first list is half a million rows. Upserts; never deletes, because '
  'removing someone should not be a side effect of importing a smaller sheet. Migration 085.';

revoke execute on function public.suppress_contacts(jsonb, text) from public, anon;
grant  execute on function public.suppress_contacts(jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- WHAT COMES NEXT, and why it is not here.
--
-- Enforcement means market_phones and market_emails excluding anyone on this list, so every
-- blast, the cron and Send now alike, resolves an audience that already has them removed. That
-- is the only place worth doing it: one gate the whole product passes through, rather than a
-- check each caller has to remember.
--
-- It is a separate migration because it CHANGES WHO EVERY BLAST REACHES. It should be applied
-- with the list already loaded, the before/after counts compared, and someone watching — not
-- bundled into the migration that merely creates the table.
-- ---------------------------------------------------------------------------
