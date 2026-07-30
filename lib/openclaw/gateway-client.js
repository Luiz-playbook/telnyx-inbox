// OpenClaw Gateway WebSocket client (v4 protocol) — server-side only.
//
// One agent turn per call: open wss → challenge/sign/connect handshake → chat.send →
// accumulate streamed `agent` events → return the assistant reply → close. Vercel functions
// are stateless, so every request reconnects; the device token is reused from Supabase to skip
// device re-registration.
//
// Uses Node's built-in global WebSocket (Node 22 on Vercel) and node:crypto for Ed25519 — no
// npm deps, matching this repo's zero-package.json serverless model.
//
// ⚠️  PROTOCOL NOT YET VERIFIED AGAINST A LIVE GATEWAY (handoff §8). Every spot the exact wire
//     detail is a guess is marked `VERIFY:`. Confirm over an SSH tunnel before trusting output:
//       - the WebSocket path (docs imply no path; dashboard uses ws://host:18789)
//       - exactly which bytes are signed for the device challenge
//       - the precise chat.send param names and the RUN-COMPLETION event/signal
//       - the exact "pending approval" error shape on a NEW device's first connect
//         (real flow: first connect FAILS pending approval → human runs
//          `openclaw devices approve <deviceId>` → next connect returns the reusable deviceToken)
//
// Env: OPENCLAW_GATEWAY_URL (wss://host/), OPENCLAW_GATEWAY_TOKEN, OPENCLAW_DEVICE_PRIVATE_KEY
//      (base64 PKCS8 Ed25519), OPENCLAW_AGENT_ID, SUPABASE_URL, SUPABASE_ANON_KEY.

import { randomUUID, createPrivateKey, createPublicKey, sign as edSign, createHash } from 'node:crypto';

const PROTOCOL = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const CLIENT = { id: 'marketing-blaster', version: '1.0.0', platform: 'vercel' };

// ---- Ed25519 identity ------------------------------------------------------
function loadIdentity() {
  const b64 = (process.env.OPENCLAW_DEVICE_PRIVATE_KEY || '').trim();
  if (!b64) throw new Error('OPENCLAW_DEVICE_PRIVATE_KEY not set');
  const privateKey = createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
  const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicKeyB64 = Buffer.from(publicKeyDer).toString('base64');
  // Stable device fingerprint from the public key (never from anything per-request).
  const deviceId = 'blaster-' + createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 24);
  return { privateKey, publicKeyB64, deviceId };
}

function signChallenge(privateKey, deviceId, nonce, ts) {
  // VERIFY: the exact challenge-bound payload the gateway expects. Signing a canonical JSON of
  // the device identity + nonce is the common shape; adjust to match the server once tested.
  const payload = Buffer.from(JSON.stringify({ id: deviceId, nonce, ts, protocol: PROTOCOL }));
  return edSign(null, payload, privateKey).toString('base64'); // null algo = Ed25519
}

// ---- device-token persistence (Supabase RPC, anon key) ---------------------
function supa() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  return { rpc: (fn, body) => fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(body || {}) }) };
}
async function loadDeviceToken(deviceId) {
  const s = supa(); if (!s) return null;
  try { const r = await (await s.rpc('get_openclaw_device_token', { p_device_id: deviceId })).json(); return r && r.token || null; } catch { return null; }
}
async function saveDeviceToken(deviceId, token, publicKey) {
  const s = supa(); if (!s || !token) return;
  try { await s.rpc('set_openclaw_device_token', { p_device_id: deviceId, p_token: token, p_public_key: publicKey }); } catch { /* best-effort */ }
}

