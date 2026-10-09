-- 119: Suites is a strategy; Youth Events steps back (John, 2026-10-09).
--
-- THE THREE PLAYS SENDBLASTER RUNS ARE TICKET BLASTS, SUITES AND EVENT WAITLIST. Cole's Suite
-- templates have existed since 011 (suite-email, suite-sms) with nowhere to belong, so they
-- were tagged 'ticket_blasts' by the 102 backfill and showed up under Ticket Blasts in every
-- filter. This gives them their own row on the menu and moves them under it.
--
-- YOUTH EVENTS IS DEACTIVATED, NOT DELETED. AI-1076 still refers to it, migration 114 named a
-- venue table for it, and a strategy code is a foreign key target - dropping the row would be a
-- larger change than the ask ("replace youth_events with suites"), and active=false is what the
-- UI reads: loadStrategies() selects active rows only, so it leaves the filter, the picker and
-- the Offer/Type columns at once. Re-activating it is one UPDATE.
--
-- TEAMMATE AI IS NOT TOUCHED. Its two rows stay 'ticket_blasts' (118 called this out as a
-- mis-tag). Nobody has said whether it is its own play or part of Suites, so it waits.
--
-- No column changes. Everything here is data, which is why it was also applied to prod directly;
-- the file exists so a database built from these migrations ends up in the same state.

insert into public.offer_strategies (code, label, offer_type, active, sort_order)
values ('suites', 'Suites', 'Suites', true, 20)
on conflict (code) do update set label = excluded.label, offer_type = excluded.offer_type, active = true, sort_order = excluded.sort_order;

update public.offer_strategies set active = false where code = 'youth_events';

update public.message_templates set strategy = 'suites' where play = 'Suite';
