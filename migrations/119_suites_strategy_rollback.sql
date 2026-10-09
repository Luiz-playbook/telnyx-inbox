-- 119 ROLLBACK: put the Suite templates back under ticket_blasts, re-activate Youth Events,
-- and remove the suites strategy. Any queue row already stamped 'suites' is moved back first so
-- the foreign key does not refuse the delete.

update public.campaign_queue   set strategy = 'ticket_blasts' where strategy = 'suites';
update public.message_templates set strategy = 'ticket_blasts' where strategy = 'suites';
update public.offers            set strategy = 'ticket_blasts' where strategy = 'suites';
update public.offer_strategies  set active = true where code = 'youth_events';
delete from public.offer_strategies where code = 'suites';
