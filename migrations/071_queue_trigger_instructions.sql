-- 071: keep the operator's Trigger Blast instructions on the rows they produced (AI-960).
--
-- WHY
--
-- Trigger Blast is about to accept free text — "a few NHL games in Toronto and Montreal, then
-- West Coast hockey, plus one football org each coast" — and pass it to the decider as a preamble
-- ahead of the existing rules. Once that text shapes a queue, it becomes the only record of WHY
-- these markets and not others, and the ticket asks for it to be readable back on the item
-- alongside the reject reason.
--
-- Without it the queue keeps answering "what" and never "what was asked for", which is exactly
-- the gap the reject-reason work closed from the other direction: a rejected row explains itself,
-- an accepted one does not.
--
-- SHAPE. One text column on campaign_queue, written at enqueue and never updated afterwards. It
-- is a record of the instruction that produced the row, not a field anyone edits — rewriting it
-- later would make it a description of the row rather than evidence of its origin.
--
-- NULL IS THE NORMAL CASE and must stay cheap: every row queued before this, every row from the
-- daily cron, and every trigger run with an empty box has no instruction, and the ticket requires
-- an empty box to behave exactly as today.

alter table public.campaign_queue
  add column if not exists trigger_instructions text;

comment on column public.campaign_queue.trigger_instructions is
  'Free-text instruction the operator typed into Trigger Blast (AI-960), stored on every row that '
  'run produced. Written once at enqueue, never edited — it is evidence of what was asked for, '
  'not a description of the row. Null for rows queued by the cron, by Add to Queue, or by a '
  'trigger run with an empty instruction box.';

-- ---------------------------------------------------------------------------
-- 1. Accept it at enqueue.
--
-- The body below is the live function verbatim (migration 050's, as deployed) with ONE addition:
-- trigger_instructions is read off each row object and inserted. Everything else — the segment
-- validation, the (event_id, segment) dedupe key, 'pending', is_placeholder true — is unchanged
-- and must stay that way: this is the function Trigger Blast and Add to Queue both call, and a
-- silent behaviour change here would reach every queued row.
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
       email_copy, sms_copy, scheduled_for, status, is_placeholder,
       trigger_instructions)
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
      true,
      nullif(btrim(coalesce(r->>'trigger_instructions','')), '')
    )
    returning *;
  end loop;
end;
$function$;

