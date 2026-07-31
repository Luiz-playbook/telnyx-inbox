-- Cole's refreshed outreach copy (supplied 2026-07-31), tokenized, plus the three
-- event-type Ticketblast variants the table had no concept of.
--
-- WHY THIS EXISTS. api/queue-draft.js builds a queued blast's copy from these rows, so
-- the rows have to be (a) tokenized and (b) complete enough that every game type has a
-- template. Before this the table knew two variants — 'initial' and 'followup' — and a
-- season opener, a playoff game and a club-seat offer all got the same generic body.
--
-- THREE RULES BAKED IN HERE
--
-- 1. SENDER. Every Playbook play is signed "Josh Marcus, CEO of Playbook Sports" — one
--    form, no variants. Cole's source text drifted across "CEO/Founder of Playbook",
--    "Josh, CEO/CoFounder of Playbook" and "Josh CEO of Playbook"; the table itself had a
--    fourth ("CEO & Co-Founder | Playbook Sports"). Teammate AI is deliberately NOT
--    touched: that copy is signed by Teammate AI's own co-founder, a different company,
--    and Josh signing it would be false.
--
-- 2. TOKENS ONLY WHERE THEY RESOLVE. [GAME] and [DATE] are per-blast and are filled at
--    QUEUE time by api/queue-draft.js. [NAME] must never appear in any body that can be
--    queued: one queue row is one blast to a whole market, and api/queue-tick.js sends
--    email_copy verbatim with no substitution — a surviving [NAME] would go out literally
--    to every recipient. Cole's copy opens "Hey," with no name, which is what makes this
--    safe. Do not reintroduce a per-recipient token here.
--
-- 3. COLE'S SOURCE TEXT IS SMS-SHAPED. The bodies below land on the sms rows. The email
--    rows keep their existing structure (greeting, paragraphs, subject, sign-off) and get
--    only the sign-off normalised, because Cole supplied no email rewrite. The three new
--    variants are SMS-only for the same reason — see the notice at the bottom.

-- ---------------------------------------------------------------------------
-- 1. Sender identity — one form across every Playbook play.
-- ---------------------------------------------------------------------------
update public.message_templates
   set sender = 'Josh Marcus, CEO of Playbook Sports'
 where slug in ('tb-email-1','tb-email-2','tb-sms-1','tb-sms-2',
                'suite-email','suite-sms','waitlist-email','waitlist-sms');

-- Existing email bodies keep their copy; only the identity is normalised. TWO forms appear
-- and both have to go, or the same email introduces Josh one way and signs off another:
--   sign-off block ..... "Josh Marcus\nCEO & Co-Founder | Playbook Sports"
--   inline, mid-sentence "My name is Josh Marcus, CEO & Co-Founder | Playbook Sports."
-- The newline form is replaced first so the inline pass cannot eat half of it.
update public.message_templates
   set body = replace(
        replace(body,
          E'Josh Marcus\nCEO & Co-Founder | Playbook Sports',
          E'Josh Marcus, CEO of Playbook Sports'),
        'Josh Marcus, CEO & Co-Founder | Playbook Sports',
        'Josh Marcus, CEO of Playbook Sports')
 where slug in ('tb-email-1','tb-email-2','suite-email');

-- ---------------------------------------------------------------------------
-- 2. Refreshed SMS bodies (Cole 2026-07-31), tokenized.
--    These REPLACE the previous bodies for the same slugs — same templates, newer text.
-- ---------------------------------------------------------------------------
update public.message_templates set body =
'Hey, it''s Josh Marcus, CEO of Playbook Sports. We have a few early access tickets to the [GAME] on [DATE] that we''d be happy to donate as a thank you gesture for taking a demo for our software.

Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities.

Are you free for a quick 20 minutes call sometime today or this week to see if it makes sense?'
 where slug = 'tb-sms-1';

update public.message_templates set body =
'Hey this is Josh following up on my previous message. We still have a couple tickets to the [GAME] on [DATE] that I''d love to donate to your program. Additionally would be delighted to go into our new sponsorship programs!

