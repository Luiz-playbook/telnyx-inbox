-- 063 — AI-971: let the app resolve an email address to a HubSpot contact id.
--
-- WHY. The Recipients tab gets its HubSpot link from the `recordid` CakeMail carries on each list
-- contact — but only about half of them have one (15 of 30 in the sample), so the rest show a
-- "Find in HubSpot" button instead. Pressing it looks the person up and caches them in
-- hubspot.hubspot_contacts.
--
-- The bug this fixes: reopening the panel showed the button again. The roster is rebuilt from
-- CakeMail, whose recordid is still absent, and nothing consulted the mirror — so a contact we had
-- already paid an API call to find was offered up to be found again, every time (Vhea,
-- 2026-09-09).
--
-- WHY A FUNCTION AND NOT A TABLE READ. `hubspot` is deliberately not in the project's exposed
-- schemas, so PostgREST will not serve it — that is what keeps 200k contacts and their addresses
-- off the REST surface entirely. This is the narrow question the app is allowed to ask instead:
-- given these addresses, which ones do we already know, and what are their ids. It returns no
-- names, no company, nothing but the id.
--
-- Batched on purpose: a page of the roster is 100 contacts, and asking one at a time would be 100
-- round trips to answer one screen.

create or replace function public.hubspot_ids_for_emails(p_emails text[])
returns table (email text, hs_object_id bigint)
language sql
stable
security definer
set search_path to 'public', 'hubspot'
as $function$
  select lower(c.email), c.hs_object_id
    from hubspot.hubspot_contacts c
   where c.email is not null
     -- Lower-cased both sides: CakeMail stores what the contact typed, HubSpot stores what it was
     -- given, and "Someone@Club.org" is the same person as "someone@club.org".
     and lower(c.email) = any (select lower(e) from unnest(p_emails) as e)
$function$;

-- service_role only. The app calls it server-side from api/market-history.js; it is never reachable
-- with the anon key.
grant execute on function public.hubspot_ids_for_emails(text[]) to service_role;
