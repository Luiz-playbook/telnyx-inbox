-- Keep CakeMail send history current, into the table the decider already reads.
--
-- WHY. Cole picks markets by scrolling his CakeMail sent list ("who haven't we hit lately") —
-- see meeting-transcripts. That history is the biggest single input to the real decision, and
-- we already hold a snapshot of it: `blast_templates` is a CakeMail campaign-report dump
-- (campaign_id, list_name, scheduled_for, sent_emails, open_rate, clickthru_rate, bounces,
-- unsubscribes — CakeMail's report vocabulary verbatim). It feeds v_blast_scored ->
-- v_market_performance -> rpc_event_recommendations, so it is ALREADY the decider's memory.
--
-- The problem is not that the data is missing. It is that nothing refreshes it: 140 campaigns,
-- newest scheduled_for 2026-06-01, every `fetched_at` null. Two months of Cole's sends are
-- invisible to the decider, which is part of why markets keep coming back `no_history`.
--
-- So this migration does NOT add a second CakeMail table. A parallel table would fork the
-- decider's performance source and leave v_market_performance reading the stale half. It makes
-- `blast_templates` writable idempotently instead, and api/cakemail-sync.js tops it up.
--
-- Market resolution is untouched: market_bridge_list (list_name -> market_key, 51 rows, exact
-- join) already owns it, and all 140 existing rows map. A NEW list in CakeMail will not map
-- until a bridge row exists, so the sync reports unmapped names rather than dropping them
-- silently — see blast_templates_unmapped_lists() below.

-- ---------------------------------------------------------------------------
-- 1. Make campaign_id an upsert key.
-- ---------------------------------------------------------------------------
-- The table's PK is a surrogate bigint `id`; campaign_id carries no constraint, so a re-sync
-- would insert duplicates and double-count every market in v_market_performance (the view sums
-- weighted by sent_emails). Verified clean before adding: 140 rows, 0 null campaign_id,
-- 0 duplicates.
alter table public.blast_templates
  add constraint blast_templates_campaign_id_key unique (campaign_id);

-- Which CakeMail sub-account a campaign came from. 1679383 is cole@ (the account whose sent
-- list Cole actually works from); 1761047 is the production Josh sender. Nullable because the
-- 140 seeded rows predate the column and their origin is not recorded anywhere.
alter table public.blast_templates
  add column if not exists account_id text;

-- Subject line and sender. The table stored only the BODY (email_template), so Market History
-- could render the copy but not the envelope around it — where the Queue shows every blast as
-- From / Subject / body. Both come free with the per-campaign detail call
-- (content.subject, sender.name + sender.email).
--
-- Nullable and expected to stay null on the 140 seeded rows: that import never captured them,
-- and backfilling would mean 140 more API calls for campaigns whose performance is already
-- recorded. The UI omits whichever line is missing rather than printing "(no subject)" —
-- an empty label is noise in a history you are skimming.
alter table public.blast_templates
  add column if not exists subject text;
alter table public.blast_templates
  add column if not exists sender  text;

comment on column public.blast_templates.fetched_at is
  'When api/cakemail-sync.js last refreshed this row from the CakeMail report API. Null = seeded before the sync existed.';

-- ---------------------------------------------------------------------------
-- 2. Write path
-- ---------------------------------------------------------------------------
-- p_rows: [{ campaign_id, account_id, name, list_id, list_name, subject/email_template,
--            scheduled_for, scheduled_on, created_on, sent_emails, open_rate, click_rate,
--            clickthru_rate, bounce_rate, unsubscribe_rate, opens, unique_opens, clicks,
--            unique_clicks, bounces, unsubscribes, spams, ... }]
--
-- Idempotent on campaign_id. Null incoming values never overwrite a stored one: the campaign
-- list and the per-campaign report are two different CakeMail calls, and a run that fetched
-- the list but failed the report must not blank the rates a previous run resolved. Same
-- reasoning as set_event_prices keeping a known price_url (migration 039).
--
-- Returns counts rather than rows so the endpoint can report inserted-vs-updated without
-- shipping 140 campaign bodies back through the function.
create or replace function public.upsert_blast_templates(p_rows jsonb)
returns table (inserted integer, updated integer, unmapped integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r          jsonb;
  v_existing boolean;
  n_ins      integer := 0;
  n_upd      integer := 0;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as value
  loop
    continue when coalesce(r->>'campaign_id', '') = '';

    select exists (
      select 1 from public.blast_templates where campaign_id = r->>'campaign_id'
    ) into v_existing;

    insert into public.blast_templates as bt (
      campaign_id, account_id, name, list_id, list_name, segment_id,
      email_template, subject, sender, show_email_link_url,
      created_on, updated_on, scheduled_on, scheduled_for,
      active_emails, sent_emails,
      opens, unique_opens, unopens, implied_opens, forwards,
      clicks, unique_clicks, spams, unsubscribes,
      bounces, bounces_hard, bounces_soft,
      open_rate, click_rate, clickthru_rate, unopen_rate,
      bounce_rate, unsubscribe_rate, spam_rate, sent_rate,
      fetched_at
    )
    values (
      r->>'campaign_id',
      nullif(r->>'account_id', ''),
      nullif(r->>'name', ''),
      nullif(r->>'list_id', ''),
      nullif(r->>'list_name', ''),
      nullif(r->>'segment_id', ''),
      nullif(r->>'email_template', ''),
      nullif(r->>'subject', ''),
      nullif(r->>'sender', ''),
      nullif(r->>'show_email_link_url', ''),
      (nullif(r->>'created_on',    ''))::timestamptz,
      (nullif(r->>'updated_on',    ''))::timestamptz,
      (nullif(r->>'scheduled_on',  ''))::timestamptz,
      (nullif(r->>'scheduled_for', ''))::timestamptz,
      (nullif(r->>'active_emails', ''))::integer,
      (nullif(r->>'sent_emails',   ''))::integer,
      (nullif(r->>'opens',          ''))::integer,
      (nullif(r->>'unique_opens',   ''))::integer,
      (nullif(r->>'unopens',        ''))::integer,
      (nullif(r->>'implied_opens',  ''))::integer,
      (nullif(r->>'forwards',       ''))::integer,
      (nullif(r->>'clicks',         ''))::integer,
      (nullif(r->>'unique_clicks',  ''))::integer,
      (nullif(r->>'spams',          ''))::integer,
      (nullif(r->>'unsubscribes',   ''))::integer,
      (nullif(r->>'bounces',        ''))::integer,
      (nullif(r->>'bounces_hard',   ''))::integer,
      (nullif(r->>'bounces_soft',   ''))::integer,
      (nullif(r->>'open_rate',        ''))::numeric,
      (nullif(r->>'click_rate',       ''))::numeric,
      (nullif(r->>'clickthru_rate',   ''))::numeric,
      (nullif(r->>'unopen_rate',      ''))::numeric,
      (nullif(r->>'bounce_rate',      ''))::numeric,
      (nullif(r->>'unsubscribe_rate', ''))::numeric,
      (nullif(r->>'spam_rate',        ''))::numeric,
      (nullif(r->>'sent_rate',        ''))::numeric,
      now()
    )
    on conflict (campaign_id) do update set
      account_id          = coalesce(excluded.account_id,          bt.account_id),
      name                = coalesce(excluded.name,                bt.name),
      list_id             = coalesce(excluded.list_id,             bt.list_id),
      list_name           = coalesce(excluded.list_name,           bt.list_name),
      segment_id          = coalesce(excluded.segment_id,          bt.segment_id),
      email_template      = coalesce(excluded.email_template,      bt.email_template),
      subject             = coalesce(excluded.subject,             bt.subject),
      sender              = coalesce(excluded.sender,              bt.sender),
      show_email_link_url = coalesce(excluded.show_email_link_url, bt.show_email_link_url),
      created_on          = coalesce(excluded.created_on,          bt.created_on),
      updated_on          = coalesce(excluded.updated_on,          bt.updated_on),
      scheduled_on        = coalesce(excluded.scheduled_on,        bt.scheduled_on),
      scheduled_for       = coalesce(excluded.scheduled_for,       bt.scheduled_for),
      active_emails       = coalesce(excluded.active_emails,       bt.active_emails),
      sent_emails         = coalesce(excluded.sent_emails,         bt.sent_emails),
      opens               = coalesce(excluded.opens,               bt.opens),
      unique_opens        = coalesce(excluded.unique_opens,        bt.unique_opens),
      unopens             = coalesce(excluded.unopens,             bt.unopens),
      implied_opens       = coalesce(excluded.implied_opens,       bt.implied_opens),
      forwards            = coalesce(excluded.forwards,            bt.forwards),
      clicks              = coalesce(excluded.clicks,              bt.clicks),
      unique_clicks       = coalesce(excluded.unique_clicks,       bt.unique_clicks),
      spams               = coalesce(excluded.spams,               bt.spams),
      unsubscribes        = coalesce(excluded.unsubscribes,        bt.unsubscribes),
      bounces             = coalesce(excluded.bounces,             bt.bounces),
      bounces_hard        = coalesce(excluded.bounces_hard,        bt.bounces_hard),
      bounces_soft        = coalesce(excluded.bounces_soft,        bt.bounces_soft),
      open_rate           = coalesce(excluded.open_rate,           bt.open_rate),
      click_rate          = coalesce(excluded.click_rate,          bt.click_rate),
      clickthru_rate      = coalesce(excluded.clickthru_rate,      bt.clickthru_rate),
      unopen_rate         = coalesce(excluded.unopen_rate,         bt.unopen_rate),
      bounce_rate         = coalesce(excluded.bounce_rate,         bt.bounce_rate),
      unsubscribe_rate    = coalesce(excluded.unsubscribe_rate,    bt.unsubscribe_rate),
      spam_rate           = coalesce(excluded.spam_rate,           bt.spam_rate),
      sent_rate           = coalesce(excluded.sent_rate,           bt.sent_rate),
      fetched_at          = now();

    if v_existing then n_upd := n_upd + 1; else n_ins := n_ins + 1; end if;
  end loop;

  return query
    select n_ins, n_upd,
           (select count(*)::integer
              from public.blast_templates bt2
              left join public.market_bridge_list b on b.list_name = bt2.list_name
             where bt2.list_name is not null and b.list_name is null);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Visibility on the failure mode that costs history
-- ---------------------------------------------------------------------------
-- v_blast_scored INNER JOINs market_bridge_list and drops market_key = 'other', so a campaign
-- sent to a list nobody has bridged contributes nothing to v_market_performance — the market
-- looks like it has no history when it has plenty. This surfaces those names so a bridge row
-- can be added, instead of the loss being invisible.
create or replace function public.blast_templates_unmapped_lists()
returns table (list_name text, campaigns bigint, last_sent timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select bt.list_name, count(*), max(bt.scheduled_for)
    from public.blast_templates bt
    left join public.market_bridge_list b on b.list_name = bt.list_name
   where bt.list_name is not null
     and (b.list_name is null or b.market_key = 'other')
   group by bt.list_name
   order by max(bt.scheduled_for) desc nulls last;
$function$;

grant execute on function public.upsert_blast_templates(jsonb)      to service_role;
grant execute on function public.blast_templates_unmapped_lists()   to anon, authenticated, service_role;
