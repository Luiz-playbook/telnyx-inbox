-- 095 — who a blast actually went to.
--
-- THE GAP. Nothing in this system has ever recorded the recipients of a send. campaign_queue
-- keeps phone_count / sms_count / email_count, campaign_send_log keeps recipient_count, and the
-- recipients themselves are resolved live at send time from market_phones / market_emails
-- (api/queue-tick.js) and then discarded. So "who did this blast reach" has no answer, for any
-- blast, ever — which is why Market History can show a recipient roster for CakeMail (CakeMail
-- keeps the list and we ask its API) and nothing at all for SMS.
--
-- This table is that answer, from the day it ships. It cannot be backfilled, because the data
-- was never written down anywhere; see the note on telnyx_messages below for the one partial
-- exception.
--
-- ONE ROW PER RECIPIENT PER BLAST PER CHANNEL. A 12,000-phone blast writes 12,000 rows. That is
-- the right order of magnitude for this database — do_not_contact already holds 724,000 — and
-- the alternative (an array column on the queue row) cannot be joined, indexed or counted, which
-- is most of what the table is for.
--
-- ADDRESS AND ADDRESS_KEY, BOTH. address is what was actually sent to, kept verbatim so the log
-- can be audited against the provider's own record. address_key is the normalised form from
-- sendable_email / norm_phone_e164 — the SAME functions the send path and contact_directory use
-- — so a recipient joins to the directory, to do_not_contact and to the contact that received
-- it. Storing only the raw address would make every one of those joins a per-row function call.
--
-- OUTCOME IS WHAT WE KNOW, NOT WHAT WE HOPE. 'handed_off' means a webhook accepted the payload;
-- it is NOT delivery, and the distinction is the whole subject of GAPS.md gaps 1 and 2. A
-- delivery receipt arriving later can move a row to 'delivered' or 'failed'; until something
-- does that, handed_off is the honest ceiling for the Telnyx path.
--
-- PII, so service_role only: anon and authenticated get no USAGE on the schema at all.

