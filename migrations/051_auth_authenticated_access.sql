-- Let a SIGNED-IN user do everything the anonymous one can. Additive only.
--
-- WHY THIS IS SPLIT IN TWO. Closing the hole means two moves: give `authenticated` access
-- (this file) and take it away from `anon` (052). Only the second one can break anything, and
-- what it breaks lives outside this repo — the n8n workflows and the OpenClaw VPS both talk to
-- this database with the published anon key. So the safe half lands now, on its own: the app
-- starts working for signed-in users while every existing anonymous caller keeps working
-- exactly as before. Nothing is revoked here. 052 does that, once the other callers have moved.
--
-- WHAT WAS ALREADY IN PLACE. `authenticated` turned out to hold execute on all 42 of this
-- app's functions and select/insert/update/delete on all five tables — Supabase grants both
-- roles the same thing by default, and no migration ever narrowed it. The RPC surface
-- therefore needs NOTHING here: those functions are security definer, so the grant is the
-- whole gate and it is already open.
--
-- What is missing is RLS. The five tables the browser reads directly carry policies written
-- `to anon` only, so a signed-in session — which arrives as `authenticated`, not `anon` —
-- matches no policy and reads zero rows. Signing in would have BROKEN the app. These policies
-- are what stop that.
--
-- SCOPE OF THE GATE. Any @callplaybook.com Google account, and nothing narrower. Supabase
-- issues one role for every logged-in user, so `authenticated` cannot distinguish this app's
-- users from the other project's on this same instance — and both are Playbook staff, so the
-- distinction would not mean much anyway. The domain itself is enforced upstream: the Google
-- consent screen is Internal, so Google refuses non-Playbook accounts at sign-in, and
-- ui/index.html signs out anything that slips past. The move being made here is
-- anyone-with-the-URL -> anyone-with-a-Playbook-login. That is the whole point; separating
-- staff from staff is a different, much smaller problem and is not attempted.
--
-- Mirrors of the existing anon policies, deliberately: same commands, same `true` predicate.
-- Any narrowing belongs in its own migration, where it can be reasoned about on its own.
-- Permissive policies OR together, so these coexist with the anon ones until 052 drops those.

-- Read-only tables (the anon policy is SELECT-only; these match it).
create policy blast_templates_authed_select on public.blast_templates
  for select to authenticated using (true);

create policy price_runs_authed_read on public.events_master_price_runs
  for select to authenticated using (true);

create policy icp_events_authed_select on public.icp_events
  for select to authenticated using (true);

-- Read-write tables. The Templates tab edits message_templates and the number sync writes
-- telnyx_numbers, so a signed-in user needs the same ALL the anon policy grants — otherwise
-- signing in would make the app read-only.
create policy message_templates_authed_all on public.message_templates
  for all to authenticated using (true) with check (true);

create policy telnyx_numbers_authed_all on public.telnyx_numbers
  for all to authenticated using (true) with check (true);
