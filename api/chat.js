// Serverless function (Vercel): the Campaign Agent chatbot backend.
// Proxies the conversation to OpenAI so the key stays server-side.
//
// Tier B — answers questions / gives guidance AND can look up ticket prices via the
// get_event_price tool. The agent brain stays OpenAI; price lookups go through the ONE
// shared grounded path (lib/price.js, Gemini flash-lite + search) that the AI-828 job
// uses — cache-first from events_master, a single grounded call only on a miss.
//
// Env: OPENAI_API_KEY (required), OPENAI_MODEL (opt), and for the price tool:
//      SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY.

import { callGeminiPrices } from '../lib/price.js';

export const config = { maxDuration: 30 };

const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();
const PRICE_STALE_HOURS = 72;

const SYSTEM = [
  'You are the Campaign Agent inside Playbook\'s "Marketing Blaster" — a tool for sending ticket and suite marketing blasts to sports organizations, targeted by US-state market. The only real channels are Email (via Gmail) and SMS (via Telnyx).',
  '',
  'How the tool works, so you can guide the user:',
  '- Compose & Send: pick a play (Ticket Blast, Suite Invite, Teammate AI, Event Waitlist), choose a Market (a US state that has contacts), edit the Email/SMS copy in Preview, and pick the Email/SMS senders under Audience & Channels.',
  '- Add to Send Plan stages the campaign into the Queue. Nothing is sent yet.',
  '- Queue: the Confirm button on a row is the ONLY thing that actually sends — SMS-only, email-only, or both, based on the campaign\'s channels.',
  '- Templates tab holds email/SMS templates (including historical blast templates).',
  '- Recipients live in company_intel/contact_intel; the Market dropdown shows how many phones/emails each state has.',
  '',
  'PRICES: you can look up the current lowest resale ("get-in") ticket price for a specific MLB home game with the get_event_price tool. Pass the home team and the game date as YYYY-MM-DD. The tool returns a grounded price from the master events table (refreshed automatically) or a fresh live lookup on a miss. Only MLB is loaded so far. Report the price, the source, and how fresh it is; if none is found, say so plainly — never invent a price.',
  '',
  'Be concise, practical, and friendly. Answer questions and tell the user exactly what to click. You cannot take UI actions yourself yet (composing/sending); if asked, explain the steps. Do not invent data you were not given; if you do not know a specific count or status, say so and point to where in the UI to look.',
].join('\n');

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_event_price',
    description: 'Get the current lowest resale get-in ticket price (USD) for a specific MLB home game. Reads the refreshed master table first, does a live grounded lookup only if missing/stale.',
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Home team name or nickname, e.g. "Cubs" or "Chicago Cubs".' },
        date: { type: 'string', description: 'Game date, YYYY-MM-DD.' },
      },
      required: ['team', 'date'],
      additionalProperties: false,
    },
  },
}];

// --- the price tool: cache-first, one grounded call on a miss, write-back ---
async function getEventPrice({ team, date }) {
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  const gkey = (process.env.GEMINI_API_KEY || '').trim();
  if (!supaUrl || !supaKey) return { error: 'price lookup not configured (no Supabase creds)' };
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { error: 'date must be YYYY-MM-DD' };
  const t = String(team || '').toLowerCase().trim();
  if (!t) return { error: 'team required' };

  // resolve the game: all MLB home games on that date, then match team by nickname/full name
  const evR = await fetch(
    `${supaUrl}/rest/v1/events_master?league=eq.mlb&event_date=eq.${date}` +
    `&select=id,external_id,team,team_full,opponent,event_date,venue,best_price,price_source,priced_at`, { headers: sh });
  const rows = await evR.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return { error: `no MLB home game found on ${date}` };
  const g = rows.find(r =>
    r.team === t || (r.team_full || '').toLowerCase().includes(t) || t.includes(r.team)) || null;
  if (!g) return { error: `no game for "${team}" on ${date}`, games_that_day: rows.map(r => `${r.team} vs ${r.opponent}`) };

  const base = { team: g.team, opponent: g.opponent, date: g.event_date, venue: g.venue };

  // cache hit: priced and fresh
  const freshCut = Date.now() - PRICE_STALE_HOURS * 3600e3;
  if (g.best_price != null && g.priced_at && new Date(g.priced_at).getTime() > freshCut) {
    return { ...base, price_usd: Number(g.best_price), source: g.price_source, as_of: g.priced_at, cached: true };
  }

  // miss / stale: one grounded live lookup, then warm the cache
  if (!gkey) {
    if (g.best_price != null) return { ...base, price_usd: Number(g.best_price), source: g.price_source, as_of: g.priced_at, cached: true, note: 'stale; live refresh unavailable (no Gemini key)' };
    return { ...base, price_usd: null, note: 'not yet priced; live lookup unavailable (no Gemini key)' };
  }
  const r = await callGeminiPrices(gkey, [g]);
  const hit = r.priced?.[0];
  if (!hit) return { ...base, price_usd: g.best_price != null ? Number(g.best_price) : null, source: g.price_source, cached: g.best_price != null, note: 'live lookup found no price' };

  await fetch(`${supaUrl}/rest/v1/rpc/set_event_prices`, {
    method: 'POST', headers: sh, body: JSON.stringify({ p_league: 'mlb', p_rows: [hit] }) }).catch(() => {});
  return { ...base, price_usd: hit.price_usd, source: hit.source, as_of: new Date().toISOString(), cached: false };
}

async function callOpenAI(key, messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages, tools: TOOLS }),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) { res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const messages = (req.body && Array.isArray(req.body.messages)) ? req.body.messages : null;
  if (!messages || !messages.length) { res.status(400).json({ error: 'messages required' }); return; }

  const clean = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    res.status(400).json({ error: 'last message must be from the user' }); return;
  }

  try {
    const convo = [{ role: 'system', content: SYSTEM }, ...clean];

    // tool loop: let the model call get_event_price (bounded rounds)
    for (let round = 0; round < 3; round++) {
      const { ok, status, data } = await callOpenAI(key, convo);
      if (!ok) {
        const e = (data && data.error) || {};
        res.status(502).json({ error: 'OpenAI error: ' + (e.message || `HTTP ${status}`), type: e.type || e.code || null });
        return;
      }
      const msg = data.choices?.[0]?.message;
      if (!msg) { res.status(502).json({ error: 'no message from model' }); return; }

      if (msg.tool_calls?.length) {
        convo.push(msg); // assistant turn that requested the tools
        for (const tc of msg.tool_calls) {
          let result;
          try {
            const args = JSON.parse(tc.function.arguments || '{}');
            result = tc.function.name === 'get_event_price' ? await getEventPrice(args) : { error: `unknown tool ${tc.function.name}` };
          } catch (e) { result = { error: String((e && e.message) || e) }; }
          convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue; // let the model read tool results and respond
      }

      const text = (msg.content || '').trim();
      res.status(200).json({ text: text || '(no reply)' });
      return;
    }
    res.status(200).json({ text: 'Sorry — I got stuck looking that up. Try rephrasing?' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
