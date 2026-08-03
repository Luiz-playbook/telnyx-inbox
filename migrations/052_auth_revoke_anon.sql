-- Close the door: the published anon key stops being a working credential.
--
-- ============================================================================
-- DO NOT APPLY THIS UNTIL EVERY ANONYMOUS CALLER HAS MOVED. IT IS THE BREAKING HALF.
-- ============================================================================
--
-- scripts/gen-config.js writes SUPABASE_ANON_KEY into ui/config.js, which is served to every
-- visitor of telnyx-inbox.vercel.app. Until this migration runs, that public key can read the
-- queue, rewrite Cole's templates and enqueue blasts — the app has no gate at all, it just has
-- a URL nobody guessed. This file is what makes a Playbook login actually required.
--
-- PRE-FLIGHT. Three consumers authenticate with the anon key today. Each must be moved first
-- or it goes down the moment this runs:
--
--   1. api/ routes (this repo) — DONE, commit 7c17ca8. They resolve their key through
--      lib/supabase.js, which prefers SUPABASE_SERVICE_ROLE_KEY. Confirm that variable is set
--      in Vercel for every environment and that a deploy has picked it up. Service role
--      bypasses grants and RLS entirely, so nothing below touches them.
--
--   2. The OpenClaw VPS — NOT DONE, and owned by another developer. ~/.openclaw/supabase.env
--      holds SUPABASE_ANON_KEY, and OPENCLAW.md §6 is explicit that the agent reaches the
--      "same Supabase RPCs the website uses (same anon key)". Revoking below removes the
--      agent's entire capability set: the daily-campaign-queue cron, daily-price-refresh, and
--      every queue edit it makes. Fix is the same one the api/ routes took — put the
--      service-role key in that file. The agent loses no safety by it: its guardrails
--      (cooldown, send allowlist, validation) live INSIDE these functions, not in RLS.
--
--   3. n8n — CLEARED, confirmed 2026-08-04. The workflows authenticate with the secret
--      (service_role) key, not the anon one. Service role bypasses grants and RLS, so nothing
--      below reaches them — including the telnyx_numbers policy drop, which is what
--      telnyx-sync-numbers writes through.
--
-- The other project on this instance (the Next.js sales-hub) is NOT at risk: its API routes
-- run service-role, and its browser client touches a different set of tables.
--
-- ROLLBACK is 051 in reverse — re-grant anon. Keep that in mind rather than reaching for a
-- restore; nothing here destroys data.

-- ---------------------------------------------------------------------------
-- 1. Tables — drop the anonymous policies. 051's authenticated mirrors take over.
-- ---------------------------------------------------------------------------
-- The two ALL policies are the sharp end: today the public key can rewrite Cole's templates
-- and the Telnyx number list.
drop policy if exists blast_templates_anon_select  on public.blast_templates;
drop policy if exists price_runs_anon_read         on public.events_master_price_runs;
drop policy if exists icp_events_anon_select       on public.icp_events;
drop policy if exists message_templates_anon_all   on public.message_templates;
drop policy if exists telnyx_numbers_anon_all      on public.telnyx_numbers;

-- ---------------------------------------------------------------------------
-- 2. Functions — revoke anon's execute.
-- ---------------------------------------------------------------------------
-- These are security definer, so RLS never applied to them and the grant IS the gate. This is
-- the part that actually matters: the queue, the decider and every send-adjacent write live
-- here, not in the tables above.
--
-- Named one by one on purpose. `public` holds ~290 anon-executable functions and most belong
-- to other projects sharing this instance; a blanket revoke over the schema would take them
-- all out. Overloads are listed separately because a revoke names one signature.
--
-- `authenticated` already holds execute on every one of these (verified before writing 051),
-- so no matching grant is needed — this only removes the anonymous half.

