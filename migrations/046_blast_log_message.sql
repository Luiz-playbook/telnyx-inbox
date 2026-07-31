-- Keep the COPY that was actually sent, not just the fact that a send happened.
--
-- ticketblaster_market_blasts_log records market, channel, recipient count and date, but
-- had nowhere for the message body. The Textable history imported on 2026-07-31 therefore
-- landed as metadata only, and the copy — which is the part worth learning from — lived
-- solely in the screenshots it came from.
--
-- This matters beyond record-keeping: those bodies are the real, sent variants behind the
-- template work in migration 043. "Bengals Season Opener", "Blue Jays Club Seat",
-- "Pirates Suite", "Miami Marlins Suite Last Call" are the season-opener / club-seats /
-- suite / followup pitches as Cole actually wrote them.

alter table public.ticketblaster_market_blasts_log
  add column if not exists message text;

comment on column public.ticketblaster_market_blasts_log.message is
  'The copy actually sent for this blast. Null for rows recorded by the send path, which logs the send rather than the body; populated for imported history.';

-- Backfill the 2026-07-31 Textable import. Matched on template_name because these rows
-- carry no event_id — they predate the queue and were sent from Textable, not from here.
update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a few early access tickets to the Broncos week 13 game that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick 20 minutes call sometime this week or next to see if it makes sense?'
 where template_name = 'Broncos Week 13 Blast' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a couple Blue Jays Club Seats for the game on 6/26, that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Blue jays Club Seat Blast 6/22' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a few Bengals season opener tickets on 9/13 that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Bengals Season Opener Blast' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a few Cowboys Home opener tickets on 9/20 that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Cowboys Home Opener Blast' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a few Falcons Home opener tickets on 9/20 that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Falcons Home Opener Blast' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a few Buccaneers Home opener tickets on 9/20 that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Bucs Home Opener Blast' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a few Saints Home opener tickets on 9/27 that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Saints Home Opener' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a few Texans Home opener tickets on 9/20 that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Texans Home Opner' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. We have a few Pirates Club Tickets for the game on 6/23, that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Pirates Suite Blast' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey, it''s Josh Marcus, CEO/Founder of Playbook. Just wanted to follow up as we still have a couple extra Miami Marlins Fiesta Suite tickets for the game tomorrow, 6/10, that we''d be happy to donate as a thank you gesture for taking a demo for our software. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship & rev-share opportunities. Are you free for a quick demo today or sometime this week to see if it makes sense?'
 where template_name = 'Miami Marlins Suite Last Call' and source = 'textable';

update public.ticketblaster_market_blasts_log set message =
'Hey this is James, co-founder of Teammate AI. We built AI tools specifically for volleyball - training curriculum, phone support, marketing automation, etc. I would love to get your thoughts/feedback. Would you have 15 min to connect?'
 where template_name = 'Test Teammate AI' and source = 'textable';

-- Verify: expect 11 of 11.
--   select count(*) filter (where message is not null) as with_copy, count(*) total
--   from public.ticketblaster_market_blasts_log where source = 'textable';
