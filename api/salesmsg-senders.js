// The Salesmsg numbers this account can send from, for the Queue's "Text from" dropdown.
//
// The dropdown used to carry a hardcoded `{ v:'salesmessage', label:'(placeholder)' }` entry
// that pointed at nothing: choosing it stored sms_from='salesmessage', which api/queue-tick.js
// then handed to the TELNYX webhook as a From. This endpoint replaces that with the real list.
//
// Auth is OAuth Applications — lib/salesmsg.js, refresh token from the environment. There is
// no SALESMSG_API_KEY path here and there must not be one; that is what api/salesmsg-sync.js
// was doing wrong, and why it answered 403.
//
// Read-only metadata (numbers and team names), gated by the UI secret like the other
// browser-facing endpoints. It sends nothing and exposes no token.

import { listSenders } from '../lib/salesmsg.js';
import { gate } from '../lib/auth.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  if (!process.env.SALESMSG_CLIENT_ID) {
    res.status(200).json({ ok: true, senders: [], note: 'Salesmsg is not configured on this deployment.' });
    return;
  }

  try {
    const senders = await listSenders();
    // Cached briefly: the dropdown is rebuilt on every queue load, and the number list
    // changes about never. Keeps a busy Queue tab from re-walking every team each time.
    res.setHeader('cache-control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ ok: true, senders });
  } catch (e) {
    // Reported, not thrown into the UI as a blank list: an expired OAuth grant and "this
    // account owns no numbers" look identical otherwise.
    res.status(502).json({ error: String((e && e.message) || e), senders: [] });
  }
}
