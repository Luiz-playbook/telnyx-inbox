// Build step for Vercel: writes ui/config.js from environment variables so no
// keys/secrets live in the (public) git repo. Set these in Vercel > Project >
// Settings > Environment Variables (or pass with `vercel --build-env`).
const fs = require('fs');

const cfg = {
  SUPABASE_URL:      process.env.SUPABASE_URL      || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  REPLY_WEBHOOK_URL: process.env.REPLY_WEBHOOK_URL || '',
  REPLY_SECRET:      process.env.REPLY_SECRET      || '',
  // n8n "company scraper" webhook (not secret). Overridable via env var.
  COMPANY_AI_WEBHOOK_URL: process.env.COMPANY_AI_WEBHOOK_URL
    || 'https://playbooksports.app.n8n.cloud/webhook/pbhs-company-scraper-aae1-b5b19bf368c7',
  // n8n bulk-send webhook — receives { messages:[{to,text}] } and sends via Telnyx.
  // (The 'from' number is set in the n8n send node, not the payload.)
  BULK_SEND_WEBHOOK_URL: process.env.BULK_SEND_WEBHOOK_URL
    || 'https://playbooksports.app.n8n.cloud/webhook/telnyx-bulk-send',
  // n8n Gmail bulk-send webhook — receives { messages:[{to,subject,html}] }, Switch-by-from.
  EMAIL_SEND_WEBHOOK_URL: process.env.EMAIL_SEND_WEBHOOK_URL
    || 'https://playbooksports.app.n8n.cloud/webhook/gmail-bulk-send',
  // NOTE: CakeMail deliberately has NO entry here. It is sent straight from our own API
  // (api/cakemail-send.js + lib/cakemail.js) using CAKEMAIL_PAT, which is server-side only —
  // everything in this object is written into ui/config.js and served to every visitor.
  // n8n workflow that pulls the messaging-profile's numbers into telnyx_numbers.
  SYNC_NUMBERS_WEBHOOK_URL: process.env.SYNC_NUMBERS_WEBHOOK_URL
    || 'https://playbooksports.app.n8n.cloud/webhook/telnyx-sync-numbers',
  // Only Google accounts on this domain may sign in.
  ALLOWED_EMAIL_DOMAIN: process.env.ALLOWED_EMAIL_DOMAIN || 'callplaybook.com',
  // The pricing sheet the AI-940 sync writes (n8n "Marketing Blaster Pricing Sheet Sync").
  // Linked from the Ticket Prices tab so the mirror is reachable from the thing it mirrors —
  // it is otherwise invisible from inside the app. Not a secret: it is a Google document id,
  // and access is enforced by Google, not by knowing the URL.
  PRICING_SHEET_URL: process.env.PRICING_SHEET_URL
    || 'https://docs.google.com/spreadsheets/d/1djGg7A5bddBV59Vl8OY2X4n1x44Y9bD8bbaiPmYEj-8/edit',
  // AI-959: turn "Send now" off in QA while leaving it on in production.
  //
  // Set SEND_DISABLED=true on the PREVIEW scope in Vercel and leave it unset on Production.
  // Both environments then build from the same source with different behaviour, instead of a
  // hardcoded flag someone has to remember to flip back before merging.
  //
  // This governs the BUTTON only. Two other things already keep QA quiet: Vercel runs cron jobs
  // for production deployments only, so the hourly send tick never fires on a preview; and the
  // API routes still require their own secrets. It is not a substitute for AI-977's sandbox —
  // the QA build still talks to production Supabase, Telnyx and CakeMail, so anything that does
  // reach those providers is real.
  SEND_DISABLED: String(process.env.SEND_DISABLED || '').toLowerCase() === 'true',
};

// SEND_DISABLED is excluded: it is a boolean whose normal value is false, and listing it
// as "missing" on every production build would train people to ignore this warning.
const missing = Object.entries(cfg)
  .filter(([k, v]) => !v && k !== 'SEND_DISABLED')
  .map(([k]) => k);
if (missing.length) console.warn('gen-config: missing env vars -> ' + missing.join(', '));

fs.writeFileSync('ui/config.js', `window.INBOX_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
console.log('gen-config: wrote ui/config.js');
