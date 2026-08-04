// Campaign Agent chat → OpenClaw gateway (ticket: wire panel to OpenClaw).
// POST { message, sessionKey } -> Server-Sent Events (v2): the reply streams token-by-token as the
// agent produces it, so the browser shows text at ~2s instead of a 30–60s blank wait. Events:
//   data: {"type":"delta","text":"..."}    — incremental reply text
//   data: {"type":"done","reply":"...","runId":"..."}  — full reply, end of turn
//   data: {"type":"error","error":"..."}   — safe, generic failure message
// The gateway token / device key stay server-side (lib/openclaw).
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
import { gate } from '../lib/auth.js';

export const config = { maxDuration: 300 }; // cold start can be ~90s (handoff §7)

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // Real auth, checked before the origin allowlist below. This route drives the agent, which
  // can edit the queue and the decider rules — an origin header is a request-shaped hint, not
  // a credential, and the header note has always said so.
  if (!await gate(req, res)) return;

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

  // SSE: stream deltas as they arrive. Status is 200 up front (we can't change it mid-stream), so
  // failures are delivered as an in-band {type:"error"} event, not an HTTP error code.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // defeat proxy buffering so deltas flush immediately
  });
  const sse = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

  try {
    // Tool-heavy turns (queue/price lookups) can take a minute+; allow well under maxDuration (300s).
    const { reply, runId } = await runAgentTurn({
      sessionKey, text: message, timeoutMs: 240_000,
      onDelta: (chunk) => sse({ type: 'delta', text: chunk }),
    });
    // One-line breadcrumb so an empty/odd reply is visible in `vercel logs` after the fact
    // (turns aren't otherwise persisted). Truncated + no message body, so it stays low-noise.
    console.log(`[agent-chat] runId=${runId || '-'} session=${sessionKey} replyLen=${(reply || '').length} preview=${JSON.stringify((reply || '').slice(0, 80))}`);
    sse({ type: 'done', reply: reply || '(no reply)', runId });
  } catch (e) {
    // Do not leak internals (tokens/keys/hosts). Send a generic message + a short code in-band.
    const msg = String((e && e.message) || e);
    const safe = /device_pending_approval/i.test(msg) ? 'This device is awaiting one-time approval on the gateway.'
      : /not set/i.test(msg) ? 'Agent is not configured yet.'
      : /timeout|too long/i.test(msg) ? 'The agent took too long to respond.'
      : 'The agent is unavailable right now.';
    sse({ type: 'error', error: safe });
  } finally {
    res.end();
  }
}
