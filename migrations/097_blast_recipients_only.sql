-- 097 — drop the telnyx_messages half of the SMS recipient lookup.
--
-- 095 built blast_recipients_for() to read two sources: blast_recipients, which this application
-- writes at send time, and public.telnyx_messages, on the theory that it was the only place an
-- outbound SMS had ever been recorded per recipient before then.
--
-- MEASURED, AND IT RECOVERS NOTHING. Across all 11 SMS blasts in
-- ticketblaster_market_blasts_log — 796 reported recipients between them — the telnyx half
-- returns ZERO rows. Not "few": zero, for every blast, even with the message-body guard removed
-- and only the ±1 day window applied.
--
-- The reason is simple once seen. telnyx_messages is the TWO-WAY INBOX behind the Replies tab:
-- 22 rows, 11 of them outbound, all to a single number, all on 2026-07-02. Blasts never pass
-- through it — they go from api/queue-tick.js to the n8n bulk webhook to Telnyx, and nothing
-- writes a row here. Every blast in the history is from June. The two sets do not even overlap
-- in time.
--
-- SO IT WAS CARRYING RISK FOR NO RETURN. The body guard existed purely to stop it answering
-- wrongly: without it, opening any blast sent on 2 July would have listed eleven inbox messages
-- as that blast's recipients. A source that contributes nothing and can only ever be wrong is
-- worth removing rather than guarding.
--
-- WHAT telnyx_messages IS ACTUALLY FOR, so this is not relitigated later: delivery receipts.
-- GAPS.md gap 1 and the note in api/queue-tick.js both describe the real path — Telnyx posts
-- message.finalized back, and turning those into a per-blast delivered figure needs the message
-- id, not a time window. blast_recipients.provider_id already exists to hold exactly that join
-- key. When that lands it belongs on the OUTCOME column of a recipient we already know about,
-- not on discovering who the recipients were.
--
-- THE SIGNATURE IS UNCHANGED, deliberately. `source` still comes back (now always 'log') and
-- p_message is still accepted and now ignored, because changing the return type of a function
-- the deployed route is calling needs a DROP, and that is a worse trade than one column that
-- only ever holds one value. Both are documented here rather than silently odd.

create or replace function public.blast_recipients_for(
  p_market  text,
  p_channel text,
  p_at      timestamptz,
  p_message text default null   -- accepted and ignored; see the note above
) returns table (
  source     text,
  address    text,
  outcome    text,
  provider   text,
  sent_at    timestamptz,
  first_name text,
  last_name  text,
  company    text
)
language sql
security definer
set search_path = public, ticketblaster, pg_temp
as $fn$
  -- THE WINDOW IS INLINE, NOT A CTE JOINED WITH A COMMA. `from blast_recipients br, win left
  -- join contact_directory d on d.identity_key = br.address_key` does not parse: the LEFT JOIN
  -- binds to `win`, the nearest table on its left, so br is not in scope in the ON clause and
  -- Postgres rejects it ("invalid reference to FROM-clause entry for table br"). 095 got away
  -- with the same shape only because its left join was against a CTE that had already been
  -- flattened. Two expressions are cheaper than the trap.
  select 'log'::text, br.address, br.outcome, br.provider, br.sent_at,
         d.first_name, d.last_name, d.company
  from ticketblaster.blast_recipients br
  -- Names from the directory so a roster reads as people rather than a column of numbers. A
  -- recipient we hold no contact for still appears, with blanks.
  left join public.contact_directory d on d.identity_key = br.address_key
  where br.sent_at between coalesce(p_at, now()) - interval '1 day'
                       and coalesce(p_at, now()) + interval '1 day'
    and (p_channel is null or br.channel = lower(p_channel))
    and (p_market  is null or upper(coalesce(br.market_code, '')) = upper(p_market))
  order by br.sent_at desc, br.address
  limit 2000;
$fn$;

revoke all on function public.blast_recipients_for(text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.blast_recipients_for(text, text, timestamptz, text) to service_role;
