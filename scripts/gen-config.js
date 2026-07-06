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
  // n8n bulk-send webhook — receives { from, messages:[{from,to,text}] } and sends via Telnyx.
  BULK_SEND_WEBHOOK_URL: process.env.BULK_SEND_WEBHOOK_URL
    || 'https://playbooksports.app.n8n.cloud/webhook/telnyx-bulk-send',
  // Telnyx number bulk messages are sent FROM (included in the payload).
  TELNYX_FROM: process.env.TELNYX_FROM || '+16158050766',
};

const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) console.warn('gen-config: missing env vars -> ' + missing.join(', '));

fs.writeFileSync('ui/config.js', `window.INBOX_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
console.log('gen-config: wrote ui/config.js');
