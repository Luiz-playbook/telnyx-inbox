-- A queued blast had nowhere to put an email subject, so api/queue-tick.js sent the row's
-- TITLE as the subject line. The title is queue bookkeeping — "[TEST] angels — Anaheim" —
-- and that is what a recipient would have seen in their inbox: the test marker, the
-- lowercase team slug, and the market name, instead of "Early access tickets — Angels at
-- Anaheim Ducks".
--
-- message_templates has carried a `subject` column since migration 011 ("Early access
-- tickets — [GAME]"), fully tokenized and unused, because there was no column to copy it
-- into. This adds one.
--
-- Also fixes the sign-off block. Migration 043 collapsed "Josh Marcus\nCEO & Co-Founder |
-- Playbook Sports" onto a single line while normalising the title, which ran the name and
-- the role together under "Best,". Cole's format is a blank line after the sign-off, then
-- name and role on their own lines.

-- ---------------------------------------------------------------------------
-- 1. The column.
-- ---------------------------------------------------------------------------
alter table public.campaign_queue
  add column if not exists email_subject text;

comment on column public.campaign_queue.email_subject is
  'Subject line for this blast''s email, filled by api/queue-draft.js from the template''s tokenized subject. api/queue-tick.js falls back to `title` when this is null, which is the pre-044 behaviour.';

-- ---------------------------------------------------------------------------
-- 2. Expose it. The return type changes, so CREATE OR REPLACE cannot be used — a
--    RETURNS TABLE signature is part of the function's identity. Dropped and recreated
--    verbatim with email_subject appended LAST, so nothing that reads the existing
--    columns by name or position shifts.
-- ---------------------------------------------------------------------------
drop function if exists public.get_campaign_queue();

create function public.get_campaign_queue()
 returns table(id uuid, title text, state_code text, state_name text, event_id uuid,
   email boolean, sms boolean, phone_count integer, sms_count integer, ticket_price numeric,
   email_copy text, sms_copy text, scheduled_for timestamp with time zone, status text,
   confirmed_at timestamp with time zone, snooze_count integer, sent_at timestamp with time zone,
   is_placeholder boolean, created_at timestamp with time zone, email_from text, sms_from text,
   email_count integer, team text, opponent text, event_date date, league text, sport text,
   venue text, market_key text, country text, ticket_url text, email_subject text)
 language sql stable security definer set search_path to 'public'
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
      else initcap(em.league)
    end as sport,
    em.venue,
    em.market_code as market_key,
    gr.country,
    em.price_url as ticket_url,
    q.email_subject
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Write it. Separate from queue_set_copy rather than a wider signature: that function
--    already has callers (the Queue editor, api/queue-draft.js) and changing its arity
--    would break them mid-deploy.
-- ---------------------------------------------------------------------------
create or replace function public.queue_set_email_subject(p_id uuid, p_subject text)
returns public.campaign_queue
language sql volatile security definer set search_path to 'public'
as $function$
  update public.campaign_queue
     set email_subject = nullif(btrim(p_subject), '')
   where id = p_id
  returning *;
$function$;

grant execute on function public.queue_set_email_subject(uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Sign-off block. "Best," / blank line / name / role — the format Cole uses.
--    Only the Playbook plays; Teammate AI signs off as its own co-founder (see 043).
-- ---------------------------------------------------------------------------
update public.message_templates
   set body = replace(body,
        E'Best,\nJosh Marcus, CEO of Playbook Sports',
        E'Best,\n\nJosh Marcus\nCEO of Playbook Sports')
 where slug in ('tb-email-1','tb-email-2','suite-email');