-- queue: read + edit
revoke execute on function public.get_campaign_queue()                                      from anon;
revoke execute on function public.queue_plan(date, date)                                   from anon;
revoke execute on function public.queue_enqueue_test(jsonb)                                 from anon;
revoke execute on function public.queue_set_copy(uuid, text, text)                          from anon;
revoke execute on function public.queue_set_email_subject(uuid, text)                       from anon;
revoke execute on function public.queue_set_sender(uuid, text, text)                        from anon;
revoke execute on function public.queue_set_schedule(uuid, timestamptz)                     from anon;
revoke execute on function public.queue_set_channels(uuid, boolean, boolean)                from anon;
revoke execute on function public.queue_snooze(uuid, integer)                               from anon;
revoke execute on function public.queue_confirm(uuid)                                       from anon;
revoke execute on function public.queue_reject(uuid, text)                                  from anon;
revoke execute on function public.queue_unreject(uuid)                                      from anon;
revoke execute on function public.queue_rejections(integer)                                 from anon;
revoke execute on function public.queue_archive(uuid)                                       from anon;
revoke execute on function public.queue_unarchive(uuid)                                     from anon;
revoke execute on function public.queue_delete(uuid, text)                                  from anon;
revoke execute on function public.update_queue_row(uuid, jsonb)                             from anon;

-- queue: the send path. Written by api/queue-tick.js (service role) and by nothing else —
-- OPENCLAW.md §6 lists these under what the agent must NEVER call, because faking a send
-- corrupts the cooldown history that protects future blasts.
revoke execute on function public.queue_mark_sent(uuid, text)                               from anon;
revoke execute on function public.log_market_blast(text, text, text, uuid, text)            from anon;
revoke execute on function public.log_market_blast(jsonb)                                   from anon;
revoke execute on function public.upsert_salesmsg_broadcasts(jsonb)                         from anon;

-- markets, recipients, geography. market_emails / market_phones resolve real customer
-- addresses and phone numbers — the most sensitive read in the app.
revoke execute on function public.market_emails(text, text)                                 from anon;
revoke execute on function public.market_phones(text, text)                                 from anon;
revoke execute on function public.market_recipient_counts()                                 from anon;
revoke execute on function public.market_recipient_counts_by_segment()                      from anon;
revoke execute on function public.markets_with_contacts()                                   from anon;
revoke execute on function public.market_cooldowns()                                        from anon;
revoke execute on function public.market_label(text)                                        from anon;
revoke execute on function public.geo_regions()                                             from anon;

-- the decider, its rules and its directives
revoke execute on function public.rpc_event_recommendations()                               from anon;
revoke execute on function public.rpc_market_performance()                                  from anon;
revoke execute on function public.get_decider_rules()                                       from anon;
revoke execute on function public.set_decider_rules(integer, integer, numeric, integer)     from anon;
revoke execute on function public.campaign_directives_active()                              from anon;
revoke execute on function public.campaign_directive_add(jsonb)                             from anon;
revoke execute on function public.campaign_directive_revoke(uuid)                           from anon;
revoke execute on function public.send_test_mode()                                          from anon;
revoke execute on function public.log_run_edit(uuid, text, text, jsonb, text)               from anon;

-- pricing + schedule loaders (OpenClaw's campaign-pricing / campaign-events skills)
revoke execute on function public.price_targets(integer)                                    from anon;
revoke execute on function public.set_event_prices(jsonb)                                   from anon;
revoke execute on function public.set_event_prices(text, jsonb)                             from anon;
revoke execute on function public.record_price_run(jsonb)                                   from anon;
revoke execute on function public.upsert_events_master(jsonb)                               from anon;

-- CakeMail history (migration 047). upsert_blast_templates was granted to service_role only
-- and never to anon, so there is nothing to revoke for it — noted so its absence here does not
-- read as an oversight.
--
-- Conditional because 047 is committed but NOT YET APPLIED to this database: naming the
-- function outright would abort the whole migration on an instance that has not run 047,
-- taking every revoke above down with it.
do $$
begin
  if to_regprocedure('public.blast_templates_unmapped_lists()') is not null then
    revoke execute on function public.blast_templates_unmapped_lists() from anon;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Verify — expect zero rows.
-- ---------------------------------------------------------------------------
-- select p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and has_function_privilege('anon', p.oid, 'execute')
--    and (p.proname like 'queue\_%' or p.proname like 'market\_%' or p.proname like 'rpc\_%'
--         or p.proname like 'campaign\_directive%');
--
-- And from a browser console with only the anon key, a call to get_campaign_queue should come
-- back 403 rather than data.
