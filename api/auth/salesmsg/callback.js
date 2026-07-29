// Step 2 of the Salesmsg OAuth flow. Salesmsg redirects here with ?code=; this swaps it
// for tokens and persists them. Path must match SALESMSG_REDIRECT_URI exactly.
//
// If SUPABASE_SERVICE_ROLE_KEY is set the refresh token lands in salesmsg_secrets and
// nothing further is needed. If it is NOT set, the refresh token is shown ONCE here so it
// can be pasted into SALESMSG_REFRESH_TOKEN — Salesmsg will not show it again.

import { exchangeCode } from '../../../lib/salesmsg.js';

function page(title, bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:14px/1.6 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px">
${bodyHtml}</body>`;
}

export default async function handler(req, res) {
  const q = req.query || {};

  if (q.error) {
    res.status(400).send(page('Salesmsg — denied',
      `<h2>Authorization denied</h2><p><b>${String(q.error)}</b> ${String(q.error_description || '')}</p>`));
    return;
  }
  const code = String(q.code || '');
  if (!code) { res.status(400).send(page('Salesmsg', '<h2>Missing ?code=</h2>')); return; }

  // Reject codes that did not originate from our own /start (CSRF).
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)sm_oauth_state=([^;]+)/.exec(cookie);
  if (m && q.state && m[1] !== String(q.state)) {
    res.status(400).send(page('Salesmsg', '<h2>State mismatch</h2><p>Start again at /api/auth/salesmsg/start.</p>'));
    return;
  }

  try {
    const t = await exchangeCode(code);
    res.setHeader('Set-Cookie', 'sm_oauth_state=; Path=/; Max-Age=0');

    if (t.stored) {
      res.status(200).send(page('Salesmsg — connected',
        `<h2>Connected</h2><p>Refresh token saved to <code>salesmsg_secrets</code>. Nothing else to do.</p>
         <p>Access token expires: <b>${t.expiresAt || 'unknown'}</b></p>`));
      return;
    }

    // No durable store — show it once. Escaped so a token can never break out as markup.
    const esc = s => String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    res.status(200).send(page('Salesmsg — copy this',
      `<h2>Connected — save this now</h2>
       <p><b>SUPABASE_SERVICE_ROLE_KEY is not set</b>, so the refresh token could not be stored.
       Copy it into <code>.env</code> and the Vercel project as <code>SALESMSG_REFRESH_TOKEN</code>.
       Salesmsg will not show it again.</p>
       <pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:12px;border-radius:6px">SALESMSG_REFRESH_TOKEN=${esc(t.refresh_token)}</pre>
       <p>Access token expires: <b>${esc(t.expiresAt) || 'unknown'}</b></p>`));
  } catch (e) {
    res.status(502).send(page('Salesmsg — failed',
      `<h2>Token exchange failed</h2><pre>${String((e && e.message) || e).replace(/[<>]/g, '')}</pre>`));
  }
}
