// Which Telnyx numbers the bulk sender will send from — for the Queue's sender picker (AI-965).
//
// AC3 and AC5 in one: the operator sees which number a queued blast will use, and is never
// offered one the pipeline would refuse. Both flags come straight from Charles's /api/routes:
//
//   sendable        the route is active and the number is registered on a 10DLC campaign.
//   inbox_attached  the number has a HubSpot channel account. WITHOUT this the text still
//                   sends and the conversation never appears in the inbox — which is exactly
//                   the "will replies be captured?" confusion from the AI-965 call. So a route
//                   that is sendable but not inbox-attached is returned flagged, not hidden:
//                   hiding it would make the number look missing rather than misconfigured.
//
// Proxied rather than called from the browser because the bulk sender's secret is
// server-side only, same as every other credential in api/.
//
// Env: BULK_SMS_API_URL, BULK_SMS_API_SECRET (see lib/bulk-sms.js).

import { requireCaller } from '../lib/auth.js';
import { bulkSmsConfigured, listRoutes } from '../lib/bulk-sms.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }

  const caller = await requireCaller(req);
  if (!caller) { res.status(401).json({ error: 'Sign in to list sender routes.' }); return; }

  // Off is a normal answer, not an error: the Queue shows its existing sender list and says the
  // bulk path is not configured. A 500 here would make a feature flag look like an outage.
  if (!bulkSmsConfigured()) {
    res.status(200).json({ ok: true, configured: false, routes: [], note: 'BULK_SMS_API_URL / BULK_SMS_API_SECRET not set; Telnyx blasts use the n8n webhook.' });
    return;
  }

  try {
    const routes = await listRoutes();
    res.status(200).json({ ok: true, configured: true, routes });
  } catch (e) {
    // 502, not 500: the failure is the other service's, and telling them apart is the first
    // thing anyone debugging this will want.
    res.status(502).json({ ok: false, configured: true, error: String((e && e.message) || e), routes: [] });
  }
}
