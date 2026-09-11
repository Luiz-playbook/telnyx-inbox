-- 067 — AI-971: turn a deal stage id into something a person can read.
--
-- A deal row stores `dealstage` as HubSpot stores it, which is an opaque id: "1607069",
-- "1372203600", "37bf5e8e-93c2-45bd-9249-fa8239b6fd1e". The Recipients tab was about to print those
-- verbatim in the stage pill. This is the lookup table that makes them words.
--
-- 4 pipelines, 76 stages in portal 4313631. Small, slow-moving, and fetched whole in one call
-- (GET /crm/v3/pipelines/deals) — so it is a plain replace-everything sync, not an incremental one.
--
-- WON AND LOST COME FROM HUBSPOT, NOT FROM THE TEXT. A stage carries metadata.isClosed and
-- metadata.probability; won is closed at probability 1, lost is closed at probability 0. Reading
-- the label instead would be guesswork, and this portal has the case that proves it: in "Playbook
-- Events" the stage whose ID IS LITERALLY "closedlost" is labelled "Initial Interest", and it is
-- open at probability 0.5. Any heuristic on the id or the label calls that lost. HubSpot's own
-- flags call it what it is.
--
-- One consequence worth knowing rather than hiding: "Playbook NW Software / Scheduled Demo" is
-- configured isClosed=true, probability=0.0, so it classifies as LOST. That looks wrong on screen
-- because it probably is wrong in HubSpot — but it is what the portal asserts, and inventing a
-- different answer here would put the app and the CRM out of step with no way to tell which is
-- which. Fix it in HubSpot and this follows on the next sync.

create schema if not exists hubspot;
grant usage on schema hubspot to service_role;

create table if not exists hubspot.hubspot_deal_stages (
  stage_id       text primary key,
  pipeline_id    text,
  pipeline_label text,
  stage_label    text,
  display_order  int,
  is_closed      boolean,
  probability    numeric,
  synced_at      timestamptz not null default now()
);

alter table hubspot.hubspot_deal_stages enable row level security;
revoke all on hubspot.hubspot_deal_stages from anon, authenticated;
grant all on hubspot.hubspot_deal_stages to service_role;

-- ------------------------------------------------------------------------------------------------
-- The screen's read, widened with the stage labels. hubspot_deal_for_emails is untouched: it
-- answers "which deal" and the n8n lookup calls it, so it stays narrow.
-- ------------------------------------------------------------------------------------------------
drop function if exists public.hubspot_deals_for_emails(text[]);

create function public.hubspot_deals_for_emails(p_emails text[])
returns table (
  email          text,
  hs_object_id   bigint,
  deal_via       text,
  deal_id        bigint,
  deal_name      text,
  deal_stage     text,
  deal_stage_label text,
  deal_pipeline  text,
  deal_pipeline_label text,
  deal_is_won    boolean,
  deal_is_lost   boolean,
  deal_amount    numeric,
  deal_closedate timestamptz,
  deal_modified  timestamptz,
  company_id     bigint,
  company_name   text,
  company_count  int
)
language sql
stable
security definer
set search_path to 'public', 'hubspot'
as $function$
  select r.email,
         r.hs_object_id,
         r.deal_via,
         r.deal_id,
         d.dealname,
         d.dealstage,
         -- Falls back to the raw id when the stage map has not been synced yet. An unreadable id is
         -- worse than a label but far better than an empty pill that hides the deal exists.
         coalesce(s.stage_label, d.dealstage),
         d.pipeline,
         s.pipeline_label,
         (s.is_closed and s.probability = 1),
         (s.is_closed and s.probability = 0),
         d.amount,
         d.closedate,
         d.hs_lastmodifieddate,
         r.company_id,
         co.name,
         coalesce(array_length(r.company_ids, 1), 0)
    from public.hubspot_deal_for_emails(p_emails) r
    left join hubspot.hubspot_deals d       on d.hs_object_id = r.deal_id
    left join hubspot.hubspot_companies co  on co.hs_object_id = r.company_id
    left join hubspot.hubspot_deal_stages s on s.stage_id = d.dealstage
$function$;

grant execute on function public.hubspot_deals_for_emails(text[]) to service_role;

-- ------------------------------------------------------------------------------------------------
-- The one-off read the on-demand lookup needs. The n8n webhook answers with the RAW HubSpot deal,
-- where dealstage is an opaque id, so api/market-history.js resolves the label here rather than
-- letting a clicked row show "1607069" beside neighbours that read "Closed".
--
-- Batched by id like every other helper in this schema, even though the caller passes one: the
-- shape should not have to change the day something wants ten.
-- ------------------------------------------------------------------------------------------------
create or replace function public.hubspot_stage_labels(p_stage_ids text[])
returns table (
  stage_id       text,
  stage_label    text,
  pipeline_label text,
  is_won         boolean,
  is_lost        boolean
)
language sql
stable
security definer
set search_path to 'public', 'hubspot'
as $function$
  select s.stage_id,
         s.stage_label,
         s.pipeline_label,
         (s.is_closed and s.probability = 1),
         (s.is_closed and s.probability = 0)
    from hubspot.hubspot_deal_stages s
   where s.stage_id = any (p_stage_ids)
$function$;

grant execute on function public.hubspot_stage_labels(text[]) to service_role;
