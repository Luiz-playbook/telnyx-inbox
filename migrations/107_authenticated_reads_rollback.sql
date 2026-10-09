-- 107 ROLLBACK: remove the authenticated read policies again.
--
-- Puts the five tables back to anon-only reads, which is the state that made the Inbox tab
-- (and the strategy dropdown, and the group-MMS tables) invisible to anyone signed in. There
-- is no good reason to run this except to prove it is reversible.

do $$
declare t text;
begin
  foreach t in array array['inbox_emails','offers','offer_strategies','mms_groups','mms_group_messages'] loop
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_read', t);
    execute format('revoke select on public.%I from authenticated', t);
  end loop;
end $$;
