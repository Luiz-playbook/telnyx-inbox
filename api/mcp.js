// A Claude connector for SendBlaster (AI-1085): the reads Cole does every day, as MCP tools.
//
// WHAT THIS IS FOR. Cole runs his daily instructions through the OpenClaw agent on the VPS,
// which burns credits and needs the gateway kept alive. A Claude project can do the same work
// if it can SEE the queue, the offers and the send history — and that is all this route gives
// it. It is one Vercel function speaking MCP over plain HTTP (JSON-RPC in, JSON out), with no
// SDK and no session state, so it deploys like every other file in api/.
//
// NO SEND CAPABILITY, BY DESIGN — the same rule as AI-959 for the OpenClaw agent. Every tool
// here is a read. There is no queue_confirm, no queue-tick, no CakeMail, no bulk sender. If a
// write ever lands in this file it belongs behind its own flag, its own secret and a row in
// log_run_edit, not next to these.
//
// AUTH. A shared secret, MCP_SECRET, accepted two ways:
//   Authorization: Bearer <secret>     — Claude Code, the API, curl.
//   /api/mcp/<secret> in the PATH      — claude.ai "custom connector", which can set no header
//                                        and otherwise needs a full OAuth server. The key in the
//                                        URL is the trade for a POC that connects in a minute;
//                                        the write-up (docs/AI-1085-mcp-connector.md) says what
//                                        replacing it costs. vercel.json rewrites the path form
//                                        to ?key=, which is also accepted directly.
//                                        ▲ 2026-10-09: it was ?key= only, and claude.ai dropped
//                                        the query string before its first call, got a 401, and
//                                        went looking for an OAuth server that does not exist
//                                        ("Couldn't register with the sign-in service").
// FAILS CLOSED: no MCP_SECRET set, nothing answers. Rotating it is one env change.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (lib/supabase.js), MCP_SECRET.

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';

export const config = { maxDuration: 30 };

const PROTOCOL = '2025-06-18';
const SERVER = { name: 'sendblaster', version: '0.1.0' };

// ── Supabase reads ───────────────────────────────────────────────────────────────────────────

function supa() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = supabaseKey();
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return { url, headers: supabaseHeaders(key) };
}

