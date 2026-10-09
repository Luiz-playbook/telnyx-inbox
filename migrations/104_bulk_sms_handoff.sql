-- 104: remember which bulk-sender campaign a queue row became (AI-965).
--
-- WHAT THIS IS FOR
--
-- When a Telnyx blast goes through Charles's bulk sender instead of the n8n webhook
-- (lib/bulk-sms.js), the pipeline over there owns the send: the per-recipient rows, the
-- delivery receipts, the sent/failed/skipped counts. Our queue row needs to know WHICH campaign
-- it became, or none of that can ever be read back onto the Queue or Market History.
--
-- Two columns, both nullable, both empty for every row that went out the old way.
--
--   bulk_campaign_id  the campaign id the pipeline returned at staging. The key we sent is our
--                     own row id, so this is the other half of the join.
--   bulk_census       the staging census as returned: eligible, blocked, byReason,
--                     collapsedDuplicates, from_inbox. Kept as JSON because its shape belongs
--                     to the other app and will change without telling us — pulling fields out
--                     into columns here would be a schema that drifts from its source.
--
-- NOTHING ELSE CHANGES. No existing column is touched, no default alters a current row, and
-- get_campaign_queue() is deliberately NOT extended here: that function has lost a column
-- before (058 → 071) and gains them in their own migration (091) so each change can be checked
-- on its own. Reading these two back into the UI is a follow-up, once there is something in
-- them to read.

alter table public.campaign_queue
  add column if not exists bulk_campaign_id text,
  add column if not exists bulk_census      jsonb;

create index if not exists idx_campaign_queue_bulk_campaign
  on public.campaign_queue (bulk_campaign_id) where bulk_campaign_id is not null;

comment on column public.campaign_queue.bulk_campaign_id is
  'Campaign id in the HubSpot<->Telnyx bulk sender, when this row was sent through it (AI-965). '
  'Null for rows sent via n8n or Salesmsg. Our row id is the campaign key over there.';
comment on column public.campaign_queue.bulk_census is
  'The staging census the bulk sender returned: eligible, blocked, byReason, collapsedDuplicates. '
  'Stored as returned - its shape belongs to the other app.';
