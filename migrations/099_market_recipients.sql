-- 099 — who a market blast would actually reach, with the reasons it might not.
--
-- NOT COMMITTED TO THE DEPLOY BRANCHES YET. The Offers-side UI that uses this is local-only at
-- the time of writing; the function is additive and nothing deployed calls it.
--
-- WHY THIS EXISTS. The Offers tab shows a reach NUMBER per market and segment and nothing
-- behind it. "2,684 emails" is the figure an operator decides to send on, and until now the only
-- way to see who those 2,684 were was to send to them. This returns the list, with the facts
-- that decide whether each row is really reachable.
--
-- IT AGREES WITH THE SEND PATH BY CONSTRUCTION. Suppression is public.is_suppressed(), the same
-- function market_emails/market_phones call (086), rather than a second query against
-- do_not_contact that could drift from it. Identity is sendable_email/norm_phone_e164, the same
-- pair contact_directory and the importer use. If this screen and the send ever disagree, it is
-- a bug in one function, not in two different ideas of who a person is.
--
-- THE DUPLICATE COLUMN IS THE POINT, not decoration. market_contacts holds one row per CONTACT
-- ROW, not per person: the same address appears under several organisations, and
-- market_emails() does not deduplicate — api/queue-tick.js collapses it with a Set at send time.
-- So a market reporting 2,684 emails may send to meaningfully fewer people, and nothing has ever
-- said so. dupe_in_market makes that visible per row and lets the UI total it.
--
-- other_markets ANSWERS "HAVE WE ALREADY GOT THEM SOMEWHERE ELSE". A contact reachable under two
-- market codes gets two blasts from two campaigns that each believe they are the only one.
--
-- last_blasted_at IS THIN ON PURPOSE, AND WILL BE EMPTY AT FIRST. It reads
-- ticketblaster.blast_recipients (095), which only started being written on 2026-10-06. Before
-- that nothing recorded a recipient, so an empty value means "never recorded", not "never
-- contacted" — the UI has to say so, exactly as the Market History roster does.

create or replace function public.market_recipients(
  p_code    text,
  p_segment text    default null,
  p_q       text    default null,
  p_limit   integer default 100,
  p_offset  integer default 0
) returns table (
  total             bigint,
  identity_key      text,
  contact_name      text,
  organization_name text,
  city              text,
  email             text,
  phone             text,
  suppressed_email  boolean,
  suppressed_phone  boolean,
  dupe_in_market    integer,
  other_markets     text[],
  last_blasted_at   timestamptz,
  blast_count       integer
)
language sql
stable
security definer
set search_path = public, ticketblaster, pg_temp
as $fn$
  with me as (
    select mc.*,
           coalesce(public.sendable_email(mc.email), public.norm_phone_e164(mc.phone)) as ident
    from public.market_contacts mc
    where mc.code = upper(btrim(p_code))
      and (p_segment is null or p_segment = '' or coalesce(mc.segment, 'Other') = p_segment)
  ),
  filtered as (
    select * from me
    where nullif(btrim(coalesce(p_q, '')), '') is null
       or lower(concat_ws(' ', contact_name, organization_name, city, email, phone))
            like '%' || lower(btrim(p_q)) || '%'
  ),
  -- One row per PERSON, which is what the operator is counting. The extra rows are not thrown
  -- away: they are counted into dupe_in_market so the collapse is visible rather than silent.
  grouped as (
    select ident,
           count(*)::integer                       as dupe_in_market,
           min(contact_name)                       as contact_name,
           min(organization_name)                  as organization_name,
           min(city)                               as city,
           min(email) filter (where email is not null) as email,
           min(phone) filter (where phone is not null) as phone
    from filtered
    where ident is not null
    group by ident
  ),
  others as (
    select o.ident, array_agg(distinct o.code order by o.code) as codes
    from (
      select coalesce(public.sendable_email(mc.email), public.norm_phone_e164(mc.phone)) as ident,
             mc.code
      from public.market_contacts mc
      where mc.code <> upper(btrim(p_code))
    ) o
    where o.ident in (select ident from grouped)
    group by o.ident
  ),
  blasted as (
    select br.address_key as ident, max(br.sent_at) as last_at, count(*)::integer as n
    from ticketblaster.blast_recipients br
    where br.address_key in (select ident from grouped)
    group by br.address_key
  )
  select
    count(*) over()::bigint,
    g.ident,
    g.contact_name, g.organization_name, g.city, g.email, g.phone,
    -- The send path's own gate, not a second opinion on it.
    case when g.email is null then false else public.is_suppressed(g.email, null, 'email') end,
    case when g.phone is null then false else public.is_suppressed(null, g.phone, 'sms')   end,
    g.dupe_in_market,
    coalesce(o.codes, '{}'::text[]),
    b.last_at,
    coalesce(b.n, 0)
  from grouped g
  left join others  o on o.ident = g.ident
  left join blasted b on b.ident = g.ident
  order by (g.organization_name is null), g.organization_name, g.contact_name, g.ident
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$fn$;

revoke all on function public.market_recipients(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.market_recipients(text, text, text, integer, integer) to service_role;


-- ---------------------------------------------------------------------------------------------
-- market_blast_recency(code) -> when this market was last blasted, from every ledger that knows.
--
-- Three tables record a send and none of them records all of them: ticketblaster_market_blasts_log
-- holds the Textable import, market_blast_log is what api/queue-tick.js writes, and
-- blast_recipients is the new per-recipient log. The cooldown decision reads one of them; an
-- operator about to send should see the most recent across all three, or the banner will say "no
-- recent sends" about a market blasted yesterday through a different path.
create or replace function public.market_blast_recency(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, ticketblaster, pg_temp
as $fn$
  select jsonb_build_object(
    'code', upper(btrim(p_code)),
    'last_textable', (select max(blasted_at) from public.ticketblaster_market_blasts_log
                       where upper(coalesce(state_code,'')) = upper(btrim(p_code))),
    'last_app',      (select max(created_at) from public.market_blast_log
                       where upper(coalesce(market_code,'')) = upper(btrim(p_code))),
    'last_logged',   (select max(sent_at) from ticketblaster.blast_recipients
                       where upper(coalesce(market_code,'')) = upper(btrim(p_code))),
    'sends_90d',     (select count(*) from public.market_blast_log
                       where upper(coalesce(market_code,'')) = upper(btrim(p_code))
                         and created_at > now() - interval '90 days')
  );
$fn$;

revoke all on function public.market_blast_recency(text) from public, anon, authenticated;
grant execute on function public.market_blast_recency(text) to service_role;
