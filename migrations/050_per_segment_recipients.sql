-- PER-SEGMENT RECIPIENTS — the plumbing that makes a market × segment queue row sendable.
--
-- Josh, 2026-07-31: "can we make it more clear whether each queue is for ICP, SCP or non-ICP,
-- non-SCP?" and "is the trigger blast logic always separating it by ICP, SCP and other?" The
-- answer to the second was no: a blast resolved recipients with market_phones(p_code) /
-- market_emails(p_code), which take a market and nothing else, so every send went to all three
-- segments mixed together. Vhea, 2026-08-03: ICP is the primary target and each event becomes
-- three queue rows.
--
-- Segment is NOT a new fact — company_intel.lead_segment already carries it (icp 10,720 /
-- scp 1,838 / other 14,587 / null 1,096 as of today) and state_segment_summary() in migration
-- 033 already reports reach per segment for Campaigns by Event. It simply never reached the
-- send path. This migration carries it the last mile.
--
-- NORMALISATION, same rule as 033: lead_segment 'icp' -> ICP, 'scp' -> SCP, EVERYTHING ELSE
-- INCLUDING NULL -> 'Other'. The 1,096 null rows are real contactable people; dropping them
-- into a fourth bucket, or out of the world entirely, would quietly shrink reach.

-- ---------------------------------------------------------------------------
-- 1. Segment on market_contacts.
--
-- The table is truncate-and-rebuild, so the column is added here and filled by the rebuilt
-- refresh_market_contacts() below — there is no backfill to write.
-- ---------------------------------------------------------------------------
alter table public.market_contacts
  add column if not exists segment text;

comment on column public.market_contacts.segment is
  'ICP | SCP | Other, normalised from company_intel.lead_segment (null and anything unrecognised become Other). Written by refresh_market_contacts(). See migration 050.';

create index if not exists market_contacts_code_segment_idx
  on public.market_contacts (code, segment);

create or replace function public.refresh_market_contacts()
returns void
language plpgsql volatile security definer set search_path to 'public'
as $function$
begin
  truncate public.market_contacts;
  insert into public.market_contacts
    (code, state_name, organization_name, city, contact_name, title, phone, email, segment)
  select s.code,
         s.name,
         ci.organization_name,
         ci.city,
         nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
         c.title,
         nullif(btrim(c.phone), ''),
         nullif(lower(btrim(c.email)), ''),
         case lower(btrim(coalesce(ci.lead_segment, '')))
           when 'icp' then 'ICP'
           when 'scp' then 'SCP'
           else 'Other'
         end
  from public.contact_intel c
  join public.company_intel ci on ci.id = c.company_intel_id
  join public.state_alias  sa on sa.alias = upper(btrim(ci.state))
  join public.us_states     s on s.code = sa.code
  where (c.phone is not null and btrim(c.phone) <> '')
     or (c.email is not null and btrim(c.email) <> '');
  refresh materialized view public.market_counts;
  refresh materialized view public.market_segment_counts;
end;
$function$;

grant execute on function public.refresh_market_contacts() to service_role;

-- ---------------------------------------------------------------------------
-- 2. Per-segment counts as a SEPARATE matview.
--
-- market_counts is deliberately left alone. get_campaign_queue() joins it on code alone
-- (`left join market_counts mc on mc.code = q.state_code`); making it one row per code ×
-- segment would turn that into a three-way fan-out and silently triple every queue row. A new
-- view costs nothing and breaks nothing.
-- ---------------------------------------------------------------------------
drop materialized view if exists public.market_segment_counts;

create materialized view public.market_segment_counts as
  select code,
         coalesce(segment, 'Other') as segment,
         max(state_name) as name,
         count(*) filter (where phone is not null) as phone_count,
         count(*) filter (where email is not null) as email_count
  from public.market_contacts
  group by code, coalesce(segment, 'Other');

create unique index if not exists market_segment_counts_pk
  on public.market_segment_counts (code, segment);

grant select on public.market_segment_counts to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Recipient resolution, now segment-aware.
--
-- DROPPED AND RECREATED, not overloaded: adding (text, text default null) beside the existing
-- (text) leaves a one-argument call ambiguous, and PostgREST calls these by name — every
-- existing call site would start failing at runtime rather than at deploy.
--
-- p_segment = null keeps the old behaviour exactly: the whole market, every segment. That is
-- what a queue row with no segment means and what api/queue-tick.js passes for one.
--
-- The send_allowlist gate is untouched. It is the thing that makes an anonymous "Send now"
-- safe (see 023 and the auth note in api/queue-tick.js) and must keep resolving every
-- non-allowlisted market to zero rows regardless of segment.
--
-- NOTE ON `limit 1000`: it was already there and is left as-is, but its meaning has changed —
-- it is now 1,000 PER SEGMENT, so a market can resolve up to 3,000 recipients where it used to
-- cap at 1,000. That is closer to the truth, not further from it (Josh asked about 2,000-contact
-- markets on 2026-07-31 and the honest answer was that half of them were being silently
-- dropped), but it is a real change in send volume and should be seen before a live run.
-- ---------------------------------------------------------------------------
drop function if exists public.market_phones(text);
drop function if exists public.market_emails(text);

