-- OPERATOR-EDITABLE GET-IN PRICE AND LISTING LINK.
--
-- Gemini is the only thing that has ever written a price, and it is grounded but not right:
-- migration 053 exists because the number alone could not say what it was read off, and
-- api/price-refresh.js throws away ~40% of the prices it pays for because the model returned
-- no link to check them against. The operator can already see the figure is wrong — clicking
-- through to the listing is the whole point of the Cheapest cell — but until now there was
-- nothing to do about it. This adds the write path.
--
-- ONE NUMBER, EVERY SURFACE. The edit lands on events_master, which is the single source of
-- truth every consumer joins live rather than copies:
--   * Campaigns by Event / ICP / SCP -> event_targets() reads em.best_price, em.price_url
--   * Queue                          -> get_campaign_queue() reads the same two columns
-- So one edit updates the campaign row, all three segment rows and every queued blast for
-- that game at once. Nothing is fanned out and nothing can drift. campaign_queue.ticket_price
-- (the per-row override column) is deliberately NOT touched: it is null on all 6 rows in the
-- table today and `coalesce(q.ticket_price, em.best_price)` means writing it would DETACH that
-- blast from the master price permanently, which is the opposite of what this is for.
--
-- MANUAL PRICES ARE NOT LOCKED. Decided 2026-08-05: a hand-typed price is a correction that
-- holds until the next real refresh, then yields to it. No lock column, no change to
-- rpc_price_targets eligibility, no guard in set_event_prices. The behaviour falls out of
-- priced_at = now() below — the row reads as fresh, so the cron skips it for 12h (near games)
-- or 48h (far) and repricess it after that, and the Refresh prices button (force=1) replaces
-- it immediately. The UI warns before that happens; see ui/index.html.
--
-- WHY THE COPY DOES NOT NEED REDRAFTING. campaign_queue.email_copy / sms_copy are stored text,
-- so a price baked into them would go stale on an edit. It never is: the Cole templates carry
-- no price token (migration 043) and docs/AI_DRAFT_AGENT.md line 102 forbids the tailor from
-- adding prices that were not already in the copy it was handed. Verified against all 5 drafted
-- rows — no dollar amount, no "get-in", no "as low as". The price reaches a recipient only
-- through the operator reading it off the row, so an edit is complete the moment it lands here.

-- ---------------------------------------------------------------------------
-- 1. Who typed it.
-- ---------------------------------------------------------------------------
-- events_master_price_history (migration 030) is the audit trail and it has never needed to
-- name anyone, because Gemini wrote every row. A hand-typed figure that goes out in outreach
-- is a different kind of claim and "someone changed it" is not an acceptable answer to who.
-- NULL means the cron wrote the row, which is every row that already exists.
alter table public.events_master_price_history
  add column if not exists set_by uuid;

comment on column public.events_master_price_history.set_by is
  'The signed-in user who typed this price, for rows written by set_event_price_manual. NULL = written by the price-refresh cron. See migration 055.';

-- ---------------------------------------------------------------------------
-- 2. The write path.
-- ---------------------------------------------------------------------------
-- Mirrors set_event_prices (053): security definer, because events_master is select-only to
-- clients and the grant is the gate. NOT granted to anon — migration 052 spent its whole
-- length closing the published key's write surface and this is a write.
--
-- p_price NULL is RESET, not a no-op: it clears the price, the source, the link and the
-- timestamp so the next cron run treats the game as never priced and looks it up fresh. That
-- is the "Reset to auto" button, and it deliberately drops price_url too — keeping a link that
-- was chosen to go with a discarded number would leave the row half-corrected.
--
-- p_url is written as given on every call, NOT coalesced the way set_event_prices coalesces
-- it. The editor is a form pre-filled with the current values, so an empty box is the operator
-- saying the link is wrong and should go, not the operator declining to mention it. Coalescing
-- here would make a bad link unremovable.
create or replace function public.set_event_price_manual(
  p_event_id uuid,
  p_price    numeric,
  p_url      text default null
)
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_league text;
  v_cur    text;
  n        integer := 0;
begin
  if p_event_id is null then
    raise exception 'set_event_price_manual: p_event_id is required';
  end if;

  -- A typo'd price is the one failure this function can actually prevent. PRICE_SANITY_MAX
  -- (lib/price.js, $250) is NOT applied: it exists to catch the model reporting a club seat as
  -- a get-in, and a human who has opened the listing and typed 380 has made an observation,
  -- not a mistake. Zero and negative are neither.
  if p_price is not null and p_price <= 0 then
    raise exception 'set_event_price_manual: price must be greater than 0 (got %)', p_price;
  end if;

  if p_price is null then
    -- RESET. Back to unpriced, so the next refresh picks the game up as a candidate.
    update public.events_master
       set best_price   = null,
           price_source = null,
           price_url    = null,
           price_seats  = null,
           priced_at    = null
     where id = p_event_id
    returning league into v_league;
    if found then
      n := 1;
      insert into public.events_master_price_history
             (event_id, league, best_price, price_source, price_seats, set_by)
      values (p_event_id, v_league, null, 'manual:reset', null, auth.uid());
    end if;
    return n;
  end if;

  -- price_currency is preserved rather than forced to USD. The board carries Canadian games
  -- (geo_region.country), migration 040 added the column precisely so a CAD price is not read
  -- as dollars, and the editor shows a bare number — it does not ask the operator to restate
  -- the currency, so it must not silently change it.
  select price_currency into v_cur from public.events_master where id = p_event_id;

  update public.events_master
     set best_price     = p_price,
         price_source   = 'manual',
         price_url      = nullif(btrim(p_url), ''),
         price_currency = coalesce(v_cur, 'USD'),
         -- NULL, not 1 or 2. price_seats says how the figure was obtained and migration 053 is
         -- explicit that guessing it "would invent an observation nobody made". The editor does
         -- not ask, so the honest answer is that it was not recorded — the info panel reads the
         -- 'manual' source and says who set it instead of describing a listing.
         price_seats    = null,
         -- Marks the row fresh, which is what makes a manual price survive the next scheduled
         -- run without any lock: the tiered staleness check in api/price-refresh.js skips it
         -- for 12h (near) or 48h (far).
         priced_at      = now()
   where id = p_event_id
  returning league into v_league;

  if found then
    n := 1;
    insert into public.events_master_price_history
           (event_id, league, best_price, price_source, price_currency, price_seats, set_by)
    values (p_event_id, v_league, p_price, 'manual', coalesce(v_cur, 'USD'), null, auth.uid());
  end if;

  return n;
