-- 096: Cole's Teammate AI and Event Waitlist templates (2026-10-06).
--
-- Four slugs were named; three change. The same rules as 043 and 089 apply:
--
--   1. TOKENS WHERE THEY RESOLVE. Cole writes each template around one real sport — "baseball
--      organizations", "basketball organizations", "specifically for volleyball" — because he is
--      quoting a send he has in mind. Only [GAME], [DATE] and [SPORT] are substituted (see the
--      validator in api/queue-draft.js), and a hardcoded sport would mail every market about
--      volleyball. So the sport becomes [SPORT] and the rest of his wording is kept verbatim.
--   2. NO [NAME]. One queue row is one blast to a whole market; nothing substitutes per
--      recipient, so a [NAME] would be delivered literally.
--   3. The signature is left exactly as written. Teammate AI is NOT a Playbook play and is not
--      signed "Josh Marcus, CEO of Playbook Sports" — see the note on signers below.
--
-- WHAT CHANGED
--   teammate-sms     rewritten. Was an "early access program" pitch; now names James as
--                    co-founder, lists what the tools actually do (training curriculum, phone
--                    support, marketing automation) and asks for 15 minutes.
--   waitlist-email   was a PLACEHOLDER — the copy lived in a HubSpot sequence and this row only
--                    tracked cooldown. Now Cole's actual copy, so the template can be sent.
--   teammate-email   NOT CHANGED. Cole's version is word-for-word what is already stored, with
--                    "basketball" where the row already carries [SPORT] and one paragraph break
--                    missing. Re-writing it would be churn; it is listed here so the next reader
--                    does not go looking for the diff.
--
-- STILL MISSING: waitlist-sms. Cole's message has the heading "Event Waitlist SMS:" followed by
-- nothing. The row therefore keeps its placeholder, which api/queue-draft.js will reject rather
-- than send — the right failure, since the alternative is mailing a market a line of square
-- brackets. Ask him for it.
--
-- TWO SIGNERS, ON PURPOSE AS FAR AS ANYONE HERE KNOWS: the Teammate email is signed Will and the
-- Teammate SMS is signed James. That split is already in the stored templates and is repeated in
-- Cole's new copy, so it is left alone rather than normalised. If they are meant to be one
-- person, this is the line to change.
--
-- Re-running is safe: plain updates by slug.


-- Teammate AI — SMS -----------------------------------------------------------------------------
-- "specifically for volleyball" -> "specifically for [SPORT]", per rule 1.
update public.message_templates set body =
'Hey this is James, co-founder of Teammate AI. We built AI tools specifically for [SPORT] - training curriculum, phone support, marketing automation, etc. I would love to get your thoughts/feedback. Would you have 15 min to connect?'
 where slug = 'teammate-sms';


-- Event Waitlist — Email ------------------------------------------------------------------------
-- "built for baseball organizations" -> "built for [SPORT] organizations", per rule 1.
--
-- THE SUBJECT IS NOT COLE'S. He sent a body and no subject line, and an email template with a
-- null subject falls back to the queue row's internal title ("[TEST] angels — Anaheim"), which
-- is bookkeeping and would reach the recipient's inbox — the exact bug migration 044 fixed for
-- the ticket blasts. This one is written to match the shape of the others ("AI tools for [SPORT]
-- organizations") and should be confirmed with him.
update public.message_templates set
  subject = 'Event waitlist for [SPORT] organizations',
  body =
'Hey,

This is Will, Co-founder of Teammate AI. We are opening up the waitlist for an upcoming event built for [SPORT] organizations, covering how teams like yours are using AI to automate admin workflows, build custom curriculum for athletes, handle front desk tasks, etc. We would love to have you there since you are the exact kind of organization this event was built for.

Spots are limited, would you like me to add you to the waitlist?

Best,
Will'
 where slug = 'waitlist-email';


-- Event Waitlist — SMS --------------------------------------------------------------------------
-- Deliberately NOT updated. Cole's message leaves this one blank; the placeholder stays so the
-- send path keeps refusing it. Left as an explicit no-op so a future reader can see the omission
-- was noticed rather than missed.
--
-- update public.message_templates set body = '...' where slug = 'waitlist-sms';
