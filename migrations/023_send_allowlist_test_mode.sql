-- Temporary TEST-MODE safety net. send_allowlist, when NON-EMPTY, restricts recipient
-- resolution to only the listed market/state codes. Empty table = normal (all markets send).
--
-- market_phones / market_emails are the ONLY recipient-resolution path for BOTH the cron
-- auto-send (api/queue-tick.js) and the manual UI send (ui/index.html), so gating them here
-- blocks every send to non-allowlisted markets — even an accidental click on a real market
-- resolves to zero recipients. Fully reversible: `truncate public.send_allowlist;` restores
-- normal behavior for every market.

create table if not exists public.send_allowlist (
  code       text primary key,
  note       text,
  created_at timestamptz not null default now()
);

-- Turn ON test mode: only 'ZZ' (Playbook Sports Test market) may send.
insert into public.send_allowlist (code, note)
  select 'ZZ','Test market — only sends allowed while testing'
  where not exists (select 1 from public.send_allowlist where code='ZZ');

-- Gate both resolvers on the allowlist (grants are preserved by CREATE OR REPLACE).
create or replace function public.market_phones(p_code text)
 returns table(phone text) language sql stable security definer set search_path to 'public'
as $function$
  select mc.phone from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.phone is not null
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
  order by mc.phone limit 1000;
$function$;

create or replace function public.market_emails(p_code text)
 returns table(email text) language sql stable security definer set search_path to 'public'
as $function$
  select mc.email from public.market_contacts mc
  where mc.code = upper(btrim(p_code)) and mc.email is not null
    and (not exists (select 1 from public.send_allowlist)
         or upper(btrim(p_code)) in (select code from public.send_allowlist))
  order by mc.email limit 1000;
$function$;
