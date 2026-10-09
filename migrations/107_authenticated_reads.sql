-- 107: let signed-in users read what anon can read.
--
-- THE BUG. Migrations 090, 093 and 094 each created a table and gave it one read policy,
-- `for select to anon`. That is the key the UI holds in config.js, so it looked right. But the
-- app signs people in, and once a Supabase session exists the browser client sends the
-- user's token instead of the anon key - so every query from a logged-in person runs as role
-- `authenticated`, which these tables had no policy for. Row-level security answers that with
-- zero rows and no error. The Inbox tab showed "0 / 0 / never" over a table holding 257 rows.
--
-- Every older table the UI reads (email_replies, message_templates, do_not_contact) carries
-- BOTH roles, which is the convention this should have followed.
--
-- One policy per table, for the pair, so anon (logged-out, preview, thumbnail) and
-- authenticated (everyone actually using the app) see the same thing. Writes are unchanged:
-- they stay with the service role.

do $$
declare t text;
begin
  foreach t in array array['inbox_emails','offers','offer_strategies','mms_groups','mms_group_messages'] loop
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_authenticated_read', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- VERIFY. Every row should say true:
--
--   select tablename, bool_or('authenticated' = any(roles)) as authenticated_can_read
--   from pg_policies where schemaname='public'
--     and tablename in ('inbox_emails','offers','offer_strategies','mms_groups','mms_group_messages')
--   group by tablename;