async function rest(path) {
  const { url, headers } = supa();
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`${r.status} from ${path.split('?')[0]}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function rpc(name, body = {}) {
  const { url, headers } = supa();
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} from rpc ${name}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : dflt;
};
const enc = encodeURIComponent;

// Copy is long and the model only needs it when it asks for one row. Lists carry a preview.
const preview = (s, n = 140) => (s == null ? null : String(s).replace(/\s+/g, ' ').slice(0, n));

// ── Tools ────────────────────────────────────────────────────────────────────────────────────
//
// Each entry: the schema the client sees, and the read behind it. Descriptions are written for
// the MODEL — they say when to reach for the tool and what the answer means, because that is
// what decides whether Cole's instruction "what's queued for Texas this week?" lands on the
// right call.

const TOOLS = {
  list_queue: {
    description:
      'The campaign queue: every blast that is queued, confirmed, sent, partial or rejected, ' +
      'newest first. Use this for "what is queued", "what went out", "what failed". Returns a ' +
      'preview of the copy; call get_queue_row for the full text of one row.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'confirmed', 'sent', 'partial', 'rejected'], description: 'Only rows in this status. Omit for all.' },
        state_code: { type: 'string', description: 'Two-letter state, e.g. TX. Omit for all markets.' },
        limit: { type: 'integer', description: '1-200, default 50.' },
      },
    },
    run: async ({ status, state_code, limit }) => {
      const rows = await rpc('get_campaign_queue');
      const lim = clamp(limit, 1, 200, 50);
      const st = status ? String(status).toLowerCase() : null;
      const sc = state_code ? String(state_code).toUpperCase() : null;
      const out = rows
        .filter(r => !r.archived_at)
        .filter(r => (!st || r.status === st) && (!sc || r.state_code === sc))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, lim)
        .map(r => ({
          id: r.id, title: r.title, status: r.status, segment: r.segment, strategy: r.strategy,
          market: r.market_key, state: r.state_code, team: r.team, opponent: r.opponent,
          event_date: r.event_date, league: r.league, ticket_price: r.ticket_price,
          channels: { email: !!r.email, sms: !!r.sms },
          audience: { emails: r.segment_email_count ?? r.email_count, phones: r.segment_phone_count ?? r.phone_count },
          from: { email: r.email_from, sms: r.sms_from },
          scheduled_for: r.scheduled_for, confirmed_at: r.confirmed_at, sent_at: r.sent_at,
          rejected_at: r.rejected_at, reject_note: r.reject_note, send_failures: r.send_failures,
          placeholder: !!r.is_placeholder,
          email_subject: r.email_subject, email_preview: preview(r.email_copy), sms_preview: preview(r.sms_copy),
        }));
      return { count: out.length, rows: out };
    },
  },

  get_queue_row: {
    description: 'One queue row in full: the email and SMS copy as it will be sent, the sender, the schedule and any send failures.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The queue row id (uuid).' } }, required: ['id'] },
    run: async ({ id }) => {
      const rows = await rpc('get_campaign_queue');
      const r = rows.find(x => x.id === String(id));
      if (!r) return { found: false, id };
      return { found: true, row: r };
    },
  },

  recommend_events: {
    description:
      'The decider\'s ranked list of upcoming games and what it would do with each: decision ' +
      '(send / hold / skip), the reason code, cooldown, audience match and the best past ' +
      'template for that market. This is "what should we blast next".',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['send', 'hold', 'skip'], description: 'Only rows with this decision. Omit for all.' },
        limit: { type: 'integer', description: '1-200, default 40.' },
      },
    },
    run: async ({ decision, limit }) => {
      const rows = await rpc('rpc_event_recommendations');
      const d = decision ? String(decision).toLowerCase() : null;
      const out = rows.filter(r => !d || String(r.decision).toLowerCase() === d).slice(0, clamp(limit, 1, 200, 40));
      return { count: out.length, rows: out };
    },
  },

  list_offers: {
    description:
      'Offers generated by the strategy crons (Youth Events and others), with their market, ' +
      'segment and status. Ticket-game offers come from recommend_events instead.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', description: 'Strategy code from list_strategies. Omit for all.' },
        state_code: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'integer', description: '1-200, default 50.' },
      },
    },
    run: async ({ strategy, state_code, status, limit }) => {
      const q = ['select=*', 'order=created_at.desc', `limit=${clamp(limit, 1, 200, 50)}`];
      if (strategy) q.push(`strategy=eq.${enc(strategy)}`);
      if (state_code) q.push(`state_code=eq.${enc(String(state_code).toUpperCase())}`);
      if (status) q.push(`status=eq.${enc(status)}`);
      const rows = await rest(`offers?${q.join('&')}`);
      return { count: rows.length, rows };
    },
  },

  list_strategies: {
    description: 'The offer strategies (code, label, offer type, active) that the strategy filter and the offers table key on.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ strategies: await rest('offer_strategies?select=*&order=sort_order.asc') }),
  },

  market_performance: {
    description:
      'Per-market email results from CakeMail history: blasts sent, weighted open and click ' +
      'rates, unsubscribe rate, best template and best day of week, and when the market was ' +
      'last sent to. Use for "how does Ohio perform" or "which markets are cold".',
    inputSchema: {
      type: 'object',
      properties: { market_key: { type: 'string', description: 'One market key as the queue reports it, e.g. los_angeles or houston (not a state code). Omit for all.' } },
    },
    run: async ({ market_key }) => {
      const rows = await rpc('rpc_market_performance');
      const mk = market_key ? String(market_key).toUpperCase() : null;
      const out = mk ? rows.filter(r => String(r.market_key).toUpperCase() === mk) : rows;
      return { count: out.length, rows: out };
    },
  },

  market_history: {
    description:
      'The blast log: what was sent to which market, on which channel, with how many recipients ' +
      'and the copy, newest first. This is the history the cooldown rule reads.',
    inputSchema: {
      type: 'object',
      properties: {
        state_code: { type: 'string' },
        channel: { type: 'string', enum: ['email', 'sms'] },
        days: { type: 'integer', description: 'Only the last N days. Default 90.' },
        limit: { type: 'integer', description: '1-500, default 100.' },
      },
    },
    run: async ({ state_code, channel, days, limit }) => {
      const since = new Date(Date.now() - clamp(days, 1, 3650, 90) * 86400e3).toISOString();
      const q = [
        'select=id,market_key,state_code,channel,template_name,recipient_count,source,blasted_at,segment,message,notes',
        `blasted_at=gte.${enc(since)}`, 'order=blasted_at.desc', `limit=${clamp(limit, 1, 500, 100)}`,
      ];
      if (state_code) q.push(`state_code=eq.${enc(String(state_code).toUpperCase())}`);
      if (channel) q.push(`channel=eq.${enc(channel)}`);
      const rows = await rest(`ticketblaster_market_blasts_log?${q.join('&')}`);
      return { since, count: rows.length, rows: rows.map(r => ({ ...r, message: preview(r.message, 300) })) };
    },
  },

  send_status: {
    description:
      'What left the queue recently and how it went: rows sent or partially sent in the last N ' +
      'days, with recipient counts and any failures, plus anything confirmed and waiting for the ' +
      'hourly tick. Use for "did this morning\'s blasts go out".',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', description: 'Default 7.' } } },
    run: async ({ days }) => {
      const since = Date.now() - clamp(days, 1, 365, 7) * 86400e3;
      const rows = await rpc('get_campaign_queue');
      const pick = r => ({
        id: r.id, title: r.title, status: r.status, market: r.market_key, segment: r.segment,
        channels: { email: !!r.email, sms: !!r.sms },
        audience: { emails: r.segment_email_count ?? r.email_count, phones: r.segment_phone_count ?? r.phone_count },
        scheduled_for: r.scheduled_for, sent_at: r.sent_at, send_failures: r.send_failures,
      });
      const sent = rows.filter(r => r.sent_at && new Date(r.sent_at).getTime() >= since).sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at))).map(pick);
      const waiting = rows.filter(r => r.status === 'confirmed' && !r.sent_at && !r.archived_at).map(pick);
      return { since: new Date(since).toISOString(), sent, waiting_for_tick: waiting };
    },
  },

  list_templates: {
    description: 'Cole\'s message templates by channel and strategy — the bodies the drafter fills [GAME]/[DATE]/[SPORT] into.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', enum: ['email', 'sms'] }, strategy: { type: 'string' } },
    },
    run: async ({ channel, strategy }) => {
      const q = ['select=id,name,slug,channel,play,variant,sender,strategy,subject,body,sort_order', 'is_placeholder=not.is.true', 'order=sort_order.asc'];
      if (channel) q.push(`channel=eq.${enc(channel)}`);
      if (strategy) q.push(`strategy=eq.${enc(strategy)}`);
      const rows = await rest(`message_templates?${q.join('&')}`);
      return { count: rows.length, rows };
    },
  },

  decider_rules: {
    description: 'The rules the decider applies (cooldown days, send windows, allowlist and Cole\'s directives). Read-only here.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const [rules, directives] = await Promise.all([
        rpc('get_decider_rules'),
        rpc('campaign_directive_active').catch(() => null),
      ]);
      return { rules, directives };
    },
  },

  inbox_demo_bookings: {
    description:
      'Demo-booking emails pulled from Cole\'s Gmail (AI-1102): who booked, when, and the subject. ' +
      'Newest first. Set all=true to include the emails the classifier did not flag as bookings.',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean' }, limit: { type: 'integer', description: '1-200, default 50.' } },
    },
    run: async ({ all, limit }) => {
      const q = ['select=id,from_name,from_email,subject,snippet,received_at,is_demo_booking,classifier_reason', 'order=received_at.desc', `limit=${clamp(limit, 1, 200, 50)}`];
      if (!all) q.push('is_demo_booking=is.true');
      const rows = await rest(`inbox_emails?${q.join('&')}`);
      return { count: rows.length, rows };
    },
  },
};

// ── MCP over HTTP ────────────────────────────────────────────────────────────────────────────
//
// Streamable HTTP, the minimal shape: one POST per JSON-RPC message, one JSON response. No SSE
// stream (GET is answered 405, which the spec allows), no session ids, nothing kept between
// calls. Every method a client sends during a normal connect-and-use is here; anything else
// gets the standard "method not found".

function authorized(req) {
  const secret = (process.env.MCP_SECRET || '').trim();
  if (!secret) return false;
  const raw = String(req.headers.authorization || '');
  const bearer = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  if (bearer && bearer === secret) return true;
  const key = req.query && req.query.key;
  return typeof key === 'string' && key === secret;
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

async function handleMessage(msg) {
  const { id, method, params } = msg || {};
  if (!method) return rpcError(id ?? null, -32600, 'invalid request');

  // Notifications carry no id and expect no reply.
  if (id === undefined) return null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions:
          'Read-only view of SendBlaster: the campaign queue, the decider\'s recommendations, ' +
          'offers, market performance and history, templates and demo-booking emails. Nothing here ' +
          'sends or edits — to queue or send a blast, a person does it in the SendBlaster UI.',
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS[name];
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      try {
        const out = await tool.run((params && params.arguments) || {});
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false });
      } catch (e) {
        // A failed read is a tool result the model can act on, not a protocol error.
        return rpcResult(id, { content: [{ type: 'text', text: `error: ${String((e && e.message) || e)}` }], isError: true });
      }
    }
    // Declared-absent capabilities. Answering empty beats "method not found" for clients that
    // probe them anyway.
    case 'resources/list': return rpcResult(id, { resources: [] });
    case 'prompts/list': return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export default async function handler(req, res) {
  // Browsers never call this; CORS is for the odd web-based MCP inspector.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }

  if (req.method === 'GET') { res.status(405).json({ error: 'no event stream; POST JSON-RPC' }); return; }
  if (req.method === 'DELETE') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) { res.status(400).json(rpcError(null, -32700, 'parse error')); return; }

  // A batch is an array; a single message is an object. Both are answered in kind.
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleMessage))).filter(Boolean);

  if (replies.length === 0) { res.status(202).end(); return; }
  res.status(200).json(batch ? replies : replies[0]);
}
