// Serverless function (Vercel): looks up a phone number's line type via Telnyx
// Number Lookup. Runs server-side so the Telnyx key stays hidden and there's no
// CORS problem (which is what blocked the Claude-artifact approach).
//
// Requires env var TELNYX_API_KEY (Vercel > Settings > Environment Variables).
// Lightly gated by REPLY_SECRET so randoms can't burn lookup credits.

export default async function handler(req, res) {
  const key = process.env.TELNYX_API_KEY;
  if (!key) { res.status(500).json({ error: 'TELNYX_API_KEY is not set on the server' }); return; }

  const secret = process.env.REPLY_SECRET;
  if (secret && req.headers['x-inbox-secret'] !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }

  const number = ((req.query && req.query.number) || '').toString().trim();
  if (!number) { res.status(400).json({ error: 'number required' }); return; }

  try {
    const r = await fetch(`https://api.telnyx.com/v2/number_lookup/${encodeURIComponent(number)}?type=carrier`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = (data.errors && data.errors[0] && data.errors[0].detail) || `Telnyx HTTP ${r.status}`;
      res.status(200).json({ phone_number: number, line_type: 'error', carrier: '', textable: false, error: detail });
      return;
    }
    const d = data.data || {};
    const c = d.carrier || {};
    const type = (c.type || '').toLowerCase(); // mobile | landline | voip
    res.status(200).json({
      phone_number: d.phone_number || number,
      line_type: type || 'unknown',
      carrier: c.name || '',
      textable: type === 'mobile',
    });
  } catch (e) {
    res.status(200).json({ phone_number: number, line_type: 'error', carrier: '', textable: false, error: String((e && e.message) || e) });
  }
}
