-- 118: the rest of the Event Waitlist sequence -- the six templates that had no row at all.
--
-- 117 filled waitlist-sms, the one Event Waitlist slot that existed and was empty. But the
-- strategy (docs/knowledge-base/event-waitlist-strategy.md) is a SIX-message sequence and the
-- table only ever had two Event Waitlist rows, so everything except Day 0 and Day 3 had nowhere
-- to live. 117 listed them as NOT WRITTEN. This migration writes them.
--
-- WHAT GOES IN, AND WHERE IT CAME FROM. Bodies and subjects are the strategy doc verbatim --
-- not the condensed "TEMPLATES (short)" section of the forwarded note, which drops the proof
-- points and renames the tokens. The sequence is six sends, but Day 0 has an ICP and an SCP
-- version, so it is seven pieces of copy. One of them already has a row:
--
--   Day 0   Email #1 ICP     -> waitlist-email-icp   NEW
--   Day 0   Email #1 SCP     -> waitlist-email-scp   NEW
--   Day 3   SMS #1           -> waitlist-sms         exists (117)
--   Day 10  Email #2         -> waitlist-email-2     NEW
--   Day X   Email #3         -> waitlist-email-3     NEW   threshold hit
--   Day X   SMS #2           -> waitlist-sms-2       NEW   threshold hit
--   Day 45  Email #4         -> waitlist-email-4     NEW   only if still below threshold
--
-- COLE'S waitlist-email IS NOT TOUCHED. It keeps sort_order 9 and the Teammate-AI-signed body
-- 096 gave it. Note what that means: the play now holds TWO rival Day 0 emails -- Cole's, which
-- pitches Teammate AI and signs Will, and waitlist-email-icp, which pitches a Playbook Sports
-- event in an untouched state and signs the territory rep. They are different products. Nothing
-- here picks between them, because nobody has said which one Event Waitlist is. Whoever answers
-- that should delete the loser rather than leave both sitting in the tab.
--
-- EVERY ROW IS is_placeholder = true, FOR THE REASON 117 SPELLS OUT AT LENGTH. These carry
-- [First Name], [Org Name], [Metro], [Sender Name], [Comparable Market], [Proof point: ...],
-- [waitlist_link], [registration_link] and more. fillTokens() in api/queue-draft.js resolves
-- [GAME], [DATE] and [SPORT] only, and the LEFTOVER guard (/\[[A-Z][A-Z_ ]{1,20}\]/) matches
-- ALL-CAPS tokens only, so none of these are substituted AND none of them are caught. The
-- placeholder flag is the only thing standing between this copy and a market receiving a literal
-- "[Proof point: turnout, orgs represented, what came out of it]". Do not clear it row by row --
-- clear it when the tokens are either implemented or removed.
--
-- THE SEQUENCE ITSELF IS NOT MODELLED, and these rows do not model it. There is no column for
-- "Day 10", no dependency on a previous send, and no threshold anywhere in this schema -- Email
-- #3 fires "the moment the market clears the signup threshold" and nothing stores signups at all
-- (the doc's own open question 3). `variant` is the obvious place to put a step, but it is
-- already the Ticketblast event-type axis ('initial', 'followup', 'playoffs', 'club-seats')
-- chosen by pickVariant() off the fixture name, and overloading it with sequence positions would
-- break what that function means. So these land as sibling slugs with the step in the NAME. That
-- is a library, not a sequencer: it makes the approved wording visible and editable in the
-- Templates tab, and someone still has to send them in order by hand.
--
-- Email #2's subject is "re: [original subject]" exactly as written. Nothing here implements
-- reply threading, so that string is an instruction to a human, not a feature -- one more reason
-- these rows stay placeholders.
--
-- SENDER. The doc says the from line is "the BDA or AE who owns the territory", which is
-- per-market and therefore not a fixed string. It is recorded as that sentence rather than
-- guessed at, and disagrees on purpose with the 'Josh Marcus, CEO of Playbook Sports' sitting on
-- the two older waitlist rows.
--
-- STRATEGY, AND A DRIFT WORTH FIXING SEPARATELY. These rows are tagged 'event_waitlist'. That
-- code is live in offer_strategies today and both existing waitlist rows already carry it -- but
-- NO MIGRATION IN THIS REPO CREATES IT. 102 seeded 'ticket_blasts' and 'youth_events' only, so
-- the strategy row and the re-tagging were done straight against the database and git cannot
-- reproduce them. The insert below therefore seeds the strategy defensively (on conflict do
-- nothing) so this migration also works on a database built only from these files. The two
-- Teammate AI rows are still mis-tagged 'ticket_blasts' in prod; that is not this migration's
-- business, but someone should fix it.
--
-- Re-running is safe: the strategy seed is on-conflict-do-nothing, and the templates upsert by
-- slug against the partial unique index from 011.

-- The strategy these rows point at. Present in prod already; seeded here so a fresh database
-- satisfies the foreign key without anyone having to remember this was once done by hand.
insert into public.offer_strategies (code, label, offer_type, sort_order) values
  ('event_waitlist', 'Event Waitlist', 'Waitlist', 30)
on conflict (code) do nothing;


insert into public.message_templates
  (slug, name, play, variant, channel, sender, is_placeholder, strategy, sort_order, subject, body) values

-- Day 0 -- the ask. ICP only: personalised, and the doc is explicit that personalisation is
-- earned ("ICPs get it. SCP and below never do").
('waitlist-email-icp', 'Event Waitlist — Email #1 (Day 0, ICP)', 'Event Waitlist', '', 'email',
 'BDA or AE who owns the territory', true, 'event_waitlist', 11,
 'Bringing a [Sport] event to [State]',
 $tpl$Hey [First Name],

We run [Sport] events across [N] states and [State] is not one of them yet. That is a gap, not a decision.

I am building a list of [State] organizations who would want in if we brought a date to [Metro]. No commitment on your side. If enough interest comes back I take it to our events team, we schedule it, and you get first look at dates and pricing before it goes public.

[Personalization hook: their program, their season, something specific]

Worth a spot on the list?

Best,
[Sender Name]
[Sender Title]$tpl$),

-- Day 0 -- the same ask, templated. SCP and non-ICP both get this one; the doc separates those
-- two by CHANNEL (SCP gets CakeMail + SMS, non-ICP gets CakeMail only), not by copy.
('waitlist-email-scp', 'Event Waitlist — Email #1 (Day 0, SCP / non-ICP)', 'Event Waitlist', '', 'email',
 'BDA or AE who owns the territory', true, 'event_waitlist', 12,
 '[Sport] event in [State]?',
 $tpl$Hi there,

We host [Sport] events around the country and have not run one in [State] yet.

We are gauging interest before committing to a date. If you would want early access to dates and pricing for a [State] event, add your organization here:

→ [waitlist_link]

No obligation. We only move forward if there is real demand in the market.

Best,
[Sender Name]
Playbook$tpl$),

-- Day 10 -- the bump. Carries the one thing a cold market has no other source for: evidence that
-- a comparable market started exactly where this one is.
('waitlist-email-2', 'Event Waitlist — Email #2 (Day 10, social proof)', 'Event Waitlist', '', 'email',
 'BDA or AE who owns the territory', true, 'event_waitlist', 13,
 're: [original subject]',
 $tpl$Hey [First Name],

Bumping this on the [State] waitlist.

[Comparable Market] was in the same spot last year, nothing on the calendar. We ran a date there once enough orgs raised their hand. [Proof point: turnout, orgs represented, what came out of it]

Still building the [State] list:

→ [waitlist_link]

Best,
[Sender Name]$tpl$),

-- Threshold hit -- the handoff. This is where Event Waitlist stops being a demand instrument and
-- becomes a ticket blast against a real date, which is why it is the first message in the whole
-- sequence allowed to name a price.
('waitlist-email-3', 'Event Waitlist — Email #3 (threshold hit, date announced)', 'Event Waitlist', '', 'email',
 'BDA or AE who owns the territory', true, 'event_waitlist', 14,
 '[State] is happening: [Event Date]',
 $tpl$Hey [First Name],

You are on the [State] waitlist, so you are hearing this first.

[Event Name] is confirmed for [Event Date] at [Venue].

Waitlist pricing is [Price] and holds until [Deadline]. After that it goes to general release at [Public Price].

→ [registration_link]

Best,
[Sender Name]$tpl$),

-- Threshold hit -- the same moment as Email #3, per the doc ("same time as email").
('waitlist-sms-2', 'Event Waitlist — SMS #2 (threshold hit, date announced)', 'Event Waitlist', '', 'sms',
 'BDA or AE who owns the territory', true, 'event_waitlist', 15, null,
 $tpl$[First Name], the [State] event is confirmed: [Event Date], [Venue]. Waitlist pricing holds until [Deadline]. [registration_link]$tpl$),

-- Day 45 -- only if the market never cleared the threshold. The ask drops from "join the list"
-- to "tell me if anything changed", which is why it is a separate template and not a resend.
('waitlist-email-4', 'Event Waitlist — Email #4 (Day 45, dormant re-ask)', 'Event Waitlist', '', 'email',
 'BDA or AE who owns the territory', true, 'event_waitlist', 16,
 'Still interested in a [State] event?',
 $tpl$Hey [First Name],

We have not hit the number we need to put a [State] date on the calendar. Keeping the list open.

If anything has changed on your end, or you know other [State] organizations who would want in, just reply and let me know.

Best,
[Sender Name]$tpl$)

-- `slug` is a PARTIAL unique index (…where slug is not null), so the predicate has to be
-- restated for Postgres to infer it -- plain `on conflict (slug)` fails with 42P10. Same note as
-- 011, same reason.
on conflict (slug) where slug is not null do update set
  name           = excluded.name,
  play           = excluded.play,
  variant        = excluded.variant,
  channel        = excluded.channel,
  sender         = excluded.sender,
  is_placeholder = excluded.is_placeholder,
  strategy       = excluded.strategy,
  sort_order     = excluded.sort_order,
  subject        = excluded.subject,
  body           = excluded.body;
