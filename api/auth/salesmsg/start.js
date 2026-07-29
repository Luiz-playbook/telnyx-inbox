// Step 1 of the Salesmsg OAuth flow: bounce the operator to Salesmsg to approve.
// Open in a browser:  /api/auth/salesmsg/start?secret=<SALESMSG_SETUP_SECRET>
//
// Guarded by SALESMSG_SETUP_SECRET because anyone who reaches the callback with a valid
// code can bind this deployment to THEIR Salesmsg org.

import { authorizeUrl, clientId, clientSecret, redirectUri } from '../../../lib/salesmsg.js';

export default function handler(req, res) {
  const setup = (process.env.SALESMSG_SETUP_SECRET || '').trim();
  const given = String((req.query && req.query.secret) || '');
  if (!setup || given !== setup) { res.status(401).json({ error: 'unauthorized' }); return; }

  const missing = [
    !clientId() && 'SALESMSG_CLIENT_ID',
    !clientSecret() && 'SALESMSG_CLIENT_SECRET',
    !redirectUri() && 'SALESMSG_REDIRECT_URI',
  ].filter(Boolean);
  if (missing.length) { res.status(500).json({ error: `not configured: ${missing.join(', ')}` }); return; }

  // state is echoed back by Salesmsg; the callback checks it to reject stray codes.
  const state = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  res.setHeader('Set-Cookie', `sm_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  res.writeHead(302, { Location: authorizeUrl(state) });
  res.end();
}
