-- 120: the Event Waitlist board — proposed events, the markets they are shopped to, the people
--      who raised a hand, and the strategy on the blast log that every play's cooldown reads.
--
-- WHAT THIS IS (John, 2026-10-13). A strategy is a way of GENERATING the Offers tab. Ticket
-- Blasts generates from the league calendar. Event Waitlist generates from a PROPOSED EVENT:
-- Dan writes up an event that does not exist yet, picks the markets to ask, and the board shows
-- every market with its reach, its cooldown, and which message of the sequence is due next.
-- When enough organisations in a market have said yes (the proposal's own threshold, not a
-- global number), Dan confirms a real date for that market and it flips to a formal invitation
-- — at which point it is an ordinary ticket blast against an event on the calendar.
--
-- THE SEQUENCE HAS NO SEQUENCER. A step is an offer that becomes due on a date: Day 3 appears
-- on the board three days after Day 0 was SENT, and disappears once it is queued. Each send
-- stamps its step on proposal_markets (proposal_step_sent, called by api/queue-tick.js), and
-- waitlist_board() derives "what is due" from those stamps every time it is read. Nothing fires
-- on its own; Cole confirms every row in the Queue, as always.
--
-- EVERY STATE IS ON THE BOARD, not just the eighteen. Dan's "never ran an event here" list is a
-- FLAG on waitlist_markets, so a proposal can be shopped to any market and the untouched ones
-- are the ones it points at. Changing the list is an UPDATE, not a migration.
--
-- WRITES GO THROUGH SECURITY DEFINER FUNCTIONS, like queue_confirm and the rest of the queue:
-- the browser holds the anon key, the tables carry read-only policies for anon + authenticated
-- (the lesson of migration 107 — both roles, or signed-in users see nothing), and each write is
-- a named function that does one thing.
--
-- Rollback: 120_event_proposals_rollback.sql.

-- ── 1. Strategy on the blast log ───────────────────────────────────────────────────────────
-- market_blast_log is the table the cooldown reads (migration 049) and the one the tick writes.
-- It knew the channel and the segment but not the PLAY, so "days since we messaged Montana,
-- any strategy" and "…this strategy" were the same question. Now they are two.
alter table public.market_blast_log
  add column if not exists strategy text not null default 'ticket_blasts';

create index if not exists market_blast_log_code_strategy_idx
  on public.market_blast_log (market_code, strategy, sent_on desc);

-- Same function, one more argument with a default, so every existing caller keeps working. The
-- five-argument version is dropped first: with both present, a call naming five arguments would
-- match both and Postgres would refuse to choose.
drop function if exists public.log_market_blast(text, text, text, uuid, text);
create or replace function public.log_market_blast(
  p_code text, p_name text, p_channel text,
  p_queue_id uuid default null, p_segment text default null,
  p_strategy text default 'ticket_blasts'
) returns bigint
language sql security definer set search_path = public as $$
  insert into public.market_blast_log (market_code, market_name, channel, campaign_queue_id, segment, strategy)
  values (upper(btrim(p_code)), p_name, p_channel, p_queue_id,
          nullif(btrim(coalesce(p_segment, '')), ''),
          coalesce(nullif(btrim(p_strategy), ''), 'ticket_blasts'))
  returning id;
$$;
grant execute on function public.log_market_blast(text, text, text, uuid, text, text) to anon, authenticated, service_role;

-- ── 2. The markets, with Dan's flag ─────────────────────────────────────────────────────────
create table if not exists public.waitlist_markets (
  code        text primary key references public.geo_region(code),
  untouched   boolean not null default false,   -- Dan, 16 Sep 2026: never ran an event here
  warm        boolean not null default false,   -- a presence but no date (Idaho / Boise)
  note        text,
  updated_at  timestamptz not null default now()
);
insert into public.waitlist_markets (code)
select code from public.geo_region where country = 'US'
on conflict (code) do nothing;

update public.waitlist_markets set untouched = true, note = 'Never hosted (Dan, 16 Sep 2026)'
 where code in ('HI','AK','NM','ME','NH','DE','AL','ID','IA','AR','MA','MS','MT','ND','SD','RI','VT','WY');
