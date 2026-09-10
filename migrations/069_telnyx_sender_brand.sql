-- Which brand each sending number belongs to — the join 068 was missing.
--
-- WHY. T-Mobile's daily cap is per BRAND, and this account has two live ones with very
-- different allowances: Playbook (vetting score 63) at 40,000/day, and Social City LLC /
-- "NYC Basketball" (unvetted) at 2,000/day. Volume comes back from /v2/usage_reports keyed by
-- sending number and nothing else — usage_reports has no brand or campaign dimension — so
-- without this column there is no way to say which allowance a message actually drew on.
--
-- The first cut of api/telnyx-usage.js worked around that by comparing all volume to the
-- LOWEST cap on the account. That is wrong, not merely conservative: on 2026-09-11 it read
-- Playbook's 1,416 T-Mobile messages against NYC Basketball's 2,000 cap and reported 70.8%
-- of allowance consumed, when the real figure against Playbook's own 40,000 was 3.5%. A cap
-- alarm that cries wolf at 3.5% is worse than no alarm.
--
-- Populated by api/telnyx-usage-sync.js from GET /v2/10dlc/phone_number_campaigns/{number},
-- refreshed on every run. A number CAN move between brands — +1 609 360 2796 moved from the
-- NYC Basketball campaign to Playbook's C8LB7XX on 2026-08-10 — so this is a cache of the
-- current assignment, not a historical record. Over a 30-day rolling window that is the right
-- trade; if per-day historical attribution is ever needed, brand_id belongs on
-- telnyx_usage_daily instead.

alter table public.telnyx_senders
  add column if not exists brand_id          text,
  add column if not exists tcr_brand_id      text,
  add column if not exists tcr_campaign_id   text,
  -- 'ASSIGNED', or null when the number is on no campaign at all. Null is not a gap in our
  -- data — it is the finding: +1 615 805 0766 answers 404 from the assignment endpoint and is
  -- an unregistered long code, subject to carrier filtering and the 0.1 MPS per-number limit
  -- rather than the brand's throughput.
  add column if not exists assignment_status text,
  add column if not exists brand_checked_at  timestamptz;

-- The strip groups by brand on every load.
create index if not exists idx_telnyx_senders_brand
  on public.telnyx_senders (brand_id);

comment on column public.telnyx_senders.brand_id is
  'Telnyx 10DLC brand the number currently sends under. Null = not on any campaign.';

-- Seed from the assignments read on 2026-09-10 so the strip is correct before the first sync
-- runs. Every labelled number except SendBlaster sits on campaign C8LB7XX under Playbook.
update public.telnyx_senders set
  brand_id        = '4b20019e-4394-6a29-1fd4-f94f145124f0',
  tcr_brand_id    = 'BDOF01M',
  tcr_campaign_id = 'C8LB7XX',
  assignment_status = 'ASSIGNED'
where phone_number in (
  '+13159988112','+19345001252','+13238801900','+19345001757',
  '+15512344320','+16808420065','+16093602796'
);

-- Left deliberately null: on no campaign as of 2026-09-10.
update public.telnyx_senders set
  brand_id = null, tcr_brand_id = null, tcr_campaign_id = null, assignment_status = null
where phone_number = '+16158050766';
