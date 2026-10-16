-- 121: attaching or detaching a design un-confirms the blast.
--
-- THE GAP. 120a let a design be attached to any row that was not already sent. `confirmed` means
-- the hourly api/queue-tick cron will send it with no further human step — so attaching a design
-- to a confirmed blast swapped what goes out, and it could go out within the hour, approved on
-- the strength of a text body that is no longer what anybody receives.
--
-- That is the same hazard 120a's own header claims to guard against when it explains why the HTML
-- is COPIED rather than re-rendered at send time: what a person approved must be what is sent.
-- 120a closed that for CakeMail-side edits and left it open for our own.
--
-- WHY IN THIS FUNCTION AND NOT A SECOND CALL FROM THE ENDPOINT. The cron runs hourly and the
-- window matters. Two statements — write the html, then un-confirm — leave a moment in which the
-- row is confirmed AND carries the new design, which is exactly the state this is meant to make
-- impossible. One UPDATE cannot be interrupted that way.
--
-- BOTH DIRECTIONS. Detaching changes what sends every bit as much as attaching does, so it
-- un-confirms too. Attach-then-detach therefore ends at pending rather than back at confirmed;
-- that is correct, not a rough edge. The row's approval was for a body that has since been
-- swapped twice, and re-confirming is one click.
--
-- NOT TOUCHED: pending stays pending, rejected stays rejected, archived stays archived. Only an
-- approval that would now carry something it was not given for is withdrawn. `sent` and
-- `partial` never reach here — api/cakemail-templates.js refuses both, matching the Queue, which
-- renders them read-only (ui/index.html: `sent = r.status==='sent' || r.status==='partial'`).

create or replace function public.queue_set_email_html(
  p_id uuid, p_html text, p_template_id bigint, p_template_name text
)
returns public.campaign_queue
language sql volatile security definer set search_path to 'public'
as $function$
  update public.campaign_queue
     set email_html             = nullif(btrim(p_html), ''),
         cakemail_template_id   = case when nullif(btrim(p_html), '') is null then null else p_template_id end,
         cakemail_template_name = case when nullif(btrim(p_html), '') is null then null else nullif(btrim(p_template_name), '') end,
         -- The approval is withdrawn, not the schedule. The row keeps its slot and simply waits
         -- for a person again, which is what `pending` already means everywhere else.
         status                 = case when status = 'confirmed' then 'pending' else status end,
         confirmed_at           = case when status = 'confirmed' then null else confirmed_at end
   where id = p_id
  returning *;
$function$;

-- Restated: CREATE OR REPLACE keeps the existing ACL, but stating it here means this file can be
-- run on its own without depending on 120a having granted it.
revoke execute on function public.queue_set_email_html(uuid, text, bigint, text) from public, anon, authenticated;
grant  execute on function public.queue_set_email_html(uuid, text, bigint, text) to service_role;
