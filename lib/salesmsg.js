// Salesmsg OAuth + API access. ONE implementation shared by the sync, the send path and
// the OAuth callback, so token handling can never drift between them.
//
// Salesmsg only supports the authorization_code grant — client_credentials and password
// are both rejected by the token endpoint, so a human authorizes once and everything
// afterwards runs off the refresh token.
//
// Access tokens last ~72h. They are cached in module memory (per warm serverless
// instance) and refreshed on demand, so a cold start costs one extra round trip.
//
// Refresh-token storage, in priority order:
//   1. public.salesmsg_secrets, keyed by client_id — survives rotation, needs
//      SUPABASE_SERVICE_ROLE_KEY (the table is RLS-on with zero policies, so anon
//      cannot touch it, which is the point: these are credentials).
//   2. SALESMSG_REFRESH_TOKEN env var — works only if Salesmsg hands back the SAME
//      refresh token each time. If it rotates, the new one cannot be written back to
//      the environment at runtime and the next refresh fails. rotationWarning() flags
//      that case loudly rather than letting it fail silently days later.
//
// Env: SALESMSG_CLIENT_ID, SALESMSG_CLIENT_SECRET, SALESMSG_REDIRECT_URI,
//      optional SALESMSG_REFRESH_TOKEN, optional SUPABASE_SERVICE_ROLE_KEY.

const AUTH_BASE = 'https://app.salesmessage.com/auth/oauth';
const API_BASE = 'https://api.salesmessage.com/pub/v2.2';
const TOKEN_URL = `${API_BASE}/oauth/token`;

// Scopes the registered app carries. Keep in sync with the Salesmsg app config —
// asking for a scope the app was not granted makes the whole authorize call fail.
export const SCOPES = [
  'contacts:read', 'contacts:write',
  'conversations:read', 'conversations:write',
  'messages:read', 'messages:write',
  'broadcasts:read', 'broadcasts:write',
  'numbers:read', 'teams:read',
].join(' ');

export const clientId = () => (process.env.SALESMSG_CLIENT_ID || '').trim();
export const clientSecret = () => (process.env.SALESMSG_CLIENT_SECRET || '').trim();
export const redirectUri = () => (process.env.SALESMSG_REDIRECT_URI || '').trim();

// Step 1 of the flow: where to send the browser.
export function authorizeUrl(state) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
  });
  return `${AUTH_BASE}?${q}`;
}

// ---- token store -----------------------------------------------------------------

