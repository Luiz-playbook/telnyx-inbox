-- 098: fill waitlist-sms with the waitlist email copy, TEMPORARILY (Cole, 2026-10-06).
--
-- 096 left this slug on its placeholder because the source message had the heading "Event
-- Waitlist SMS:" and nothing under it. Cole has asked for the email body to stand in until he
-- writes the real SMS, so the row stops being unsendable.
--
-- THIS IS A STOPGAP AND THE COPY IS WRONG FOR THE CHANNEL. Three things a reader should not have
-- to rediscover before Cole's rewrite lands:
--
--   1. THREE SEGMENTS. 454 characters once [SPORT] is filled. SMS is 160 characters for a single
--      message and 153 per part after that, so every send of this costs 3 segments per recipient
--      rather than 1 — triple the carrier cost of the ticket-blast templates, which sit at 2.
--      On a 12,000-phone market that is 36,000 segments instead of 24,000.
--   2. IT CARRIES AN EMAIL'S FURNITURE. "Hey," on its own line, blank lines between paragraphs,
--      and a "Best,\nWill" sign-off. Those read as an email pasted into a text message, because
--      that is what this is.
--   3. IT SIGNS "Will" WHERE teammate-sms SIGNS "James". The two SMS templates for the same
--      product will disagree about who is texting until this is replaced.
--
-- None of that is worth fixing here. Guessing at a shortened version would mean inventing
-- marketing copy and then having Cole rewrite it anyway; the honest move is to put his words in,
-- say plainly what is wrong with them, and leave the edit to him.
--
-- WHAT TO DO WHEN HIS COPY ARRIVES: replace the body below and delete this whole note. The row
-- needs no other change.
--
-- Re-running is safe: a plain update by slug.

update public.message_templates set body =
'Hey,

This is Will, Co-founder of Teammate AI. We are opening up the waitlist for an upcoming event built for [SPORT] organizations, covering how teams like yours are using AI to automate admin workflows, build custom curriculum for athletes, handle front desk tasks, etc. We would love to have you there since you are the exact kind of organization this event was built for.

Spots are limited, would you like me to add you to the waitlist?

Best,
Will'
 where slug = 'waitlist-sms';
