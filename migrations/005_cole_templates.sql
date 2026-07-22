-- Cole's per-play/per-channel outreach copy, promoted into message_templates so the
-- Marketing Blaster Templates tab can read AND edit it (that table already grants anon
-- full CRUD — see 004). Additive: new columns only, no type changes, no drops.
--
-- Before this, the table held 8 rows that were snapshots of individual sends: they
-- hardcoded one game each ("Dolphins Home Opener on 9/27", "volleyball organizations")
-- instead of the [GAME]/[DATE]/[SPORT] tokens, drifted across four different sign-offs,
-- and every row was tagged channel='sms' including the four named [Email]. This migration
-- replaces those bodies with the canonical templated copy, fixes channel, and adds the
-- two Event Waitlist rows that were missing.

alter table public.message_templates
  add column if not exists slug           text,
  add column if not exists play           text,
  add column if not exists variant        text,
  add column if not exists sender         text,
  add column if not exists is_placeholder boolean not null default false,
  add column if not exists sort_order     integer;

comment on column public.message_templates.slug is 'Stable key for the shipped Cole templates (tb-email-1, suite-sms, …). Null for ad-hoc rows created in the UI.';
comment on column public.message_templates.sender is 'Sender identity is fixed per play/channel and travels with the template (Josh / Will / James).';
comment on column public.message_templates.is_placeholder is 'True where the real copy still lives in a HubSpot sequence — the body is a prompt to paste it, not sendable outreach.';

create unique index if not exists message_templates_slug_key
  on public.message_templates(slug) where slug is not null;

-- Adopt the 8 pre-existing rows by name so their ids (and anything referencing them) survive.
update public.message_templates set slug = 'tb-email-1'     where slug is null and name = '[Email] Ticketblast';
update public.message_templates set slug = 'tb-email-2'     where slug is null and name = '[Email] Ticketblast Followup';
update public.message_templates set slug = 'suite-email'    where slug is null and name = '[Email] Suite';
update public.message_templates set slug = 'teammate-email' where slug is null and name = '[Email] Teammate AI';
update public.message_templates set slug = 'tb-sms-1'       where slug is null and name = '[SMS] Ticket Blast';
update public.message_templates set slug = 'tb-sms-2'       where slug is null and name = '[SMS] Ticketblast Followup';
update public.message_templates set slug = 'suite-sms'      where slug is null and name = '[SMS] Suite';
update public.message_templates set slug = 'teammate-sms'   where slug is null and name = '[SMS] Teammate AI (Volleyball)';

insert into public.message_templates (slug, name, play, variant, channel, sender, is_placeholder, sort_order, subject, body) values

('tb-email-1', 'Ticketblast — Email (initial)', 'Ticketblast', 'initial', 'email',
 'Josh Marcus — CEO & Co-Founder | Playbook Sports', false, 1, 'Early access tickets — [GAME]',
 $tpl$Good morning,

My name is Josh Marcus, CEO & Co-Founder | Playbook Sports. We provide tools designed to automate the day-to-day processes of sports organizations, and help business owners save time normally spent completing administrative tasks.

We also have a couple early access tickets for the [GAME] on [DATE], that I'd be happy to donate as a gesture of appreciation for your time if you're interested in taking a demo of our platform.

Are you free to connect today or sometime this week?

Best,
Josh Marcus
CEO & Co-Founder | Playbook Sports$tpl$),

('tb-email-2', 'Ticketblast — Email (followup)', 'Ticketblast', 'followup', 'email',
 'Josh Marcus — CEO & Co-Founder | Playbook Sports', false, 2, 'Following up — [GAME] tickets',
 $tpl$Good morning,

Just wanted to follow up here. We still have a couple extra tickets to the [GAME] on [DATE]

I'd love to donate a couple to your organization if you're interested in taking a look at some of the new AI tools & sponsorship opportunities we've built over at Playbook to make it easier to run your business.

Best,
Josh Marcus
CEO & Co-Founder | Playbook Sports$tpl$),

