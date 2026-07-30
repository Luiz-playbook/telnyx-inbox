// OpenClaw Gateway WebSocket client — server-side, TOKEN AUTH (same as the OpenClaw CLI, which
// connects with just --token; no device pairing/approval needed). One agent turn per call:
// connect → chat.send → collect the streamed reply → return it → close.
//
// Confirmed against the live gateway (2026.7.1-2): chat.send params are
//   { sessionKey: "agent:<agentId>:<name>", agentId, message, idempotencyKey }  (all required),
// and it acks with { runId, status:"started" } — the reply then streams as events by runId.
// The exact reply-event field/name isn't pinned, so we accept any text-bearing field and finish
// on an explicit completion signal OR when the stream goes quiet (robust to naming).
//
// Env: OPENCLAW_GATEWAY_URL (wss://host/ via Tailscale Funnel), OPENCLAW_GATEWAY_TOKEN,
//      OPENCLAW_AGENT_ID (default "main"). No device key required.

import { randomUUID } from 'node:crypto';

const PROTOCOL = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const QUIET_MS = 4_000; // reply considered done if no new text arrives for this long
const CLIENT = { id: 'marketing-blaster', version: '1.0.0', platform: 'vercel' };

export async function runAgentTurn({ sessionKey, text, agentId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = (process.env.OPENCLAW_GATEWAY_URL || '').trim();
  const token = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  if (!url) throw new Error('OPENCLAW_GATEWAY_URL not set');
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN not set');
  if (!text || !text.trim()) throw new Error('text required');
  if (typeof WebSocket === 'undefined') throw new Error('global WebSocket unavailable (need Node 22+ or the ws package)');

  agentId = agentId || (process.env.OPENCLAW_AGENT_ID || 'main').trim();
  // sessionKey must encode the agentId: agent:<agentId>:<name> (gateway rejects a mismatch).
  const userPart = String(sessionKey || 'default').replace(/^agent:[^:]*:/, '').replace(/[^A-Za-z0-9._-]/g, '-') || 'default';
  const fullSession = `agent:${agentId}:${userPart}`;

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let connected = false, runId = null, buf = '', settled = false, quiet = null;

    const hard = setTimeout(() => finish(new Error('gateway timeout')), timeoutMs);
    function finish(err, reply) {
      if (settled) return; settled = true;
      clearTimeout(hard); if (quiet) clearTimeout(quiet);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(reply);
    }
    function armQuiet() { if (quiet) clearTimeout(quiet); quiet = setTimeout(() => { if (buf.trim()) finish(null, { reply: buf.trim(), runId }); }, QUIET_MS); }
    const send = (o) => ws.send(JSON.stringify(o));
    function request(method, params) { const id = randomUUID(); return new Promise((res, rej) => { pending.set(id, { res, rej }); send({ type: 'req', id, method, params }); }); }

    ws.onerror = () => finish(new Error('gateway socket error'));
    ws.onclose = () => { if (buf.trim()) finish(null, { reply: buf.trim(), runId }); else finish(new Error('gateway closed before reply')); };

    ws.onmessage = async (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }

      if (m.type === 'res') {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.ok ? p.res(m.payload) : p.rej(Object.assign(new Error(m.error?.message || 'gateway error'), { detail: m.error })); }
        return;
      }
      if (m.type !== 'event') return;

      // handshake: token-only connect on the challenge, then send the user's message
      if (m.event === 'connect.challenge' && !connected) {
        connected = true;
        try {
          await request('connect', { minProtocol: PROTOCOL, maxProtocol: PROTOCOL, client: CLIENT, role: 'operator', scopes: ['operator.read', 'operator.write'], auth: { token } });
          const idem = randomUUID(); runId = idem;
          const ackId = randomUUID();
          pending.set(ackId, { res: (p) => { if (p && p.runId) runId = p.runId; }, rej: (e) => finish(e) });
          send({ type: 'req', id: ackId, method: 'chat.send', params: { sessionKey: fullSession, agentId, message: text, idempotencyKey: idem } });
        } catch (e) {
          // Token auth should just work (the CLI proves it). If this gateway is in pairing mode
          // instead, surface a one-time actionable message rather than a mystery failure.
          const msg = String(e?.detail?.code || e?.detail?.reason || e?.message || e);
          if (/approv|pending|device.*(not.*approv|unauthori)/i.test(msg)) finish(new Error('device_pending_approval: run `openclaw devices approve --latest` on the gateway once, then retry'));
          else finish(e);
        }
        return;
      }

      // reply stream: accept any text-bearing field for our run; finish on completion or quiet.
      const p = m.payload || {};
      if (runId && p.runId && p.runId !== runId) return; // a different run's events
      const delta = typeof p.deltaText === 'string' ? p.deltaText : (typeof p.delta === 'string' ? p.delta : '');
      const full  = typeof p.message === 'string' ? p.message : (typeof p.text === 'string' ? p.text : (typeof p.content === 'string' ? p.content : ''));
      if (full) buf = full; else if (delta) buf += delta;
      if (delta || full) armQuiet();
      const done = p.final === true || p.done === true || p.status === 'completed' || p.status === 'complete'
        || /(final|completed|done|end)$/i.test(String(m.event || ''));
      if (done && buf.trim()) finish(null, { reply: buf.trim(), runId });
    };
  });
}
