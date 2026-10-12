-- Verification for 120. Read-only — run it after applying, or inside a BEGIN/ROLLBACK
-- rehearsal just before the ROLLBACK.
--
-- WHAT IT IS CHECKING FOR, in order of how much it would hurt to get wrong:
--
--   1. THE GRANTS ON get_campaign_queue. A drop takes the function's ACL with it, and the UI's
--      anon key reads the whole Queue tab through this function — so a missed grant is an empty
--      Queue, not an error message. This is the failure mode worth running a check for at all.
--   2. The three new columns are returned, and LAST. PostgREST maps these by position; a column
--      inserted in the middle shifts every one after it. See the 058 note in 120 itself.
--   3. queue_set_email_html exists and is NOT executable by anon. It writes live campaign HTML
--      and is only ever called with the service key from api/cakemail-templates.js.
--   4. Nothing already in the queue was disturbed.

-- 1 + 3. Grants. Expect get_campaign_queue -> anon, authenticated, service_role,
--        readonly_preview (4 rows) and queue_set_email_html -> service_role ONLY (1 row).
select p.proname,
       r.rolname as granted_to
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
join pg_roles r on r.oid = a.grantee
where n.nspname = 'public'
  and p.proname in ('get_campaign_queue', 'queue_set_email_html')
  and a.privilege_type = 'EXECUTE'
order by p.proname, r.rolname;

-- 2. The new columns come back, and they are the last three. Expect exactly:
--    43 strategy | 44 email_html | 45 cakemail_template_id | 46 cakemail_template_name
select ordinality as position, name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral unnest(p.proargnames) with ordinality as t(name, ordinality)
where n.nspname = 'public' and p.proname = 'get_campaign_queue'
order by ordinality desc
limit 4;

-- 2b. And the function still actually runs. Expect one row with the three new columns null,
--     because nothing has been attached yet.
select id, title, email_html, cakemail_template_id, cakemail_template_name
from public.get_campaign_queue()
limit 1;

-- 4. The columns exist on the table and nothing was rewritten. attached should be 0 before the
--    first use of the picker; total should match what the Queue tab showed beforehand.
select count(*) as total,
       count(email_html) as attached
from public.campaign_queue;
