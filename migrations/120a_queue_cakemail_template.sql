-- 120a: let a queued blast send a CakeMail DESIGN instead of its plain-text body.
--
-- WHAT WAS MISSING. api/queue-tick.js builds the email as `nl2br(r.email_copy)` — the body box
-- escaped and line-broken. That is the only shape a blast could ever take, so the designed
-- templates sitting in CakeMail (account 1679383 holds three) were unreachable from this app:
-- pasting their HTML into email_copy would have been escaped and delivered as visible markup.
--
-- WHAT THIS ADDS. Three columns. `email_html`, which api/queue-tick.js prefers over the
-- plain-text build when it is present, and the id + name of the CakeMail template it came from
-- so the Queue can say WHICH design is attached and offer to detach it.
--
-- WHY THE NAME IS STORED AND NOT LOOKED UP. The badge in the Queue has to render from the row
-- alone. Resolving a name would mean a CakeMail call per expanded row, on a tab that renders 25
-- rows at a time, to label something that has already been chosen. The name is a label, not a
-- key: `cakemail_template_id` is what identifies the design, and a template renamed in CakeMail
-- after it was attached shows its name as at the time of attaching, which is the honest thing
-- for a row that already holds that design's HTML.
--
-- WHY THE HTML IS COPIED RATHER THAN RENDERED AT SEND TIME. A send must not depend on a
-- third-party read succeeding at the moment the cron fires, and a design edited in CakeMail
-- between review and send would change what goes out after a person approved it. The row holds
-- what was approved. Re-attaching is how you take an update.

-- ---------------------------------------------------------------------------
-- 1. The columns.
-- ---------------------------------------------------------------------------
alter table public.campaign_queue
  add column if not exists email_html             text,
  add column if not exists cakemail_template_id   bigint,
  add column if not exists cakemail_template_name text;

comment on column public.campaign_queue.email_html is
  'Finished HTML for this blast''s email, copied from a CakeMail template render by api/cakemail-templates.js with [GAME]/[DATE]/[SPORT] already filled. api/queue-tick.js sends this VERBATIM when set and falls back to nl2br(email_copy) when null, which is the pre-120 behaviour. email_copy is kept either way as the readable record of the row.';

comment on column public.campaign_queue.cakemail_template_id is
  'The CakeMail template id email_html was rendered from (GET /templates/{id}/render). Identity, not display — see cakemail_template_name.';

comment on column public.campaign_queue.cakemail_template_name is
  'The template''s name AS AT THE MOMENT IT WAS ATTACHED, for the Queue badge. Not refreshed: the row already holds that design''s HTML, so a later rename in CakeMail does not change what this row sends.';

-- ---------------------------------------------------------------------------
-- 2. Return them. campaign_queue has no RLS policy, deliberately, and the Queue tab reads it
--    only through this SECURITY DEFINER function — a column the function does not return does
--    not exist as far as the UI is concerned.
--
--    DROP AND RECREATE, because Postgres will not let CREATE OR REPLACE change a return type
--    and adding to RETURNS TABLE is a return-type change.
--
--    ⚠️ THE 058 TRAP. 058 dropped this function and silently left trigger_instructions off the
--    new signature, so the value went on being written and simply stopped being readable until
--    071 put it back. The body below is the live definition (103) copied VERBATIM with three
--    additions and nothing else — the three columns at the end of the signature, and the three
--    q.* at the end of the select. Nothing is reordered: the UI reads these by name, but
--    PostgREST builds that mapping from position, and reordering is how that bug happens.
--
--    GRANTS ARE RESTATED. A drop takes the function's ACL with it, and the UI's anon key reads
--    the Queue through this function, so a missed grant is an empty Queue tab.
-- ---------------------------------------------------------------------------
drop function if exists public.get_campaign_queue();

