-- PRICE PROVENANCE ON THE QUEUE ROW.
--
-- The Queue shows a get-in price per blast but nothing about where it came from, so a figure
-- checked eight days ago off a lone single looked identical to one checked this morning off a
-- pair. The info icon beside the price (ui/index.html, priceInfo) answers that, and these are
-- the four fields it reads.
--
-- Return type changes, so drop + recreate — see 044, 045, 048.
--
-- WHY THESE ARE NOT ALWAYS MEANINGFUL. ticket_price is `coalesce(q.ticket_price, em.best_price)`:
-- a row may carry its own overridden price, in which case events_master's sourcing describes a
-- different number entirely. The UI suppresses the icon in that case rather than attaching this
-- provenance to a hand-typed figure. Adding the fields here does not make them true of every row,
-- and the caller has to know that.

drop function if exists public.get_campaign_queue();

create function public.get_campaign_queue()
 returns table(id uuid, title text, state_code text, state_name text, event_id uuid,
   email boolean, sms boolean, phone_count integer, sms_count integer, ticket_price numeric,
   email_copy text, sms_copy text, scheduled_for timestamp with time zone, status text,
   confirmed_at timestamp with time zone, snooze_count integer, sent_at timestamp with time zone,
   is_placeholder boolean, created_at timestamp with time zone, email_from text, sms_from text,
   email_count integer, team text, opponent text, event_date date, league text, sport text,
   venue text, market_key text, country text, ticket_url text, email_subject text,
   archived_at timestamp with time zone, segment text,
   rejected_at timestamp with time zone, reject_note text,
   price_source text, priced_at timestamp with time zone, price_seats smallint,
   price_currency text)
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
    q.email_subject,
    q.archived_at,
    q.segment,
    q.rejected_at,
    q.reject_note,
    em.price_source,
    em.priced_at,
    em.price_seats,
    em.price_currency
  from public.campaign_queue q
  left join public.events_master em on em.id = q.event_id
  left join public.market_counts mc on mc.code = q.state_code
  left join public.geo_region gr    on gr.code = q.state_code
  order by q.scheduled_for asc, q.created_at asc;
$function$;

grant execute on function public.get_campaign_queue() to anon, authenticated, service_role;