create function public.market_phones(p_code text, p_segment text default null)
returns table(phone text)
language sql stable security definer set search_path to 'public'
as $function$
  select mc.phone from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.phone is not null
    and (p_segment is null or coalesce(mc.segment, 'Other') = p_segment)
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
  order by mc.phone limit 1000;
$function$;

create function public.market_emails(p_code text, p_segment text default null)
returns table(email text)
language sql stable security definer set search_path to 'public'
as $function$
  select mc.email from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.email is not null
    and (p_segment is null or coalesce(mc.segment, 'Other') = p_segment)
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
  order by mc.email limit 1000;
$function$;

grant execute on function public.market_phones(text, text) to anon, authenticated, service_role;
grant execute on function public.market_emails(text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Reach per market × segment, for the decider.
--
-- Additive again: market_recipient_counts() keeps its shape and its callers. The decider needs
-- to know whether SCP in a market is worth a row at all — a segment with no contactable people
-- should not become a queued blast — and that is what this answers.
-- ---------------------------------------------------------------------------
create or replace function public.market_recipient_counts_by_segment()
returns table(market_key text, state_code text, segment text,
              phone_count bigint, email_count bigint)
language sql stable security definer set search_path to 'public'
as $function$
  with segs as (select unnest(array['ICP','SCP','Other']) as segment)
  select ms.market_key, ms.state_code, s.segment,
         coalesce(msc.phone_count, 0), coalesce(msc.email_count, 0)
  from market_state ms
  cross join segs s
  left join market_segment_counts msc
    on msc.code = ms.state_code and msc.segment = s.segment;
$function$;

grant execute on function public.market_recipient_counts_by_segment()
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Enqueue, per segment.
--
-- THE DEDUPE KEY IS THE WHOLE CHANGE HERE. The old guard skipped any row whose event_id was
-- already live, which is correct when an event is one row and catastrophic when it is three:
-- the ICP row would insert, and SCP and Other would both be silently swallowed as duplicates.
-- Every run would produce one row per event and nobody would see an error.
--
-- The key is now (event_id, segment). A row with no segment still collides with everything for
-- that event, which is right — "the whole market" and "ICP" overlap.
-- ---------------------------------------------------------------------------
create or replace function public.queue_enqueue_test(p_rows jsonb)
returns setof public.campaign_queue
language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  r jsonb;
  v_when timestamptz;
  v_event uuid;
  v_code text;
  v_segment text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    v_when    := coalesce((nullif(r->>'scheduled_for',''))::timestamptz, now());
    v_event   := (nullif(r->>'event_id',''))::uuid;
    v_code    := nullif(r->>'state_code','');
    v_segment := nullif(btrim(coalesce(r->>'segment','')), '');

    if v_segment is not null and v_segment not in ('ICP','SCP','Other') then
      raise exception 'Unknown segment %, expected ICP, SCP or Other.', v_segment
        using errcode = 'check_violation';
    end if;

    -- already queued -> leave the existing row alone (this is the "don't rewrite" rule).
    -- Rejected rows are NOT live: refusing a blast gives its slot back, so the same
    -- (event, segment) may be queued again later. What stops an immediate re-add is the
    -- 21-day suppression in api/trigger-decide.js, not this guard. See migration 048.
    if exists (
      select 1
      from public.campaign_queue q
      where q.status not in ('sent', 'sending', 'rejected')
        and (
          (v_event is not null and q.event_id = v_event
           and (v_segment is null or q.segment is null or q.segment = v_segment))
          or (v_event is null and v_code is not null
              and q.state_code = v_code
              and q.scheduled_for::date = v_when::date
              and (v_segment is null or q.segment is null or q.segment = v_segment))
        )
    ) then
      continue;
    end if;

    return query
    insert into public.campaign_queue
      (title, state_code, state_name, event_id, segment,
       email, sms, phone_count, sms_count, email_count,
       email_copy, sms_copy, scheduled_for, status, is_placeholder)
    values (
      coalesce(nullif(r->>'title',''), '[TEST] Blast'),
      v_code,
      nullif(r->>'state_name',''),
      v_event,
      v_segment,
      coalesce((r->>'email')::boolean, true),
      coalesce((r->>'sms')::boolean, false),
      coalesce((nullif(r->>'phone_count',''))::int, 0),
      coalesce((nullif(r->>'sms_count',''))::int, 0),
      coalesce((nullif(r->>'email_count',''))::int, 0),
      r->>'email_copy',
      r->>'sms_copy',
      v_when,
      'pending',
      true            -- TEST rows only: queue-tick skips placeholders, never sends
    )
    returning *;
  end loop;
end;
$function$;

grant execute on function public.queue_enqueue_test(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Fill it in. Rebuilds market_contacts with segments and refreshes both count views.
--    Safe to re-run; this is the same call migration 022 makes.
-- ---------------------------------------------------------------------------
select public.refresh_market_contacts();
