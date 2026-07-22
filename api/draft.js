// Serverless function (Vercel): rewrites the Compose tab's Email/SMS draft to match
// the operator's instruction, using the play + Market & Game + Audience & Channels
// snapshot the UI saved.
//
// The model key lives ONLY here. `ui/` is a static bundle served to the browser, so a
// key in ui/config.js would be public — this endpoint is the reason the key never
// goes near gen-config.js.
//
// Env vars (Vercel > Settings > Environment Variables):
//   ANTHROPIC_API_KEY  (sk-ant-...)  -> Claude    | set either one
//   OPENAI_API_KEY     (sk-proj-...) -> OpenAI    | (Anthropic wins if both are set)
//   DRAFT_MODEL        optional model override
//   REPLY_SECRET       optional shared secret; must match ui/config.js
//
// Prompts are documented in docs/AI_DRAFT_AGENT.md — edit them there and here together.
//
// Raw fetch rather than an SDK: this repo has no package.json and no dependencies
// (api/lookup.js calls Telnyx the same way). Adding one npm dep for one call isn't
// worth changing the deploy shape.

const SYSTEM_PROMPT = `You are the campaign copy agent for Playbook Sports' Marketing Blaster.

You rewrite outreach copy that a human operator is about to send to sports organizations. The operator gives you (a) a saved campaign draft and (b) one instruction describing what makes this run different. You return the rewritten copy.

RULES
1. Rewrite only what the instruction asks for. Preserve the existing voice, structure, and sign-off. This is an edit, not a fresh draft.
2. Never invent facts. Use only what the draft gives you. If the instruction asks for something the draft does not support (a discount, a deadline, a stat), leave it out rather than making it up.
3. Preserve placeholder tokens exactly as written — [NAME], [GAME], [DATE], [SPORT]. They are filled at send time. Never replace a token with a real value, and never introduce a token the original copy did not have.
4. Keep the sender identity consistent with the draft. Do not change who is writing or their title.
5. SMS is a single message with no subject line and no signature block. Keep it under 480 characters. Email keeps its greeting, paragraphs, and sign-off.
6. Do not add links, phone numbers, prices, or calendar URLs unless they already appear in the copy you were given.
7. Compliance: no unsubstantiated urgency ("last chance", "expires tonight") unless the draft states a real deadline. No all-caps shouting. No emoji unless the original copy already used them.
8. Rewrite only the channels marked active in the draft. For an inactive channel, return its original text unchanged.

Return the rewritten copy and nothing else — no commentary, no explanation of what you changed.`;

function userPrompt(draft, instruction) {
  const d = draft || {};
  const line = (label, v) => (v ? `- ${label}: ${v}\n` : '');
  const channels = [d.email ? 'Email' : '', d.sms ? 'SMS' : ''].filter(Boolean).join(' + ') || 'none';

  return `## Campaign draft (saved by the operator)
- Play: ${d.playLabel || 'unspecified'}${d.playDesc ? ` — ${d.playDesc}` : ''}
- Market: ${d.marketName || 'unspecified'}
${line(d.contextLabel || 'Context', d.context)}${line('Sport', d.sport)}${line('Game date', d.gameDate)}${line('Cost per bundle ($)', d.costPerBundle)}${line('Assigned BDA', d.assignedBda)}${line('Last suite', d.lastSuite)}${line('Next suite', d.nextSuite)}${line('Notes', d.notes)}- Channels firing: ${channels}
${line('Email sender', d.emailFrom)}${line('SMS sender', d.smsFrom)}
## Current Email copy
${d.email ? (d.emailBody || '(empty)') : '(email channel is OFF — return this unchanged)'}

## Current SMS copy
${d.sms ? (d.smsBody || '(empty)') : '(SMS channel is OFF — return this unchanged)'}

## Operator instruction
${instruction}

Rewrite the copy for the active channels so it satisfies the instruction, following every rule in your instructions.`;
}

const SCHEMA = {
  type: 'object',
  properties: {
    email: { type: 'string', description: 'The rewritten email body, including greeting and sign-off.' },
    sms: { type: 'string', description: 'The rewritten SMS body. Single message, no subject, no signature block.' },
  },
  required: ['email', 'sms'],
  additionalProperties: false,
};

async function callAnthropic(key, model, sys, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 4096, system: sys,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || `Anthropic HTTP ${r.status}`);
  if (data.stop_reason === 'refusal') throw new Error('The model declined this rewrite request.');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, model: data.model || model };
}

async function callOpenAI(key, model, sys, user) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'blast_copy', strict: true, schema: SCHEMA },
      },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || `OpenAI HTTP ${r.status}`);
  const choice = (data.choices || [])[0] || {};
  if (choice.finish_reason === 'content_filter') throw new Error('The model declined this rewrite request.');
  return { text: (choice.message && choice.message.content) || '', model: data.model || model };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const secret = process.env.REPLY_SECRET;
  if (secret && req.headers['x-inbox-secret'] !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) {
    res.status(500).json({ error: 'No model key on the server — set ANTHROPIC_API_KEY or OPENAI_API_KEY in the Vercel project.' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { draft, instruction } = body;
  if (!draft || typeof draft !== 'object') { res.status(400).json({ error: 'draft is required — save the draft before applying' }); return; }
  if (!instruction || !String(instruction).trim()) { res.status(400).json({ error: 'instruction is required' }); return; }
  if (!draft.email && !draft.sms) { res.status(400).json({ error: 'No channels are on — turn on Email and/or SMS in Audience & Channels.' }); return; }

  const user = userPrompt(draft, String(instruction).trim());

  try {
    const out = anthropicKey
      ? await callAnthropic(anthropicKey, process.env.DRAFT_MODEL || 'claude-opus-4-8', SYSTEM_PROMPT, user)
      : await callOpenAI(openaiKey, process.env.DRAFT_MODEL || 'gpt-4o', SYSTEM_PROMPT, user);

    let parsed;
    try { parsed = JSON.parse(out.text); }
    catch { res.status(502).json({ error: 'Model returned unparseable output.' }); return; }

    // Never let an inactive channel be overwritten, whatever the model returned.
    res.status(200).json({
      email: draft.email ? String(parsed.email ?? '') : draft.emailBody || '',
      sms: draft.sms ? String(parsed.sms ?? '') : draft.smsBody || '',
      model: out.model,
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