Around for a quick 20-30 minute call sometime today or next week?'
 where slug = 'tb-sms-2';

update public.message_templates set body =
'Good afternoon, Josh Marcus, CEO of Playbook Sports here. I wanted to personally invite you to a luxury suite for the [GAME] on [DATE], as a thank you if you were to take a demo with us.

Playbook helps sports organizations like yours automate day-to-day operations and save valuable time spent on admin work.

If it makes sense for you, would you be free to connect today or sometime this week?'
 where slug = 'suite-sms';

-- ---------------------------------------------------------------------------
-- 3. New event-type variants. A season opener, a playoff game and a club-seat offer are
--    different pitches; queue-draft picks between them from the event itself.
-- ---------------------------------------------------------------------------
insert into public.message_templates
  (slug, name, play, variant, channel, sender, is_placeholder, sort_order, subject, body)
values
('tb-sms-season-opener', 'Ticketblast — SMS (season opener)', 'Ticketblast', 'season-opener', 'sms',
 'Josh Marcus, CEO of Playbook Sports', false, 3, null,
'Hey, it''s Josh Marcus, CEO of Playbook Sports. We have a few [GAME] tickets on [DATE] that we''d be happy to donate as a thank you gesture for taking a demo for our software.

Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities.

Are you free for a quick 20 minutes call sometime today or this week to see if it makes sense?'),

('tb-sms-playoffs', 'Ticketblast — SMS (playoffs)', 'Ticketblast', 'playoffs', 'sms',
 'Josh Marcus, CEO of Playbook Sports', false, 4, null,
'Hey, it''s Josh Marcus, CEO of Playbook Sports. I held onto a few [GAME] tickets on [DATE] for some organizations I think we''d work well with.

We''ve been helping organizations streamline operations with some new & improved tools to alleviate back end work and I think there could be a strong fit. We''d also be happy to walkthrough our new sponsorship opportunities!

Would you be around for a quick conversation sometime today, or later this week?'),

('tb-sms-club-seats', 'Ticketblast — SMS (club seats)', 'Ticketblast', 'club-seats', 'sms',
 'Josh Marcus, CEO of Playbook Sports', false, 5, null,
'Hey, it''s Josh Marcus, CEO of Playbook Sports. We have a few all-inclusive Club Seats for the [GAME] on [DATE], that we''d be happy to donate as a thank you gesture for taking a demo for our software.

Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities.

Are you free for a quick demo today or sometime this week to see if it makes sense?')

-- The unique index on slug is PARTIAL (`where slug is not null`, migration 011), so the
-- conflict target has to carry the same predicate or Postgres cannot match it and the
-- statement fails with "no unique or exclusion constraint matching the ON CONFLICT
-- specification". Re-running this migration is meant to be safe.
on conflict (slug) where slug is not null do update
  set name = excluded.name, play = excluded.play, variant = excluded.variant,
      channel = excluded.channel, sender = excluded.sender,
      is_placeholder = excluded.is_placeholder, sort_order = excluded.sort_order,
      subject = excluded.subject, body = excluded.body;

-- ---------------------------------------------------------------------------
-- NOT DONE HERE — deliberate gaps, so nothing silently ships half-built.
--
-- • No EMAIL variant for season-opener / playoffs / club-seats. Cole supplied one body per
--   variant and it is SMS-shaped (no subject, no greeting block). Writing an email version
--   would mean authoring copy nobody approved. api/queue-draft.js falls back to the
--   'initial' email template for these variants and reports that it did.
--
-- • Event Waitlist stays is_placeholder = true. Cole's text for it reads "Attached is one
--   we did at SoFi" — api/queue-tick.js has no attachment support on either the CakeMail
--   or the Gmail route, so that sentence would ship referring to nothing. It also names
--   Will, not Josh. Resolve both before promoting it.
--
-- • Teammate AI untouched (rule 1 above).
-- ---------------------------------------------------------------------------