update public.waitlist_markets set warm = true, note = 'Boise presence, no date run — warm start (Dan)'
 where code = 'ID';

-- ── 3. Proposed events ─────────────────────────────────────────────────────────────────────
create table if not exists public.event_proposals (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  sport              text,                       -- fills [Sport]
  season             text,                       -- free text: "Spring 2027"
  threshold          int  not null default 20,   -- hand-raisers per market before Dan confirms
  sender_name        text,                       -- fills [Sender Name] until a territory map exists
  sender_title       text,                       -- fills [Sender Title]
  waitlist_url       text,                       -- fills [waitlist_link]; a form Dan owns
  states_count       int  default 30,            -- fills [N] ("events across [N] states")
  comparable_market  text,                       -- fills [Comparable Market] in Email #2
  status             text not null default 'proposed' check (status in ('proposed','active','closed')),
  notes              text,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One row per market the proposal is shopped to. The *_sent_at stamps ARE the sequence state.
create table if not exists public.proposal_markets (
  id                uuid primary key default gen_random_uuid(),
  proposal_id       uuid not null references public.event_proposals(id) on delete cascade,
  code              text not null references public.geo_region(code),
  day0_sent_at      timestamptz,
  day3_sent_at      timestamptz,
  day10_sent_at     timestamptz,
  day45_sent_at     timestamptz,
  formal_at         timestamptz,                 -- Dan confirmed a date for this market
  formal_sent_at    timestamptz,                 -- the "it's happening" step went out
  event_name        text,
  event_date        date,
  venue             text,
  waitlist_price    text,
  public_price      text,
  deadline          date,
  registration_url  text,
  event_id          uuid,                        -- events_master row once it is a real event
  created_at        timestamptz not null default now(),
  unique (proposal_id, code)
);

-- A hand raised: an organisation that said yes. From a form, a reply Cole credited, or by hand.
create table if not exists public.proposal_signups (
  id           uuid primary key default gen_random_uuid(),
  proposal_id  uuid not null references public.event_proposals(id) on delete cascade,
  code         text not null references public.geo_region(code),
  org          text,
  contact      text,
  source       text not null default 'manual',   -- manual | reply | form
  reply_id     text,                              -- email_replies.id or a Telnyx conversation id
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists proposal_signups_proposal_code_idx on public.proposal_signups (proposal_id, code);

-- The queue row remembers which proposal and which step it carries, so the tick can stamp the
-- step when it sends. get_campaign_queue() is NOT widened for these (45 columns, three callers);
-- the tick and the drafter read them straight off the table for the rows they touch.
alter table public.campaign_queue
  add column if not exists proposal_id   uuid references public.event_proposals(id) on delete set null,
  add column if not exists proposal_step text;

-- ── 4. Read policies: both roles, every time ──────────────────────────────────────────────
alter table public.waitlist_markets  enable row level security;
alter table public.event_proposals   enable row level security;
alter table public.proposal_markets  enable row level security;
alter table public.proposal_signups  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['waitlist_markets','event_proposals','proposal_markets','proposal_signups'] loop
    execute format('drop policy if exists %I_anon_read on public.%I', t, t);
    execute format('drop policy if exists %I_authenticated_read on public.%I', t, t);
    execute format('create policy %I_anon_read on public.%I for select to anon using (true)', t, t);
    execute format('create policy %I_authenticated_read on public.%I for select to authenticated using (true)', t, t);
  end loop;
end $$;

-- ── 5. Writes ──────────────────────────────────────────────────────────────────────────────
create or replace function public.proposal_create(p jsonb)
returns public.event_proposals
language sql security definer set search_path = public as $$
  insert into public.event_proposals
    (name, sport, season, threshold, sender_name, sender_title, waitlist_url, states_count, comparable_market, notes, created_by)
  values (
    coalesce(nullif(btrim(p->>'name'), ''), 'Untitled proposal'),
    nullif(btrim(p->>'sport'), ''),
    nullif(btrim(p->>'season'), ''),
    coalesce((nullif(p->>'threshold',''))::int, 20),
    nullif(btrim(p->>'sender_name'), ''),
    nullif(btrim(p->>'sender_title'), ''),
    nullif(btrim(p->>'waitlist_url'), ''),
    coalesce((nullif(p->>'states_count',''))::int, 30),
    nullif(btrim(p->>'comparable_market'), ''),
    nullif(btrim(p->>'notes'), ''),
    nullif(btrim(p->>'created_by'), '')
  )
  returning *;
$$;

create or replace function public.proposal_update(p_id uuid, p jsonb)
returns public.event_proposals
language sql security definer set search_path = public as $$
  update public.event_proposals set
    name              = coalesce(nullif(btrim(p->>'name'), ''), name),
    sport             = case when p ? 'sport'             then nullif(btrim(p->>'sport'), '')             else sport end,
    season            = case when p ? 'season'            then nullif(btrim(p->>'season'), '')            else season end,
    threshold         = coalesce((nullif(p->>'threshold',''))::int, threshold),
    sender_name       = case when p ? 'sender_name'       then nullif(btrim(p->>'sender_name'), '')       else sender_name end,
    sender_title      = case when p ? 'sender_title'      then nullif(btrim(p->>'sender_title'), '')      else sender_title end,
    waitlist_url      = case when p ? 'waitlist_url'      then nullif(btrim(p->>'waitlist_url'), '')      else waitlist_url end,
    states_count      = coalesce((nullif(p->>'states_count',''))::int, states_count),
    comparable_market = case when p ? 'comparable_market' then nullif(btrim(p->>'comparable_market'), '') else comparable_market end,
    status            = coalesce(nullif(btrim(p->>'status'), ''), status),
    notes             = case when p ? 'notes'             then nullif(btrim(p->>'notes'), '')             else notes end,
    updated_at        = now()
  where id = p_id
  returning *;
$$;

-- Which markets this proposal is shopped to. Adds the new ones; removes the dropped ones ONLY
-- if nothing has been sent to them under this proposal — a market with a Day 0 out is history,
-- and history is not deleted by unticking a box.
create or replace function public.proposal_set_markets(p_id uuid, p_codes text[])
returns setof public.proposal_markets
language plpgsql security definer set search_path = public as $$
begin
  insert into public.proposal_markets (proposal_id, code)
  select p_id, upper(btrim(c)) from unnest(coalesce(p_codes, '{}')) as c
  on conflict (proposal_id, code) do nothing;

  delete from public.proposal_markets
   where proposal_id = p_id
     and code <> all (select upper(btrim(c)) from unnest(coalesce(p_codes, '{}')) as c)
     and day0_sent_at is null and formal_at is null;

  return query select * from public.proposal_markets where proposal_id = p_id order by code;
end $$;

create or replace function public.proposal_signup_add(
  p_proposal uuid, p_code text, p_org text default null, p_contact text default null,
  p_source text default 'manual', p_reply_id text default null, p_by text default null
) returns public.proposal_signups
language sql security definer set search_path = public as $$
  insert into public.proposal_signups (proposal_id, code, org, contact, source, reply_id, created_by)
  values (p_proposal, upper(btrim(p_code)), nullif(btrim(p_org), ''), nullif(btrim(p_contact), ''),
          coalesce(nullif(btrim(p_source), ''), 'manual'), nullif(btrim(p_reply_id), ''), nullif(btrim(p_by), ''))
  returning *;
$$;

create or replace function public.proposal_signup_remove(p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.proposal_signups where id = p_id;
$$;

-- Dan confirms a date for one market. Nothing is sent here: the "formal" step becomes due on
-- the board and goes through the Queue like every other message.
create or replace function public.proposal_market_confirm(p_id uuid, p jsonb)
returns public.proposal_markets
language sql security definer set search_path = public as $$
  update public.proposal_markets set
    formal_at        = coalesce(formal_at, now()),
    event_name       = coalesce(nullif(btrim(p->>'event_name'), ''), event_name),
    event_date       = coalesce((nullif(p->>'event_date',''))::date, event_date),
    venue            = coalesce(nullif(btrim(p->>'venue'), ''), venue),
    waitlist_price   = coalesce(nullif(btrim(p->>'waitlist_price'), ''), waitlist_price),
    public_price     = coalesce(nullif(btrim(p->>'public_price'), ''), public_price),
    deadline         = coalesce((nullif(p->>'deadline',''))::date, deadline),
    registration_url = coalesce(nullif(btrim(p->>'registration_url'), ''), registration_url)
  where id = p_id
  returning *;
$$;

-- Called by api/queue-tick.js after a waitlist row is marked sent. Stamps the step the row
-- carried. Idempotent: a stamp already set is left at its first value.
create or replace function public.proposal_step_sent(p_queue_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q record;
begin
  select proposal_id, proposal_step, state_code into q from public.campaign_queue where id = p_queue_id;
  if q.proposal_id is null or q.proposal_step is null or q.state_code is null then return; end if;
  update public.proposal_markets set
    day0_sent_at   = case when q.proposal_step = 'day0'   then coalesce(day0_sent_at, now())   else day0_sent_at end,
    day3_sent_at   = case when q.proposal_step = 'day3'   then coalesce(day3_sent_at, now())   else day3_sent_at end,
    day10_sent_at  = case when q.proposal_step = 'day10'  then coalesce(day10_sent_at, now())  else day10_sent_at end,
    day45_sent_at  = case when q.proposal_step = 'day45'  then coalesce(day45_sent_at, now())  else day45_sent_at end,
    formal_sent_at = case when q.proposal_step = 'formal' then coalesce(formal_sent_at, now()) else formal_sent_at end
  where proposal_id = q.proposal_id and code = upper(q.state_code);
end $$;

-- ── 6. The board ───────────────────────────────────────────────────────────────────────────
-- One row per US market for one proposal. Reach from the cached state summary (migration 087),
-- cooldown from market_blast_log across EVERY strategy (principle 4: global, 25 days), the
-- sequence state from the stamps, and the step that is due next. A market not yet picked for
-- the proposal is still returned — the board is exhaustive (principle 3) — with in_proposal
-- false, so the UI can offer it.
create or replace function public.waitlist_board(p_proposal uuid default null)
returns table (
  code text, name text, untouched boolean, warm boolean, note text,
  icp_emails bigint, icp_phones bigint, scp_emails bigint, scp_phones bigint, other_emails bigint, other_phones bigint,
  last_blast_any date, days_since_any int, last_blast_waitlist date, held_until date,
  in_proposal boolean, pm_id uuid, signups bigint, threshold int,
  day0_sent_at timestamptz, day3_sent_at timestamptz, day10_sent_at timestamptz, day45_sent_at timestamptz,
  formal_at timestamptz, formal_sent_at timestamptz, event_date date, venue text,
  stage text, step_due text
)
language sql stable security definer set search_path = public as $$
  with cool as (
    select r.cooldown_floor_days from public.decider_rules r where r.id = 1
  ),
  reach as (
    select s.code,
      sum(s.emails) filter (where s.segment = 'ICP')   as icp_emails,
      sum(s.phones) filter (where s.segment = 'ICP')   as icp_phones,
      sum(s.emails) filter (where s.segment = 'SCP')   as scp_emails,
      sum(s.phones) filter (where s.segment = 'SCP')   as scp_phones,
      sum(s.emails) filter (where s.segment not in ('ICP','SCP') or s.segment is null) as other_emails,
      sum(s.phones) filter (where s.segment not in ('ICP','SCP') or s.segment is null) as other_phones
    from public.state_segment_summary_mv s group by s.code
  ),
  hist as (
    select l.market_code as code,
      max(l.sent_on) as last_any,
      max(l.sent_on) filter (where l.strategy = 'event_waitlist') as last_waitlist
    from public.market_blast_log l group by l.market_code
  ),
  su as (
    select s.code, count(*) as n from public.proposal_signups s where s.proposal_id = p_proposal group by s.code
  ),
  base as (
    select w.code, g.name, w.untouched, w.warm, w.note,
      coalesce(r.icp_emails,0) icp_emails, coalesce(r.icp_phones,0) icp_phones,
      coalesce(r.scp_emails,0) scp_emails, coalesce(r.scp_phones,0) scp_phones,
      coalesce(r.other_emails,0) other_emails, coalesce(r.other_phones,0) other_phones,
      h.last_any, (current_date - h.last_any)::int as days_since_any, h.last_waitlist,
      -- 25 days, not the ticket floor: the waitlist doc sets its own global cooldown.
      case when h.last_any is not null and h.last_any + 25 > current_date then h.last_any + 25 end as held_until,
      pm.id as pm_id, (pm.id is not null) as in_proposal,
      coalesce(su.n, 0) as signups, p.threshold,
      pm.day0_sent_at, pm.day3_sent_at, pm.day10_sent_at, pm.day45_sent_at, pm.formal_at, pm.formal_sent_at,
      pm.event_date, pm.venue
    from public.waitlist_markets w
    join public.geo_region g on g.code = w.code
    left join reach r on r.code = w.code
    left join hist  h on h.code = w.code
    left join public.proposal_markets pm on pm.code = w.code and pm.proposal_id = p_proposal
    left join public.event_proposals p on p.id = p_proposal
    left join su on su.code = w.code
  )
  select b.code, b.name, b.untouched, b.warm, b.note,
    b.icp_emails, b.icp_phones, b.scp_emails, b.scp_phones, b.other_emails, b.other_phones,
    b.last_any, b.days_since_any, b.last_waitlist, b.held_until,
    b.in_proposal, b.pm_id, b.signups, b.threshold,
    b.day0_sent_at, b.day3_sent_at, b.day10_sent_at, b.day45_sent_at, b.formal_at, b.formal_sent_at, b.event_date, b.venue,
    case
      when not b.in_proposal                           then 'not_selected'
      when b.formal_sent_at is not null                then 'formal_sent'
      when b.formal_at is not null                     then 'formal'
      when b.threshold is not null and b.signups >= b.threshold then 'enough'
      when b.day0_sent_at is null                      then 'not_asked'
      when b.day45_sent_at is not null                 then 'dormant'
      else 'following_up'
    end as stage,
    case
      when not b.in_proposal                                                   then null
      when b.formal_at is not null and b.formal_sent_at is null                then 'formal'
      when b.formal_at is not null                                             then null
      when b.threshold is not null and b.signups >= b.threshold                then null   -- Dan's call now
      when b.day0_sent_at is null                                              then 'day0'
      when b.day3_sent_at  is null and b.day0_sent_at + interval '3 days'  <= now() then 'day3'
      when b.day10_sent_at is null and b.day0_sent_at + interval '10 days' <= now() then 'day10'
      when b.day45_sent_at is null and b.day0_sent_at + interval '45 days' <= now() then 'day45'
      else null
    end as step_due
  from base b
  order by b.untouched desc, b.in_proposal desc, b.icp_emails desc, b.name;
$$;

grant execute on function public.proposal_create(jsonb)                                   to anon, authenticated, service_role;
grant execute on function public.proposal_update(uuid, jsonb)                             to anon, authenticated, service_role;
grant execute on function public.proposal_set_markets(uuid, text[])                       to anon, authenticated, service_role;
grant execute on function public.proposal_signup_add(uuid, text, text, text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.proposal_signup_remove(uuid)                             to anon, authenticated, service_role;
grant execute on function public.proposal_market_confirm(uuid, jsonb)                     to anon, authenticated, service_role;
grant execute on function public.proposal_step_sent(uuid)                                 to anon, authenticated, service_role;
grant execute on function public.waitlist_board(uuid)                                     to anon, authenticated, service_role;

-- The board filters pick from the live strategy list; Suites and Youth Events step off it for
-- now (John, 2026-10-13: "the ones we have FOR NOW"). Rows kept, templates kept.
update public.offer_strategies set active = false where code in ('suites', 'youth_events');
update public.offer_strategies set active = true  where code in ('ticket_blasts', 'event_waitlist');
