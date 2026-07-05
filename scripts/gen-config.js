// Build step for Vercel: writes ui/config.js from environment variables so no
// keys/secrets live in the (public) git repo. Set these in Vercel > Project >
// Settings > Environment Variables (or pass with `vercel --build-env`).
const fs = require('fs');

const cfg = {
  SUPABASE_URL:      process.env.SUPABASE_URL      || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  REPLY_WEBHOOK_URL: process.env.REPLY_WEBHOOK_URL || '',
  REPLY_SECRET:      process.env.REPLY_SECRET      || '',
  COMPANY_AI_WEBHOOK_URL: process.env.COMPANY_AI_WEBHOOK_URL || '',
};

const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) console.warn('gen-config: missing env vars -> ' + missing.join(', '));

fs.writeFileSync('ui/config.js', `window.INBOX_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
console.log('gen-config: wrote ui/config.js');