create table if not exists ticketblaster.blast_recipients (
  id            uuid primary key default gen_random_uuid(),

  -- The campaign_queue row this send came from. Nullable because a send recorded from anywhere
  -- else (a backfill, an import) still belongs in the log.
  queue_id      uuid,
  event_id      uuid,
  market_code   text,
  segment       text,

  channel       text not null check (channel in ('sms', 'email')),
  address       text not null,                 -- verbatim, as sent
  address_key   text,                          -- normalised; joins the directory and the DNC list

  sender        text,                          -- the from number / address the row sent as
  provider      text,                          -- telnyx | salesmsg | cakemail | gmail
  outcome       text not null default 'handed_off',
  provider_id   text,                          -- the provider's own message id, where it gives one
  error         text,

  sent_at       timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- A RE-RUN MUST NOT DOUBLE THE LOG. queue-tick can process the same row again after a partial
-- failure, and a recipient list that grew every retry would misreport reach far worse than not
-- logging at all. Partial, because queue_id is nullable and rows without one are not retries.
create unique index if not exists blast_recipients_once_idx
  on ticketblaster.blast_recipients (queue_id, channel, address_key)
  where queue_id is not null and address_key is not null;

create index if not exists blast_recipients_queue_idx   on ticketblaster.blast_recipients (queue_id);
create index if not exists blast_recipients_key_idx     on ticketblaster.blast_recipients (address_key);
-- Market History looks a blast up by where and when it went, because the history rows it lists
-- carry no queue id (nothing in this repo writes ticketblaster_market_blasts_log).
create index if not exists blast_recipients_market_idx  on ticketblaster.blast_recipients (market_code, channel, sent_at desc);

alter table ticketblaster.blast_recipients enable row level security;
revoke all on ticketblaster.blast_recipients from anon, authenticated;
grant all on ticketblaster.blast_recipients to service_role;

comment on table ticketblaster.blast_recipients is
  'One row per recipient per blast. Written by api/queue-tick.js at send time. Cannot be backfilled before 2026-10-06. See migration 095.';


-- ---------------------------------------------------------------------------------------------
-- record_blast_recipients(rows) -> how many were written
--
-- Called once per blast per channel, with the whole recipient list as one array. Ten thousand
-- separate inserts is not a log, it is an outage — the same reasoning as the upsert in the
-- HubSpot sync.
--
-- NOTHING HERE MAY FAIL A SEND. The caller treats this as best-effort and the send has already
-- left the building by the time it runs. Conflicts are swallowed on purpose: a duplicate means
-- the retry case above, which is exactly what the unique index is for.
create or replace function public.record_blast_recipients(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, ticketblaster, pg_temp
as $fn$
declare
  v_n integer;
begin
  with src as (
    select
      nullif(r->>'queue_id',  '')::uuid              as queue_id,
      nullif(r->>'event_id',  '')::uuid              as event_id,
      nullif(btrim(r->>'market_code'), '')           as market_code,
      nullif(btrim(r->>'segment'),     '')           as segment,
      lower(btrim(r->>'channel'))                    as channel,
      btrim(r->>'address')                           as address,
      nullif(btrim(r->>'sender'),      '')           as sender,
      nullif(btrim(r->>'provider'),    '')           as provider,
      coalesce(nullif(btrim(r->>'outcome'), ''), 'handed_off') as outcome,
      nullif(btrim(r->>'provider_id'), '')           as provider_id,
      nullif(btrim(r->>'error'),       '')           as error
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
  ),
  keyed as (
    select *,
           case when channel = 'email' then public.sendable_email(address)
                else public.norm_phone_e164(address) end as address_key
    from src
    where address is not null and address <> '' and channel in ('sms', 'email')
  ),
  -- Deduped within the batch as well as against the table: ON CONFLICT raises "cannot affect row
  -- a second time" if one statement hits the same key twice, and a market list holding the same
  -- number under two organisations is ordinary.
  deduped as (
    select distinct on (queue_id, channel, address_key) * from keyed
    order by queue_id, channel, address_key
  ),
  ins as (
    insert into ticketblaster.blast_recipients
      (queue_id, event_id, market_code, segment, channel, address, address_key,
       sender, provider, outcome, provider_id, error)
    select queue_id, event_id, market_code, segment, channel, address, address_key,
           sender, provider, outcome, provider_id, error
    from deduped
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_n from ins;

  return coalesce(v_n, 0);
end;
$fn$;

revoke all on function public.record_blast_recipients(jsonb) from public, anon, authenticated;
grant execute on function public.record_blast_recipients(jsonb) to service_role;


-- ---------------------------------------------------------------------------------------------
-- SUPERSEDED IN PART BY 097: the telnyx_messages half of this function was removed. Measured
-- across all 11 historic SMS blasts it recovered zero rows, because that table is the two-way
-- inbox and every blast predates its contents. Read 097 before trusting the paragraphs below
-- that describe the merge.
--
-- blast_recipients_for(market, channel, at, message) -> who a Market History row reached
--
-- WHY IT MATCHES ON MARKET AND TIME RATHER THAN AN ID. The rows Market History lists come from
-- ticketblaster_market_blasts_log, salesmsg_broadcasts and CakeMail, and NONE of them carries a
-- campaign_queue id — nothing in this repo even writes the first of those. So a history row and
-- a recipient row can only be tied together by where and when the blast went. The window is
-- generous (±1 day) because blasted_at and sent_at are recorded by different systems.
--
-- TWO SOURCES, AND THE DIFFERENCE IS STATED IN THE OUTPUT. `source` is 'log' for rows this
-- application wrote at send time, and 'telnyx' for rows recovered from telnyx_messages — the
-- two-way inbox, which is the only place any outbound SMS was ever recorded per recipient.
-- telnyx_messages is matched on the message BODY as well as the window, because it holds inbox
-- traffic too and a time window alone would sweep in unrelated conversations. It currently holds
-- 22 rows (11 outbound, to one number), so it recovers very little — but it recovers it honestly,
-- and the UI can say which rows came from where rather than implying a complete roster.
create or replace function public.blast_recipients_for(
  p_market  text,
  p_channel text,
  p_at      timestamptz,
  p_message text default null
) returns table (
  source     text,
  address    text,
  outcome    text,
  provider   text,
  sent_at    timestamptz,
  first_name text,
  last_name  text,
  company    text
)
language sql
security definer
set search_path = public, ticketblaster, pg_temp
as $fn$
  with win as (
    select coalesce(p_at, now()) - interval '1 day' as lo,
           coalesce(p_at, now()) + interval '1 day' as hi
  ),
  logged as (
    select 'log'::text as source, br.address, br.outcome, br.provider, br.sent_at, br.address_key
    from ticketblaster.blast_recipients br, win
    where br.sent_at between win.lo and win.hi
      and (p_channel is null or br.channel = lower(p_channel))
      and (p_market  is null or upper(coalesce(br.market_code, '')) = upper(p_market))
  ),
  from_telnyx as (
    select 'telnyx'::text as source, tm.to_number as address,
           coalesce(tm.status, 'unknown') as outcome, 'telnyx'::text as provider,
           tm.created_at as sent_at,
           public.norm_phone_e164(tm.to_number) as address_key
    from public.telnyx_messages tm, win
    where lower(coalesce(p_channel, 'sms')) = 'sms'
      and tm.direction = 'outbound'
      and tm.created_at between win.lo and win.hi
      -- The body guard. Without it a window alone sweeps in ordinary inbox replies that happen
      -- to share a day with a blast.
      and (p_message is null or btrim(tm.body) = btrim(p_message))
  ),
  merged as (
    select * from logged
    union all
    -- Never twice: a number we logged ourselves is not also reported as a Telnyx recovery.
    select t.* from from_telnyx t
    where not exists (select 1 from logged l where l.address_key is not distinct from t.address_key)
  )
  select m.source, m.address, m.outcome, m.provider, m.sent_at,
         d.first_name, d.last_name, d.company
  from merged m
  -- Names come from the directory, so a roster reads as people rather than as a column of
  -- numbers. A recipient we hold no contact for still appears, with blanks.
  left join public.contact_directory d on d.identity_key = m.address_key
  order by m.sent_at desc, m.address
  limit 2000;
$fn$;

revoke all on function public.blast_recipients_for(text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.blast_recipients_for(text, text, timestamptz, text) to service_role;
