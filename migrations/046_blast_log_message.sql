-- Give the blast log a home for the COPY that was sent, not just the fact of the send.
--
-- ticketblaster_market_blasts_log records market, channel, recipient count and date, but
-- had nowhere for the message body. For blasts sent through this app that is fine —
-- campaign_queue holds email_copy / sms_copy and the row survives the send, so the queue
-- IS the copy record. Imported history is the exception: the Textable blasts brought in on
-- 2026-07-31 never passed through here, so there is no queue row and the body had nowhere
-- to go.
--
-- Those bodies are also the real sent variants behind migration 043's template work — the
-- season-opener, club-seat, suite and followup pitches as Cole actually wrote them.
--
-- INTERIM STATE THIS MIGRATION CLEANS UP. The copy was already written into `notes`,
-- appended after a "--- SENT COPY ---" marker, because DDL was not available at the time
-- and notes was the only writable text column. This moves it into a real column and
-- restores notes to provenance only. It is idempotent: rows already migrated have no
-- marker left to match.

alter table public.ticketblaster_market_blasts_log
  add column if not exists message text;

comment on column public.ticketblaster_market_blasts_log.message is
  'The copy actually sent for this blast. Null for rows written by the send path, which logs the send while campaign_queue keeps the body; populated for imported history that has no queue row.';

-- Split notes at the marker: everything after it is the message, everything before is
-- provenance. btrim clears the blank lines the marker was padded with.
update public.ticketblaster_market_blasts_log
   set message = btrim(split_part(notes, '--- SENT COPY ---', 2)),
       notes   = nullif(btrim(split_part(notes, '--- SENT COPY ---', 1)), '')
 where notes like '%--- SENT COPY ---%';

-- Verify: expect with_copy = 11, total = 11, and no marker left anywhere.
--   select count(*) filter (where message is not null) as with_copy,
--          count(*) as total,
--          count(*) filter (where notes like '%SENT COPY%') as leftover_markers
--   from public.ticketblaster_market_blasts_log where source = 'textable';