end;
$function$;

-- FROM PUBLIC, not just FROM ANON — and this is not pedantry, it is the difference between the
-- function being closed and being wide open.
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and `anon` is a member of
-- PUBLIC, so `revoke ... from anon` removes a grant that was never what let anon in. Checked on
-- the live database: every function in this schema carries the PUBLIC grant, which shows in
-- pg_proc.proacl as a leading entry with an empty grantee —
--   set_event_prices  {=X/postgres,postgres=X/postgres,anon=X/postgres,...}
--    ^ that "=X" IS public
-- Revoking from PUBLIC first is the only thing that makes the two grants below the whole of the
-- access list. Verify with:
--   select proacl from pg_proc where proname = 'set_event_price_manual';
-- and expect exactly {postgres=X,authenticated=X,service_role=X} — no bare "=X" entry.
--
-- See the note at the end of this file: migration 052 revokes from anon only, so it does NOT
-- close the functions it names. That is a separate fix and is not done here.
revoke execute on function public.set_event_price_manual(uuid, numeric, text) from public;
revoke execute on function public.set_event_price_manual(uuid, numeric, text) from anon;
grant  execute on function public.set_event_price_manual(uuid, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Provenance on Campaigns by Event.
-- ---------------------------------------------------------------------------
-- The Queue got the four provenance fields in migration 054 and shows them in the info icon
-- beside the price. Campaigns by Event never had them, and once a price can be hand-typed that
-- gap stops being cosmetic: the two tables show the same number and only one of them can say
-- whether a person or a model put it there.
--
-- It also fixes a live bug. ui/index.html renders the price link with
--   title="View ${e.price_source||'listing'} listing"
-- against a function that has never returned price_source, so every row in that table has read
-- "View listing listing" since migration 032.
--
-- Return type changes, so drop + recreate — same as 044, 045, 048, 054. Body is 033's, with
-- four columns appended; nothing else about the function changes.
drop function if exists public.event_targets();

create function public.event_targets()
returns table(
  event_id text, team text, opponent text, event_date date, ticket_price numeric, ticket_url text,
  league text, sport text, venue text, market_key text, state_code text, state_name text, country text,
  segment text, companies bigint, emails bigint, phones bigint,
  price_source text, priced_at timestamptz, price_seats smallint, price_currency text
)
language sql
stable security definer
set search_path to 'public'
as $function$
  with ss as (select * from state_segment_summary())
  select
    em.id::text,
    coalesce(em.team_full, initcap(em.team)),
    initcap(em.opponent),
    em.event_date,
    em.best_price,
    em.price_url,
    upper(em.league),
    case lower(em.league)
      when 'mlb' then 'Baseball'
      when 'nba' then 'Basketball'
      when 'nhl' then 'Ice Hockey'
      when 'nfl' then 'Football'
      else initcap(em.league)
    end,
    em.venue,
    em.market_code,
    em.state_code,
    coalesce(s.name, gr.name),
    coalesce(s.country, gr.country),
    s.segment, s.companies, s.emails, s.phones,
    em.price_source, em.priced_at, em.price_seats, em.price_currency
  from events_master em
  left join geo_region gr on gr.code = em.state_code
  left join ss s on s.code = em.state_code
  where em.event_date >= current_date
  order by em.event_date asc, em.team,
           case s.segment when 'ICP' then 1 when 'SCP' then 2 else 3 end;
$function$;

-- 033 granted this to anon only, and 052 left it off the revoke list, so the Campaigns tab
-- still reads it with the published key (ui/index.html fetchAllEvents). Re-granting all three
-- keeps that working and lets a signed-in session read it too, which is what the editor needs.
-- Left open to PUBLIC deliberately, unlike the write above: this is a read the tab already
-- performs anonymously today, and closing it here would take the Campaigns table down.
grant execute on function public.event_targets() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- WHERE THIS CAME FROM — migration 052 had the same gap, and it has been fixed.
-- ---------------------------------------------------------------------------
-- 052 is a long list of `revoke execute on function ... from anon`, described in its own header
-- as the file that "makes a Playbook login actually required". As written it did not: anon
-- reached every one of those functions through PUBLIC, so the migration would have run clean and
-- closed nothing. Found while verifying this one — 43 of its 44 signatures carried the bare
-- `=X/postgres` PUBLIC entry, including the send-adjacent ones (queue_confirm, set_event_prices).
--
-- 052 now revokes `from public, anon` on every line. It is still NOT APPLIED and must not be
-- until the OpenClaw VPS moves off the anon key — that pre-flight is unchanged and is the whole
-- reason the file has been sitting.
