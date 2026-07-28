-- Lets the static UI (anon) read the current send allowlist so it can show a TEST MODE
-- banner + mark blocked markets. Empty result = normal mode (all markets send).
create or replace function public.send_test_mode()
 returns table(code text, note text)
 language sql stable security definer set search_path to 'public'
as $function$
  select code, note from public.send_allowlist order by code;
$function$;

grant execute on function public.send_test_mode() to anon;
