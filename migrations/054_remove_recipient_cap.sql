-- Remove the 1,000-recipient cap from the resolvers.
--
-- WHAT WAS WRONG: market_emails / market_phones have ended in `limit 1000` since migration 023,
-- and nothing ever reported the truncation. A market with 2,586 contacts resolved to 1,000; the
-- UI meanwhile read its figure from market_recipient_counts(), which is neither capped nor gated
-- and happily displayed 2,586. Downstream, CakeMail delivers 100% of whatever list it is handed
-- and reports complete success, so a blast that reached 39% of the market looked flawless on
-- every screen. As of 2026-08-12 that affected 16 of 45 markets — 10,725 addresses beyond the
-- cap. Masked until now only because test mode (send_allowlist) resolves every real market to
-- zero anyway.
--
-- WHY IT IS SAFE TO LIFT NOW: send_allowlist is non-empty (currently 'ZZ'), so both functions
-- still resolve to zero rows for every market except the test market — this change cannot widen
-- any real send while test mode is on. It is also trivially reversible: re-add `limit 1000`.
--
-- WHAT THIS DOES NOT FIX — the silent-shrink problem is only mostly gone. api/queue-tick.js and
-- lib/cakemail.js still dedupe (`new Set`) and drop malformed addresses without reporting how
-- many they discarded, so resolved-count and submitted-count can still disagree quietly. The cap
-- was the largest of those three, not the only one.
--
-- KNOWN CONSEQUENCE, DELIBERATE: the volume now reaching the send paths is bounded by the market,
-- not by 1,000. Both paths hand their whole list over in ONE request — lib/cakemail.js posts every
-- address in a single import-contacts body, and the Telnyx route posts every message in a single
-- n8n webhook payload. Neither has been exercised near that size (the Telnyx outbound log holds
-- 11 messages, ever). Testing that ceiling is the point of this change; it is not a claim that
-- the ceiling is safe.
--
-- BOTH DEFINITIONS BELOW KEEP THE send_allowlist GATE. That gate is the only thing standing
-- between an accidental send and real customers, and `create or replace` is exactly how it would
-- get dropped by accident — migration 050 reissued both functions for per-segment support and had
-- to carry it forward too. Do not reissue these without it. Grants (anon, authenticated,
-- service_role, readonly_preview) are preserved by CREATE OR REPLACE and are not restated.

create or replace function public.market_emails(p_code text, p_segment text default null)
 returns table(email text) language sql stable security definer set search_path to 'public'
as $function$
  select mc.email from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.email is not null
    and (p_segment is null or coalesce(mc.segment, 'Other') = p_segment)
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
  order by mc.email;
$function$;

create or replace function public.market_phones(p_code text, p_segment text default null)
 returns table(phone text) language sql stable security definer set search_path to 'public'
as $function$
  select mc.phone from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.phone is not null
    and (p_segment is null or coalesce(mc.segment, 'Other') = p_segment)
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
  order by mc.phone;
$function$;
