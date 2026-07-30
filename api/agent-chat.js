// Campaign Agent chat → OpenClaw gateway (ticket: wire panel to OpenClaw).
// POST { message, sessionKey } -> { reply, runId }. Buffered (v1): waits for the full agent
// turn, then returns. The gateway token / device key stay server-side (lib/openclaw).
//
// AUTH (§4.2): the app has no session auth yet, so this is gated only by an ORIGIN allowlist as
// an INTERIM measure — it is NOT real auth. ⚠️ Follow-ups before this is safe in prod:
//   - proper per-user session auth (so sessionKey maps to a real identity)
//   - a DEDICATED OpenClaw agent for web traffic (§7: `main` shares memory/session with the
//     operator's own agent, and user text reaches an agent with shell/tools).
// Never accept a bearer/send secret from the browser here.
//
// Env: OPENCLAW_* (see lib/openclaw/gateway-client.js), OPENCLAW_ALLOWED_ORIGIN (optional).

import { runAgentTurn } from '../lib/openclaw/gateway-client.js';

export const config = { maxDuration: 300 }; // cold start can be ~90s (handoff §7)

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // interim origin gate (NOT real auth — see header note)
  const allowed = (process.env.OPENCLAW_ALLOWED_ORIGIN || '').trim();
  if (allowed) {
    const origin = req.headers.origin || '';
    if (origin && origin !== allowed) { res.status(403).json({ error: 'forbidden origin' }); return; }
  }

  const body = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const message = typeof body.message === 'string' ? body.message.slice(0, 8000) : '';
  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.slice(0, 200) : '';
  if (!message.trim()) { res.status(400).json({ error: 'message required' }); return; }
  if (!sessionKey.trim()) { res.status(400).json({ error: 'sessionKey required' }); return; }

  try {
    const { reply, runId } = await runAgentTurn({ sessionKey, text: message });
    res.status(200).json({ reply: reply || '(no reply)', runId });
  } catch (e) {
    // Do not leak internals (tokens/keys/hosts). Return a generic message + a short code.
    const msg = String((e && e.message) || e);
    const safe = /not set|unavailable/i.test(msg) ? 'Agent is not configured yet.' : /timeout/i.test(msg) ? 'The agent took too long to respond.' : 'The agent is unavailable right now.';
    res.status(502).json({ error: safe });
  }
}