revoke execute on function public.queue_enqueue_test(jsonb) from public, anon;
grant  execute on function public.queue_enqueue_test(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Return it on the queue.
--
-- The return type gains a column, so drop + recreate (same reason as 044/045/056/060).
--
-- THE BODY BELOW IS MIGRATION 060'S, VERBATIM, plus q.trigger_instructions — NOT 058's.
-- 058 was written but never applied: the live campaign_queue has no send_failures column, and
-- 060 is the newest migration that actually defines this function. Rebuilding on 058 would have
-- recreated it selecting q.send_failures and failed with "column does not exist" — the exact
-- error 059 hit for the same reason, and 059/060 both carry a note about it. Verified against
-- the live function's returned columns before writing this, not inferred from the file names.
--
-- If 058 is ever applied, it must be applied BEFORE this one, and this function re-derived from
-- it; otherwise 058's drop+recreate will silently drop trigger_instructions back off the queue.
--
-- GRANTS: dropping a function drops its ACL and CREATE FUNCTION then grants EXECUTE to PUBLIC by
-- default — see the closing note in 056. The pre-change ACL is reproduced below unchanged. This
-- is a display change and must not move the security line in either direction.
-- ---------------------------------------------------------------------------
drop function if exists public.get_campaign_queue();

create or replace function public.get_campaign_queue()
returns table (
  id uuid, title text, state_code text, state_name text, event_id uuid,
  email boolean, sms boolean, phone_count integer, sms_count integer,
  ticket_price numeric, email_copy text, sms_copy text,
  scheduled_for timestamptz, status text, confirmed_at timestamptz,
  snooze_count integer, sent_at timestamptz, is_placeholder boolean,
  created_at timestamptz, email_from text, sms_from text, email_count integer,
  team text, opponent text, event_date date, league text, sport text, venue text,
  market_key text, country text, ticket_url text, email_subject text,
  archived_at timestamptz, segment text, rejected_at timestamptz, reject_note text,
  price_source text, priced_at timestamptz, price_seats smallint, price_currency text,
  segment_email_count integer, segment_phone_count integer,
  trigger_instructions text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    q.id, q.title, q.state_code, q.state_name, q.event_id,
    q.email, q.sms,
    case when q.status = 'sent' then q.phone_count
         else coalesce(mc.phone_count::int, q.phone_count) end as phone_count,
    case when q.status = 'sent' then q.sms_count
         else coalesce(mc.phone_count::int, q.sms_count) end   as sms_count,
    coalesce(q.ticket_price, em.best_price) as ticket_price,
    q.email_copy, q.sms_copy, q.scheduled_for, q.status, q.confirmed_at,
    q.snooze_count, q.sent_at, q.is_placeholder, q.created_at,
    q.email_from, q.sms_from,
    case when q.status = 'sent' then q.email_count
         else coalesce(mc.email_count::int, q.email_count) end as email_count,
    coalesce(em.team_full, initcap(nullif(btrim(q.team), '')), q.team)      as team,
    coalesce(initcap(nullif(btrim(em.opponent), '')), q.opponent)           as opponent,
    em.event_date,
    upper(em.league) as league,
    case lower(em.league)
      when 'mlb' then 'Baseball'
      when 'nba' then 'Basketball'
      when 'nhl' then 'Ice Hockey'
      when 'nfl' then 'Football'
      -- CFB is football played in a different competition, so it shares the SPORT and is
      -- separated by LEAGUE — which is how nhl/mlb/nfl already work. Without this branch the
      -- CASE falls through to initcap(league) and the Sport filter grows a bogus "Cfb"
      -- sitting next to "Football", splitting one sport across two filter options.
      when 'cfb' then 'Football'
      -- WNBA is its own league sharing the sport, exactly as CFB does with the NFL. Without
      -- this the CASE falls through to initcap(league) and the Sport filter gains a "Wnba"
      -- option beside "Basketball", splitting one sport in two.
      when 'wnba' then 'Basketball'
      else initcap(em.league)
    end as sport,
    em.venue,
    em.market_code as market_key,
    gr.country,
    em.price_url as ticket_url,
    q.email_subject,
    q.archived_at,
    q.segment,
    q.rejected_at,
    q.reject_note,
    -- Price provenance. Only meaningful when ticket_price came from events_master: a row
    -- carrying its own overridden q.ticket_price is not what these describe, and the UI says so
    -- rather than attaching someone else's sourcing to a hand-typed number.
    em.price_source,
    em.priced_at,
    em.price_seats,
    em.price_currency,
    -- Reach for THIS row's segment. NULL on a whole-market row (see the header) and, like the
    -- market-level pair above, frozen at the snapshot once the row is sent — a sent blast
    -- should report who it actually reached, not who the market holds today.
    case when q.status = 'sent' then q.email_count else msc.email_count::int end as segment_email_count,
    case when q.status = 'sent' then q.phone_count else msc.phone_count::int end as segment_phone_count,
    -- AI-960. The instruction the operator typed into Trigger Blast when this row was
    -- queued. Straight off the row, never joined and never coalesced: it is a record of
    -- what was asked for, and substituting anything for a null would invent one.
    q.trigger_instructions
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  -- On the view's full grouping key, so this matches at most one row and cannot fan out.
  left join public.market_segment_counts msc
         on msc.code = q.state_code and msc.segment = q.segment
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to public, anon, authenticated, service_role, readonly_preview;
