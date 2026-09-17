-- 076: a rejected blast cannot be confirmed back into sending (AI-967).
--
-- REPRODUCED FIRST, as the ticket asked. Against the live database on 2026-09-17, on a throwaway
-- row that was deleted afterwards:
--
--   CASE A — confirm, then reject          CORRECT
--     status ends 'rejected', rejected_at set, reject_note stored, and api/queue-tick.js will
--     not send it (its sendable() test excludes rejected as of 2026-09-16). This is the case the
--     ticket was actually worried about, and it behaves.
--
--   CASE B — reject, then confirm          BROKEN
--     queue_confirm returned 200 and the row came back:
--
--         status = 'confirmed'   rejected_at = set   reject_note = 'AI-967 reproduction'
--
--     Simultaneously rejected and confirmed. status is what api/queue-tick.js reads, so the row
--     WOULD SEND — at its ORIGINAL scheduled time, with no new time shown anywhere, carrying the
--     written reason it was refused. A blast someone turned down, delivered on the strength of
--     one later click.
--
-- The ticket's second acceptance criterion says such a row must either send at a clearly
-- displayed NEW time, or not be confirmable at all. This takes the second option: there is
-- already a control for changing your mind — Restore (queue_unreject) — which puts the row back
-- to 'pending' and clears the rejection, and from there Confirm works normally. Making reject
-- reversible in two deliberate steps is better than making it reversible by accident in one.
--
-- WHY A TRIGGER AND NOT A FIX TO queue_confirm
--
-- queue_confirm(uuid) is NOT DEFINED IN ANY MIGRATION — like queue_mark_sent, it exists only in
-- the live database, so its body is unknown here. Redefining it blind would risk silently
-- dropping whatever else it does. 058 faced exactly this and chose an additive write for the
-- same reason.
--
-- A trigger is also the stronger fix. The UI already hides Confirm on a rejected row (both the
-- per-row menu and the bulk action's `can` test), so this bug is not reachable by clicking — it
-- is reachable through the RPC: the OpenClaw agent, a script, anything holding the anon key.
-- Guarding the TABLE covers every one of those paths at once, including ones written later.
--
-- WHAT IT ALLOWS, DELIBERATELY
--
--   rejected -> pending     queue_unreject. The intended way back, and it clears rejected_at.
--   rejected -> archived    filing a refused blast away is not resurrecting it.
--   rejected -> rejected    re-rejecting with a better reason.
--   pending  -> confirmed   the normal path, untouched.
--
-- Only the one transition that turns a refusal into a send is refused.

create or replace function public.campaign_queue_block_confirm_rejected()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- Keyed on rejected_at, not on the old status, and deliberately so. The state that makes this
  -- dangerous is a row carrying a live rejection, however it got there — including a row already
  -- left half-way by this bug before the trigger existed. queue_unreject clears rejected_at in
  -- the same statement it sets 'pending', so the supported route out is unaffected.
  if new.status = 'confirmed' and new.rejected_at is not null then
    raise exception
      'This blast was rejected and cannot be confirmed. Restore it first (that clears the rejection), then confirm it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists campaign_queue_no_confirm_rejected on public.campaign_queue;

create trigger campaign_queue_no_confirm_rejected
  before update on public.campaign_queue
  for each row
  execute function public.campaign_queue_block_confirm_rejected();

comment on function public.campaign_queue_block_confirm_rejected() is
  'AI-967. Refuses any update leaving a row status=confirmed while rejected_at is set — a state '
  'that reads as refused and behaves as scheduled. The way back from a rejection is '
  'queue_unreject, which clears rejected_at and returns the row to pending.';

-- ---------------------------------------------------------------------------
-- Any row already left in the contradictory state by this bug.
--
-- A row that is both confirmed and rejected has to be resolved one way, and the safe direction
-- is the refusal: somebody wrote a reason for not sending it, and the confirm that followed is
-- as likely to have been the accident. It goes back to 'rejected' with its note intact, where
-- Restore is available to anyone who genuinely wants it back.
--
-- Expected to affect nothing — the reproduction row was deleted — but it must run before the
-- trigger can be relied on, or such a row would sit there sending while every new one is
-- blocked.
-- ---------------------------------------------------------------------------
update public.campaign_queue
   set status = 'rejected'
 where status = 'confirmed'
   and rejected_at is not null;
