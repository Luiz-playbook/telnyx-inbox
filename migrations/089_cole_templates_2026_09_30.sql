-- 089: Cole's updated SMS templates (email "Updated Templates", 2026-09-30).
--
-- Cole sent three SMS bodies, each written around one real game. They replace the same three
-- slugs, tokenized the way migration 043 set out, and its three rules still hold:
--
--   1. SENDER. Every Playbook play is signed "Josh Marcus, CEO of Playbook Sports". Cole's text
--      says "CEO/Founder of Playbook" and "Josh, CEO/Co-Founder of Playbook"; those are
--      normalised to the one form, as 043 did for his earlier drift.
--   2. TOKENS ONLY WHERE THEY RESOLVE. His example games become [GAME] and [DATE], which
--      api/queue-draft.js fills at queue time. No [NAME]: one queue row is one blast to a whole
--      market and nothing substitutes per recipient.
--   3. "early access tickets" is gone from the regular body, per Josh's feedback on the first run
--      ("we just don't want to say early access tickets anymore").
--
-- WHAT CHANGED vs 043
--   tb-sms-1          "a few early access tickets" -> "a couple tickets"; call length 20 -> 30 minutes;
--                     "sponsorship & rev-share" -> "sponsorship"
--   tb-sms-playoffs   rewritten as an invitation to a playoff game (was "I held onto a few tickets")
--   suite-sms         now the all-inclusive Pregame Huddle tailgate pitch (was a luxury suite)
--
-- JUDGEMENT CALLS, so nobody has to rediscover them
--   * Playoffs: Cole's example says "wildcard tickets for Game 2 or 3 if need be". Which game is
--     specific to one series, so it is not tokenized. The body says "[GAME] playoff tickets".
--   * Suite/Event: Cole's example names the "Pregame Huddle tailgate experience" around an Ohio State
--     game. That is one event, not a template for every suite, so the body keeps his wording about
--     the tailgate but takes the game from [GAME]/[DATE]. If suites are also sold WITHOUT a tailgate,
--     that wants its own variant rather than this one.
--   * The line "Playbook helps sports organizations..." is the same in all three, as he wrote it.
--
-- Re-running is safe: plain updates by slug.

update public.message_templates set body =
'Hey, it''s Josh Marcus, CEO of Playbook Sports. We have a couple tickets to the [GAME] on [DATE] that we''d be happy to donate as a thank you gesture for taking a demo for our software.

Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship opportunities.

Are you free for a quick 30 minute demo call sometime today or this week to see if it makes sense?'
 where slug = 'tb-sms-1';

update public.message_templates set body =
'Hey, it''s Josh Marcus, CEO of Playbook Sports. We wanted to invite you out with a couple [GAME] playoff tickets on [DATE] that we''d be happy to donate as a thank you gesture for taking a demo for our software.

Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more while offering sponsorship opportunities.

Are you free for a quick 30 minute demo call sometime today or this week to see if it makes sense?'
 where slug = 'tb-sms-playoffs';

update public.message_templates set body =
'Good afternoon, Josh Marcus, CEO of Playbook Sports here. I wanted to personally invite you to an all-inclusive event we''re hosting around the [GAME] on [DATE] as a thank you for taking a demo with us.

We have a limited number of spots available for the Pregame Huddle tailgate experience, including food, drinks and game tickets. Playbook helps sports organizations manage scheduling, communication, reporting, marketing and more, while also offering sponsorship opportunities.

If it makes sense for your organization, would you be free to connect today or sometime this week?'
 where slug = 'suite-sms';