// ---- one agent turn --------------------------------------------------------
export async function runAgentTurn({ sessionKey, text, agentId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!sessionKey) throw new Error('sessionKey required');
  if (!text || !text.trim()) throw new Error('text required');
  const url = (process.env.OPENCLAW_GATEWAY_URL || '').trim();
  const token = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  if (!url) throw new Error('OPENCLAW_GATEWAY_URL not set');
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN not set');
  if (typeof WebSocket === 'undefined') throw new Error('global WebSocket unavailable — add the "ws" package or a newer Node');

  const { privateKey, publicKeyB64, deviceId } = loadIdentity();
  const priorDeviceToken = await loadDeviceToken(deviceId);
  agentId = agentId || (process.env.OPENCLAW_AGENT_ID || 'main').trim();

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();        // req id -> {resolve,reject}
    const runs = new Map();           // runId -> cumulative text
    let connected = false, chatId = null, activeRunId = null, settled = false;

    const timer = setTimeout(() => finish(new Error('gateway timeout')), timeoutMs);
    function finish(err, reply) {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(reply);
    }
    const send = (obj) => ws.send(JSON.stringify(obj));
    function request(method, params) {
      const id = randomUUID();
      return new Promise((res, rej) => { pending.set(id, { res, rej }); send({ type: 'req', id, method, params }); });
    }

    ws.onopen = () => { /* wait for the connect.challenge event before authenticating */ };
    ws.onerror = () => finish(new Error('gateway socket error'));
    ws.onclose = () => { if (!settled) finish(new Error('gateway closed before run completed')); };

    ws.onmessage = async (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }

      // responses (correlate by id)
      if (m.type === 'res') {
        const p = pending.get(m.id); if (p) { pending.delete(m.id); m.ok ? p.res(m.payload) : p.rej(Object.assign(new Error(m.error?.message || 'gateway error'), { detail: m.error })); }
        return;
      }
      if (m.type !== 'event') return;

      // handshake: server issues a challenge, we sign + connect
      if (m.event === 'connect.challenge' && !connected) {
        connected = true;
        const { nonce, ts } = m.payload || {};
        try {
          const hello = await request('connect', {
            minProtocol: PROTOCOL, maxProtocol: PROTOCOL, client: CLIENT,
            role: 'operator', scopes: ['operator.read', 'operator.write'],
            auth: { token, ...(priorDeviceToken ? { deviceToken: priorDeviceToken } : {}) },
            device: { id: deviceId, publicKey: publicKeyB64, signature: signChallenge(privateKey, deviceId, nonce, ts), nonce },
          });
          if (hello?.auth?.deviceToken) await saveDeviceToken(deviceId, hello.auth.deviceToken, publicKeyB64);
          // authenticated — send the user's message
          chatId = randomUUID();
          pending.set(chatId, { res: () => {}, rej: (e) => finish(e) }); // ack; completion comes via agent events
          send({ type: 'req', id: chatId, method: 'chat.send', params: {
            sessionKey, agentId, text, idempotencyKey: randomUUID(),
          } });
        } catch (e) {
          // REAL device flow (corrects the spec's guess): a NEW device's first connect FAILS
          // "pending approval". A human must run `openclaw devices approve <deviceId>` on the
          // gateway; the next connect returns a deviceToken we persist and reuse. Surface an
          // actionable error rather than a generic failure. VERIFY: exact error code/message.
          const msg = String(e?.detail?.code || e?.detail?.reason || e?.message || e);
          if (/approv|pending|device.*(not.*approv|unauthori)/i.test(msg)) {
            finish(new Error(`device_pending_approval: on the gateway run \`openclaw devices approve ${deviceId}\`, then retry`));
          } else finish(e);
        }
        return;
      }

      // streamed agent output. VERIFY: event name(s) and the delta/cumulative/final fields.
      if (m.event === 'agent' || m.event === 'chat.delta' || m.event === 'chat.message') {
        const p = m.payload || {};
        const runId = p.runId || activeRunId; if (runId) activeRunId = runId;
        const cur = runs.get(runId) || '';
        if (typeof p.message === 'string') runs.set(runId, p.message);           // cumulative snapshot
        else if (typeof p.deltaText === 'string') runs.set(runId, cur + p.deltaText); // delta
        // VERIFY: the terminal signal. Common shapes: payload.final===true / payload.status==='completed'
        // / a distinct 'agent.done' | 'chat.completed' event. Resolve when the run is done.
        const done = p.final === true || p.done === true || p.status === 'completed' || m.event === 'chat.completed' || m.event === 'agent.done';
        if (done) finish(null, { reply: (runs.get(runId) || '').trim(), runId });
      }
    };
  });
}