create function public.get_campaign_queue()
returns table(
  id uuid, title text, state_code text, state_name text, event_id uuid,
  email boolean, sms boolean, phone_count integer, sms_count integer, ticket_price numeric,
  email_copy text, sms_copy text, scheduled_for timestamp with time zone, status text,
  confirmed_at timestamp with time zone, snooze_count integer, sent_at timestamp with time zone,
  is_placeholder boolean, created_at timestamp with time zone, email_from text, sms_from text,
  email_count integer, team text, opponent text, event_date date, league text, sport text,
  venue text, market_key text, country text, ticket_url text, email_subject text,
  archived_at timestamp with time zone, segment text, rejected_at timestamp with time zone,
  reject_note text, price_source text, priced_at timestamp with time zone, price_seats smallint,
  price_currency text, segment_email_count integer, segment_phone_count integer,
  send_failures text, trigger_instructions text, strategy text,
  -- NEW, and last on purpose. Appending cannot shift the position of any existing column.
  email_html text, cakemail_template_id bigint, cakemail_template_name text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    q.id, q.title, q.state_code, q.state_name, q.event_id,
    q.email, q.sms,
    case when q.status in ('sent','partial') then q.phone_count
         else coalesce(mc.phone_count::int, q.phone_count) end as phone_count,
    case when q.status in ('sent','partial') then q.sms_count
         else coalesce(mc.phone_count::int, q.sms_count) end   as sms_count,
    coalesce(q.ticket_price, em.best_price) as ticket_price,
    q.email_copy, q.sms_copy, q.scheduled_for, q.status, q.confirmed_at,
    q.snooze_count, q.sent_at, q.is_placeholder, q.created_at,
    q.email_from, q.sms_from,
    case when q.status in ('sent','partial') then q.email_count
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
    em.price_source,
    em.priced_at,
    em.price_seats,
    em.price_currency,
    case when q.status in ('sent','partial') then q.email_count else msc.email_count::int end as segment_email_count,
    case when q.status in ('sent','partial') then q.phone_count else msc.phone_count::int end as segment_phone_count,
    q.send_failures,
    -- Restored here. 058 predates 071 and its drop+recreate took this column off the
    -- function while leaving it on the table, so the value was still being written and
    -- simply stopped being readable.
    q.trigger_instructions,
    q.strategy,
    q.email_html,
    q.cakemail_template_id,
    q.cakemail_template_name
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  left join public.market_segment_counts msc
         on msc.code = q.state_code and msc.segment = q.segment
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role, readonly_preview;

-- ---------------------------------------------------------------------------
-- 3. Write them. A separate function rather than a wider queue_set_copy, for the reason 044
--    gives: that one already has callers (the Queue editor, api/queue-draft.js) and changing
--    its arity would break them mid-deploy.
--
--    ATTACH AND DETACH ARE THE SAME CALL. Passing a null/blank p_html clears all three columns
--    together, so there is no state where a row carries a template name but sends plain text —
--    which is the badge lying about what will arrive.
--
--    SERVICE_ROLE ONLY. Every other queue_set_* is granted to anon because the browser calls it
--    with the anon key, but this one is never called from a browser: api/cakemail-templates.js
--    renders the design server-side and writes it with the service key, precisely so that live
--    campaign HTML never passes through the page. Granting anon here would reopen that.
-- ---------------------------------------------------------------------------
create or replace function public.queue_set_email_html(
  p_id uuid, p_html text, p_template_id bigint, p_template_name text
)
returns public.campaign_queue
language sql volatile security definer set search_path to 'public'
as $function$
  update public.campaign_queue
     set email_html             = nullif(btrim(p_html), ''),
         cakemail_template_id   = case when nullif(btrim(p_html), '') is null then null else p_template_id end,
         cakemail_template_name = case when nullif(btrim(p_html), '') is null then null else nullif(btrim(p_template_name), '') end
   where id = p_id
  returning *;
$function$;

revoke execute on function public.queue_set_email_html(uuid, text, bigint, text) from public, anon, authenticated;
grant  execute on function public.queue_set_email_html(uuid, text, bigint, text) to service_role;