function serviceHeaders() {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) return null;
  return { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

async function readStoredRefresh() {
  const h = serviceHeaders(), url = process.env.SUPABASE_URL;
  if (!h || !url) return null;
  const r = await fetch(
    `${url}/rest/v1/salesmsg_secrets?client_id=eq.${encodeURIComponent(clientId())}&select=refresh_token&order=last_updated.desc&limit=1`,
    { headers: h });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return (Array.isArray(rows) && rows[0] && rows[0].refresh_token) || null;
}

// Upsert by client_id. Rows for OTHER client_ids (older app registrations from previous
// projects) are deliberately left alone.
export async function storeTokens({ refreshToken, accessToken, expiresAt }) {
  const h = serviceHeaders(), url = process.env.SUPABASE_URL;
  if (!h || !url) return false;
  const body = {
    service_name: 'salesmsg', client_id: clientId(), client_secret: clientSecret(),
    refresh_token: refreshToken, access_token: accessToken || null,
    access_token_expires_at: expiresAt || null, last_updated: new Date().toISOString(),
  };
  const existing = await fetch(
    `${url}/rest/v1/salesmsg_secrets?client_id=eq.${encodeURIComponent(clientId())}&select=id&limit=1`,
    { headers: h });
  const rows = existing.ok ? await existing.json().catch(() => []) : [];
  const r = rows && rows[0]
    ? await fetch(`${url}/rest/v1/salesmsg_secrets?id=eq.${rows[0].id}`,
        { method: 'PATCH', headers: h, body: JSON.stringify(body) })
    : await fetch(`${url}/rest/v1/salesmsg_secrets`,
        { method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  return r.ok;
}

// ---- token exchange --------------------------------------------------------------

async function tokenCall(payload) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId(), client_secret: clientSecret(), ...payload }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (j && (j.error_description || j.error || j.message)) || `HTTP ${r.status}`;
    const e = new Error(`Salesmsg token: ${msg}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

// Step 2: swap the ?code= from the callback for tokens, and persist them.
export async function exchangeCode(code) {
  const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const expiresAt = t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null;
  const stored = await storeTokens({
    refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt,
  });
  return { ...t, expiresAt, stored };
}

let cached = { token: null, expiresAtMs: 0 };
let rotated = false;

// True once a refresh has handed back a DIFFERENT refresh token while we had nowhere
// durable to write it — i.e. the env-var-only setup is now on borrowed time.
export const rotationWarning = () => rotated;

export async function getAccessToken({ force = false } = {}) {
  // 60s skew so a token never expires mid-request.
  if (!force && cached.token && Date.now() < cached.expiresAtMs - 60_000) return cached.token;

  const stored = await readStoredRefresh();
  const refreshToken = stored || (process.env.SALESMSG_REFRESH_TOKEN || '').trim();
  if (!refreshToken) {
    throw new Error('Salesmsg: no refresh token — run /api/auth/salesmsg/start once to authorize');
  }

  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const expiresAt = t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null;

  if (t.refresh_token && t.refresh_token !== refreshToken) {
    const ok = await storeTokens({ refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt });
    // Rotated with no durable store: this access token works, the NEXT refresh will not.
    if (!ok) rotated = true;
  }

  cached = { token: t.access_token, expiresAtMs: t.expires_in ? Date.now() + t.expires_in * 1000 : Date.now() + 3600_000 };
  return cached.token;
}

// ---- API ---------------------------------------------------------------------------

export async function api(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const m = json && (json.message || json.error);
    const msg = Array.isArray(m) ? m.join('; ') : (m || text || `HTTP ${r.status}`);
    const e = new Error(`Salesmsg ${method} ${path} → ${r.status}: ${msg}`);
    e.status = r.status;
    e.body = json;
    throw e;
  }
  return json;
}

// ---- senders + sending ---------------------------------------------------------------
//
// Salesmsg sends FROM a team (an inbox), not from a bare phone number: POST /async/messages
// takes { number, team_id, message } where `number` is the RECIPIENT and team_id selects
// the inbox the message goes out from. So a sender option has to carry both, which is why
// the stored value is 'salesmsg:<team_id>:<phone>' — the same shape as the CakeMail
// 'cakemail:<account_id>:<sender_id>' values, for the same reason.

// 'salesmsg:<team_id>:<phone>' → { teamId, phone }; anything else → null.
// Mirrors salesmsgSender in ui/index.html — keep both in sync.
export const parseSalesmsgFrom = v => {
  const m = /^salesmsg:([^:]+):(.+)$/.exec(String(v || ''));
  return m ? { teamId: m[1], phone: m[2] } : null;
};

const pickField = (o, keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; };

// Every number the account can send from, tagged with the team that owns it.
//
// GET /numbers has no documented response schema, so fields are read best-effort rather
// than assumed — the same defensive approach api/salesmsg-sync.js takes with broadcasts.
// Numbers are fetched per team via /teams/{team}/numbers, which is what ties a phone to
// the team_id the send call needs; a number with no team cannot be sent from.
export async function listSenders() {
  const teamsRes = await api('/teams?limit=100');
  const teams = teamsRes?.data || teamsRes || [];
  const out = [];
  for (const t of (Array.isArray(teams) ? teams : [])) {
    const teamId = pickField(t, ['id']);
    if (teamId == null) continue;
    let nums = [];
    try {
      const r = await api(`/teams/${teamId}/numbers?limit=100`);
      nums = r?.data || r || [];
    } catch { continue; }        // a team we cannot read numbers for simply contributes none
    for (const n of (Array.isArray(nums) ? nums : [])) {
      const phone = pickField(n, ['number', 'phone_number', 'phone', 'e164', 'value']);
      if (!phone) continue;
      out.push({
        value: `salesmsg:${teamId}:${phone}`,
        phone: String(phone),
        team_id: String(teamId),
        team_name: pickField(t, ['name', 'inbox_identifier']) || `Team ${teamId}`,
      });
    }
  }
  return out;
}

// One SMS to one recipient. Async endpoint: Salesmsg queues it and returns immediately,
// which is what makes a market-sized send finish inside a serverless timeout.
export async function sendSms({ teamId, to, message }) {
  if (!teamId) throw new Error('salesmsg: team_id is required');
  if (!to) throw new Error('salesmsg: recipient number is required');
  if (!message) throw new Error('salesmsg: message is required');
  return api('/async/messages', {
    method: 'POST',
    body: { number: String(to), team_id: Number(teamId), message: String(message) },
  });
}

// A whole market. Salesmsg has no "one call, many recipients" primitive that takes raw
// phone numbers — POST /broadcasts targets saved contacts through a filter group, which
// would mean importing every market into Salesmsg's contact book first. So this fans out
// per recipient, bounded so a 1,000-number market neither stalls nor floods the API.
//
// Partial success is REPORTED, not thrown: some recipients getting the blast while others
// fail is the normal outcome of a fan-out, and the caller needs to know which.
export async function sendSmsBulk({ teamId, to = [], message, concurrency = 8 }) {
  const list = [...new Set((to || []).map(x => String(x || '').trim()).filter(Boolean))];
  const sent = [], failed = [];
  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async n => {
      try { await sendSms({ teamId, to: n, message }); return { n, ok: true }; }
      catch (e) { return { n, ok: false, error: String((e && e.message) || e) }; }
    }));
    results.forEach(r => (r.ok ? sent : failed).push(r.ok ? r.n : { number: r.n, error: r.error }));
  }
  return { sent: sent.length, failed, total: list.length };
}
