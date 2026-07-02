// Copy this file to `config.js` and fill in the values. `config.js` is
// git-ignored so real keys/secrets never get committed.
//
// SUPABASE_URL + SUPABASE_ANON_KEY: from Supabase > Project Settings > API.
//   The anon key is meant for the browser, but with the current permissive RLS
//   it can READ the inbox tables — keep it out of any public repo.
// REPLY_WEBHOOK_URL: Production webhook URL of the n8n reply workflow
//   (the /webhook/ one, NOT /webhook-test/).
// REPLY_SECRET: must match the reply_secret configured in that n8n workflow.

window.INBOX_CONFIG = {
  SUPABASE_URL: "<<YOUR_SUPABASE_URL>>",
  SUPABASE_ANON_KEY: "<<YOUR_SUPABASE_ANON_KEY>>",
  REPLY_WEBHOOK_URL: "<<PASTE_N8N_REPLY_PRODUCTION_WEBHOOK_URL>>",
  REPLY_SECRET: "<<SAME_SHARED_SECRET_AS_N8N>>",
};
