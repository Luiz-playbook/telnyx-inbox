// Which Supabase credential a SERVER route uses.
//
// Every api/ route used to authenticate to Supabase with SUPABASE_ANON_KEY — the same key
// scripts/gen-config.js writes into ui/config.js and serves to every visitor. That worked
// only because the anon role could execute this app's RPCs, which is exactly the hole the
// auth work closes: once migration 051 revokes anon's execute, the published key stops being
// a working credential and any route still holding it breaks. The hourly sender
// (api/queue-tick.js) is one of them.
//
// A server route has no reason to borrow the browser's identity in the first place. It runs
// where a secret can be kept, so it uses the service role — which bypasses RLS and grants,
// and is therefore unaffected by anything 051 changes.
//
// The anon fallback is deliberate and TEMPORARY: it lets these routes deploy before
// SUPABASE_SERVICE_ROLE_KEY is set in Vercel, so this change is not a flag day. It stops
// helping the moment 051 lands — at which point a missing env var fails loudly instead of
// quietly falling back to a key that can no longer do anything. Remove it then.
//
// Never import this from anything that reaches the browser. ui/config.js is public, and the
// service role can read and write every table regardless of policy.
export const supabaseKey = () =>
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim() || (process.env.SUPABASE_ANON_KEY || '').trim();

// The REST headers every route builds by hand around that key.
export const supabaseHeaders = (key = supabaseKey()) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'content-type': 'application/json',
});
