// Serverless function (Vercel): the Campaign Agent chatbot backend.
// Proxies the conversation to OpenAI so the key stays server-side.
// Tier A — answers questions / gives guidance; it does not take UI actions yet.
//
// Env vars (Vercel > Settings > Environment Variables):
//   OPENAI_API_KEY  – required (an sk-... / sk-proj-... key from platform.openai.com)
//   OPENAI_MODEL    – optional, defaults to gpt-4o

export const config = { maxDuration: 30 };

const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();

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
  'Be concise, practical, and friendly. Answer questions and tell the user exactly what to click. You cannot take actions in the UI yourself yet — if asked to do something, explain the steps. Do not invent data you were not given; if you do not know a specific count or status, say so and point to where in the UI to look.',
].join('\n');

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
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: 'system', content: SYSTEM }, ...clean],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const e = (data && data.error) || {};
      res.status(502).json({ error: 'OpenAI error: ' + (e.message || `HTTP ${r.status}`), type: e.type || e.code || null });
      return;
    }
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    res.status(200).json({ text: text || '(no reply)' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
