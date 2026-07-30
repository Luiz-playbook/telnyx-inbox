// OpenClaw Gateway WebSocket client — server-side. One agent turn per call:
// connect (device-paired) → chat.send → collect the streamed reply → return it → close.
//
// AUTH MODEL (confirmed against the live gateway, 2026.7.1-2):
//   The shared gateway token only earns operator.read from a remote connection. Calling
//   chat.send needs operator.write, which is granted to an *approved device*. So this client
//   presents a stable Ed25519 device identity and signs the connect challenge exactly the way
//   OpenClaw's own control UI does (dist/device-identity + gateway client):
//     canonical = ["v2", deviceId, clientId, clientMode, role, scopes.join(","),
//                  String(signedAtMs), token, nonce].join("|")
//     signature = base64url( ed25519_sign(privateKeyPem, canonical) )
//     device    = { id: deviceId, publicKey: <raw pubkey base64url>, signature, signedAt, nonce }
//   where deviceId = sha256(raw 32-byte ed25519 public key).hex. The device must be approved
//   once on the gateway (`openclaw devices approve`) with operator.read + operator.write.
//
// chat.send params: { sessionKey:"agent:<agentId>:<name>", agentId, message, idempotencyKey }.
// It acks { runId, status:"started" }; the reply then streams as `chat` events for that runId:
//   { state:"delta", deltaText }         — incremental text
//   { state:"final", message:{content:[{type:"text",text}]}, stopReason } — complete
//
// Env: OPENCLAW_GATEWAY_URL (wss://host/ via Tailscale Funnel), OPENCLAW_GATEWAY_TOKEN,
//      OPENCLAW_DEVICE_KEY (base64 of the PKCS8 Ed25519 private-key PEM — the write credential;
//      server-only, never in the browser bundle), OPENCLAW_AGENT_ID (default "main").

import crypto from 'node:crypto';

const PROTOCOL = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const QUIET_MS = 8_000; // fallback: finish if the stream goes quiet without an explicit final
// CONFIRMED: client.id / client.mode are strict enums; { id:"cli", mode:"cli" } is accepted.
const CLIENT = { id: 'cli', mode: 'cli', version: '1.0.0', platform: 'vercel' };
const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.write'];

const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');

// Derive the full device identity from the private-key PEM alone (public key + deviceId).
function deviceIdentity(privateKeyPem) {
  const priv = crypto.createPrivateKey(privateKeyPem);
  const spki = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 32); // strip the 12-byte Ed25519 SPKI prefix
  return {
    privateKeyPem,
    pubB64Url: b64url(raw),
    deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function signConnectDevice(id, token, nonce) {
  const signedAtMs = Date.now();
  const canonical = ['v2', id.deviceId, CLIENT.id, CLIENT.mode, ROLE, SCOPES.join(','), String(signedAtMs), token ?? '', nonce].join('|');
  const signature = b64url(crypto.sign(null, Buffer.from(canonical, 'utf8'), crypto.createPrivateKey(id.privateKeyPem)));
  return { id: id.deviceId, publicKey: id.pubB64Url, signature, signedAt: signedAtMs, nonce };
}

// Pull the plain text out of a { content:[{type:"text",text}] } assistant message.
function messageText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) return message.content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('');
  if (typeof message.content === 'string') return message.content;
  return '';
}

export async function runAgentTurn({ sessionKey, text, agentId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = (process.env.OPENCLAW_GATEWAY_URL || '').trim();
  const token = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  const keyB64 = (process.env.OPENCLAW_DEVICE_KEY || '').trim();
  if (!url) throw new Error('OPENCLAW_GATEWAY_URL not set');
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN not set');
  if (!keyB64) throw new Error('OPENCLAW_DEVICE_KEY not set (the approved-device private key)');
  if (!text || !text.trim()) throw new Error('text required');
  if (typeof WebSocket === 'undefined') throw new Error('global WebSocket unavailable (need Node 22+)');

  let id;
  try {
    const pem = Buffer.from(keyB64, 'base64').toString('utf8');
    id = deviceIdentity(pem.includes('BEGIN') ? pem : keyB64); // tolerate a raw (non-b64) PEM too
  } catch (e) {
    throw new Error('OPENCLAW_DEVICE_KEY invalid: ' + (e?.message || e));
  }

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
    function request(method, params) { const rid = crypto.randomUUID(); return new Promise((res, rej) => { pending.set(rid, { res, rej }); send({ type: 'req', id: rid, method, params }); }); }

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

      // handshake: sign the challenge nonce, connect as an approved device, then send the message.
      if (m.event === 'connect.challenge' && !connected) {
        connected = true;
        const nonce = m.payload?.nonce || '';
        try {
          await request('connect', {
            minProtocol: PROTOCOL, maxProtocol: PROTOCOL, client: CLIENT, role: ROLE, scopes: SCOPES,
            device: signConnectDevice(id, token, nonce), caps: ['tool-events'], auth: { token },
          });
          const idem = crypto.randomUUID(); runId = idem;
          const ack = await request('chat.send', { sessionKey: fullSession, agentId, message: text, idempotencyKey: idem });
          if (ack && ack.runId) runId = ack.runId;
        } catch (e) {
          const code = String(e?.detail?.code || e?.detail?.details?.code || '');
          const msg = String(e?.detail?.message || e?.message || e);
          if (/NOT_PAIRED|PAIRING_REQUIRED/i.test(code) || /pairing required|not approved/i.test(msg)) {
            finish(new Error('device_pending_approval: approve this device on the gateway once (`openclaw devices approve --latest`), then retry'));
          } else finish(e);
        }
        return;
      }

      // Reply stream for our run. The `chat` events are the canonical text stream (delta then
      // final); the parallel `agent.assistant` stream repeats the same text, so we deliberately
      // read only `chat` here — reading both would double the reply. `agent` lifecycle `end` is
      // used solely as a finish trigger for whatever the chat stream already accumulated.
      const p = m.payload || {};
      if (runId && p.runId && p.runId !== runId) return; // a different run's events

      if (m.event === 'chat') {
        const full = messageText(p.message);
        if (p.state === 'final') { finish(null, { reply: (full || buf).trim(), runId }); return; }
        if (typeof p.deltaText === 'string') { buf += p.deltaText; armQuiet(); return; }
        if (full) { buf = full; armQuiet(); } // non-final snapshot: replace, don't append
        return;
      }
      if (m.event === 'agent' && p.stream === 'lifecycle' && p.data?.phase === 'end') {
        if (buf.trim()) finish(null, { reply: buf.trim(), runId });
        return;
      }
    };
  });
}