('tb-sms-1', 'Ticketblast — SMS (initial)', 'Ticketblast', 'initial', 'sms',
 'Josh Marcus', false, 3, null,
 $tpl$Hey, it's Josh Marcus, CEO & Co-Founder | Playbook Sports. We have a few [GAME] tickets on [DATE] that we'd be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?$tpl$),

('tb-sms-2', 'Ticketblast — SMS (followup)', 'Ticketblast', 'followup', 'sms',
 'Josh Marcus', false, 4, null,
 $tpl$Hey this is Josh Marcus following up on my previous message. We still have a couple tickets to the [GAME] on [DATE] that I'd love to donate to your program. Additionally I would be delighted to go into our new sponsorship programs!
Around for a quick 20-30 minute call sometime this week or next?$tpl$),

('suite-email', 'Suite — Email', 'Suite', '', 'email',
 'Josh Marcus — CEO & Co-Founder | Playbook Sports', false, 5, 'VIP Suite invite — [GAME]',
 $tpl$Good morning, Josh Marcus, CEO & Co-Founder | Playbook Sports here.
I was looking at sports organizations around the area and yours caught my eye right away. We wanted to invite you to a vip Suite event we are hosting at the [GAME] on [DATE]

We work with sports organizations to simplify the operational side of running programs; registration, scheduling, payments, reporting, communication workflows, and other backend processes that typically create unnecessary admin overhead for staff.
We've also started rolling out new sponsorship and rev share opportunities and we thought of your organization right away.
Would you be open to a quick 20 minute call sometime this week?

Best,
Josh Marcus
CEO & Co-Founder | Playbook Sports$tpl$),

('suite-sms', 'Suite — SMS', 'Suite', '', 'sms',
 'Josh Marcus', false, 6, null,
 $tpl$Hey, it's Josh Marcus, CEO & Co-Founder | Playbook Sports. We have a few [GAME] that we'd be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?$tpl$),

('teammate-email', 'Teammate AI — Email', 'Teammate AI', '', 'email',
 'Will — Co-founder, Teammate AI', false, 7, 'AI tools for [SPORT] organizations',
 $tpl$Hey,

This is Will, Co-founder of Teammate AI.

We built AI tools for [SPORT] organizations to automate admin workflows, create and assign customizable curriculum for your athletes, handle front desk tasks, etc. We would love to get your feedback since you are the exact kind of organization we have built it for.

Would you have 15 minutes to connect in the next week or so?

Best,
Will$tpl$),

('teammate-sms', 'Teammate AI — SMS', 'Teammate AI', '', 'sms',
 'James — Teammate AI', false, 8, null,
 $tpl$Hey, this is James with Teammate AI - we partner with [SPORT] organizations to automate admin work. We were looking for a couple of organizations to enter in our early access program to some of our newer features and thought you might be interested.$tpl$),

('waitlist-email', 'Event Waitlist — Email', 'Event Waitlist', '', 'email',
 'Josh Marcus', true, 9, null,
 $tpl$[Placeholder — Event Waitlist copy lives in a HubSpot sequence today, not written locally yet. Paste the current [SPORT] waitlist sequence text here before sending, or use this row only to track cooldown/eligibility for this market.]$tpl$),

('waitlist-sms', 'Event Waitlist — SMS', 'Event Waitlist', '', 'sms',
 'Josh Marcus', true, 10, null,
 $tpl$[Placeholder — paste the current [SPORT] waitlist SMS sequence text here before sending.]$tpl$)

-- `slug` is a PARTIAL unique index (…where slug is not null), so the predicate has to be
-- restated here for Postgres to infer it — plain `on conflict (slug)` fails with 42P10.
on conflict (slug) where slug is not null do update set
  name           = excluded.name,
  play           = excluded.play,
  variant        = excluded.variant,
  channel        = excluded.channel,
  sender         = excluded.sender,
  is_placeholder = excluded.is_placeholder,
  sort_order     = excluded.sort_order,
  subject        = excluded.subject,
  body           = excluded.body;
