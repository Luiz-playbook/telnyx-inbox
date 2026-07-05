// Serverless function (runs on Vercel) — scrapes a company website with Firecrawl.
// The Firecrawl API key stays here on the server; the browser never sees it.
// This is the "manual, in-code" scrape path. (The AI path lives in n8n.)
//
// Requires env var FIRECRAWL_API_KEY (set in Vercel > Settings > Environment
// Variables). Optionally gated by REPLY_SECRET so randoms can't burn the quota.

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) { res.status(500).json({ error: 'FIRECRAWL_API_KEY is not set on the server' }); return; }

  // Light abuse gate: the UI sends the shared secret. Skipped if none configured.
  const secret = process.env.REPLY_SECRET;
  if (secret && req.headers['x-inbox-secret'] !== secret) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const url = body && body.url;
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }

  try {
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.success === false) {
      res.status(502).json({ error: data.error || `Firecrawl HTTP ${r.status}` }); return;
    }
    const d = data.data || {};
    res.status(200).json({ markdown: d.markdown || '', metadata: d.metadata || {} });
  } catch (err) {
    res.status(502).json({ error: String((err && err.message) || err) });
  }
}
