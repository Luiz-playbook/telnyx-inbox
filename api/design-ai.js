// Edit a blast's words with AI, without leaving the Queue.
//
// TWO TARGETS, and the difference between them is who else is affected. Josh asked for exactly
// this split on the 2026-10-13 review ("are you updating the template or are you AI updating the
// draft before it goes out"), and settled on the draft being the default:
//
//   draft     — rewrites THIS BLAST'S OWN COPY (campaign_queue.email_copy). Nothing is written to
//               CakeMail, no other blast changes, and Undo in the Queue puts it back. The design
//               then wraps the new words at send time exactly as it wrapped the old ones, so this
//               works whatever kind of design is attached, or none at all.
//
//   template  — rewrites the TEMPLATE in CakeMail, which changes every blast using it. Opt-in,
//               and the row already says "shared with N other blasts" before anyone gets here.
//
// EDITING A TEMPLATE WORKS FOR EVERY DESIGN TYPE, which is the thing that looked blocked. A bee
// template keeps its words in descriptor.<kind>.html nodes inside content.json and its HTML is
// null; an html template keeps them in content.html. Neither needs converting into the other —
// see lib/beetext.js. The layout, images and styling are never sent to the model and never
// rewritten, so the design still opens and edits normally in CakeMail afterwards.
//
// THE MODEL NEVER WRITES MARKUP. It is given numbered plain text and must return the same count
// in the same order; everything else about the design is reassembled here. A model that returns
// the wrong number of items is refused rather than fitted, because a mismatch means the copy
// would land against the wrong parts of the layout.

import { supabaseKey } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';
import { openaiTarget, DEFAULT_MODEL } from '../lib/llm.js';
import { cakemailGet, cakemailPatch, cakemailKey, cakemailKeyEnvName, parseCakemailFrom, cakemailAccounts } from '../lib/cakemail.js';
import { beeTextNodes, applyBeeText, designShape } from '../lib/beetext.js';
import { gameLabel, prettyDate } from '../lib/tokens.js';

export const config = { maxDuration: 60 };

const MODEL = (process.env.DESIGN_AI_MODEL || DEFAULT_MODEL).trim();

// Tags are stripped before the model sees anything and never asked for back. The model writes
// words; this file decides where words go.
const toText = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

// WHAT THE MODEL ACTUALLY SENDS BACK, which is not always a string.
//
// Asked for {"blocks": ["...", "..."]}, gpt-4o returned nineteen OBJECTS — shaped like
// {id, text} — and String(object) is "[object Object]". That went into the template and
// overwrote all nineteen blocks with it before anything noticed, because every one of them
// differed from the original and so counted as a change. Verified and reverted 2026-10-14.
//
// So nothing is stringified blindly. A string is taken as-is; an object is searched for the
// field it plainly meant; anything else yields null and the caller REFUSES THE WHOLE EDIT
// rather than writing part of it. A half-applied rewrite is worse than a rejected one: the
// design is shared, and the damage is only visible by reading it.
const asBlockText = (v) => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['text', 'content', 'block', 'html', 'value', 'copy']) {
      if (typeof v[k] === 'string') return v[k];
    }
  }
  return null;
};

// Plain text to the markup a design expects. Escaped first: a model can and will produce an
// ampersand or an angle bracket, and one of those unescaped inside a 30 KB design is a broken
// email nobody notices until it has gone out.
const toHtml = t => String(t || '')
  .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  .replace(/\n{2,}/g, '</p><p>')
  .replace(/\n/g, '<br>');

// RETRIED ONCE, AND THE ERROR SAYS WHAT BROKE. A single socket failure on the way to the model
// surfaced in the UI as the bare word "fetch failed" — undici's wording, with no hint whether it
// was the model, Supabase or CakeMail that could not be reached, and no second attempt. One
// retry costs a second and clears the common case; naming the step costs nothing and is the
// difference between a report and a guess.
async function ask(messages) {
  const target = openaiTarget(MODEL);
  if (!target.ok) throw new Error('No LLM configured — set OPENROUTER_OPENAI or OPENAI_API_KEY');
  const body = JSON.stringify({
    model: target.model, messages, temperature: 0.4,
    response_format: { type: 'json_object' }, ...target.body,
  });
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(target.url, { method: 'POST', headers: target.headers, body });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`${target.label} HTTP ${r.status}: ${(j && j.error && j.error.message) || ''}`.trim());
      const text = j?.choices?.[0]?.message?.content;
      if (!text) throw new Error(`${target.label} returned no content`);
      try { return JSON.parse(text); } catch { throw new Error(`${target.label} did not return usable JSON`); }
    } catch (e) {
      lastErr = e;
      // Only a transport failure is worth repeating. An HTTP error or unusable JSON is an
      // answer, and asking the same question again will get the same answer.
      const transport = /fetch failed|ECONNRESET|ETIMEDOUT|socket|network|aborted/i.test(String(e && e.message));
      if (!transport || attempt === 2) break;
      await new Promise(r => setTimeout(r, 600));
    }
  }
  const msg = String((lastErr && lastErr.message) || lastErr);
  throw new Error(/fetch failed/i.test(msg)
    ? `Could not reach ${target.label} (${target.model}) — tried twice. The design was not changed.`
    : msg);
}

// Everything else that leaves this process says which call it was, for the same reason.
const step = (what, promise) => promise.catch(e => {
  const m = String((e && e.message) || e);
  throw new Error(/fetch failed/i.test(m) ? `Could not reach ${what}. The design was not changed.` : m);
});

// What the blast is about, so an edit can mention the fixture without being told it.
const context = r => [
  r.title ? `Blast: ${r.title}` : '',
  gameLabel(r) ? `Game: ${gameLabel(r)}` : '',
  prettyDate(r.event_date) ? `Date: ${prettyDate(r.event_date)}` : '',
  r.sport ? `Sport: ${r.sport}` : '',
  r.state_name ? `Market: ${r.state_name}` : '',
  r.segment ? `Audience: ${r.segment}` : '',
  r.ticket_price != null ? `Cheapest ticket: $${r.ticket_price}` : '',
].filter(Boolean).join('\n');

// WHY NOTHING CHANGED, when the instruction was never about words in the first place.
//
// This edits text and only text. A BEE design keeps its colours in nine style paths --
// descriptor.text.style.color, descriptor.button.style.background-color, the row and page
// background-colors and so on -- none of which lib/beetext.js reads or writes, by design: the
// text nodes are the part that can be round-tripped without understanding the builder.
//
// So "make the colours blue" comes back with all nineteen blocks unchanged and nothing is
// written, which is correct and reads as broken. "The model made no changes" is true and
// useless here; it is the one instruction people try first on a design they are looking at.
const VISUAL = /\b(colou?rs?|background|backdrop|font|typeface|image|images|photo|picture|logo|layout|spacing|padding|margin|border|theme|styling|bolder|bigger|smaller|wider|align|alignment)\b/i;
const noChangeNote = (instruction) => VISUAL.test(String(instruction || ''))
  ? 'Nothing changed, because this edits the WORDS in a design. Colours, images, fonts and layout belong to the design itself \u2014 open it in Playbook Mail to change those. Whatever you change there is what the blast sends.'
  : 'The model made no changes.';

const RULES = [
  'You are editing outreach email copy for Playbook Sports, a sports-organisation software company.',
  'Keep the sender\'s voice: direct, warm, concise, no marketing cliché and no exclamation marks.',
  'Never invent a fact — no prices, dates, fixtures, names or guarantees that are not given to you.',
  'Leave any [TOKEN] in square brackets exactly as it is; those are filled in later and a changed one breaks the send.',
  'Write plain text only. No HTML tags, no markdown.',
];

export default async function handler(req, res) {
  if (!await gate(req, res)) return;
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST' }); return; }

  const supaUrl = process.env.SUPABASE_URL;
  const key = supabaseKey();
  if (!supaUrl || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const queueId = String(body.queue_id || '').trim();
  const instruction = String(body.instruction || '').trim();
  const target = body.target === 'template' ? 'template' : 'draft';
  if (!/^[0-9a-f-]{36}$/i.test(queueId)) { res.status(400).json({ error: 'queue_id must be a row id' }); return; }
  if (!instruction) { res.status(400).json({ error: 'Say what you would like changed' }); return; }

  // Through the RPC, not the table: the prompt uses event_date, sport and the fixture, and those
  // are joined in from events_master rather than stored on campaign_queue.
  const qr = await fetch(`${supaUrl}/rest/v1/rpc/get_campaign_queue`, { method: 'POST', headers: h, body: '{}' });
  if (!qr.ok) { res.status(502).json({ error: `get_campaign_queue failed (HTTP ${qr.status})` }); return; }
  const row = (await qr.json().catch(() => [])).find(x => String(x.id) === queueId);
  if (!row) { res.status(404).json({ error: 'that blast is not in the queue' }); return; }
  if (row.status === 'sent' || row.status === 'partial') {
    res.status(409).json({ error: 'this blast has already gone out — its copy cannot be changed' });
    return;
  }

  try {
    // ---------------------------------------------------------------------------------------
    // DRAFT — this blast's own words. No CakeMail write at all.
    // ---------------------------------------------------------------------------------------
    if (target === 'draft') {
      const before = String(row.email_copy || '');
      if (!before.trim()) { res.status(400).json({ error: 'This blast has no copy to edit yet. Draft it first, or use a template.' }); return; }
      const out = await ask([
        { role: 'system', content: RULES.concat(
            'Return JSON: {"copy": "<the full rewritten email body>"}.',
            'Rewrite the whole body, not a fragment. Keep the sign-off unless asked to change it.',
          ).join('\n') },
        { role: 'user', content: `${context(row)}\n\nCurrent copy:\n"""\n${before}\n"""\n\nWhat to change: ${instruction}` },
      ]);
      const after = String(out.copy || '').trim();
      if (!after) { res.status(502).json({ error: 'The model returned an empty body' }); return; }

      // THE SMS IS PASSED THROUGH AS IT IS STORED, NOT AS NULL. queue_set_copy writes BOTH
      // columns, so sending null here would silently erase the row's text message — the same
      // trap the Queue's own Save guards against by sending the other channel unchanged
      // (ui/index.html: "passing the live editor value would let Save email quietly commit an
      // SMS edit"). This endpoint edits the email and must leave the SMS exactly as it found it.
      const w = await fetch(`${supaUrl}/rest/v1/rpc/queue_set_copy`, { method: 'POST', headers: h,
        body: JSON.stringify({ p_id: queueId, p_email: after, p_sms: row.sms_copy ?? null }) });
      if (!w.ok) { res.status(502).json({ error: `queue_set_copy failed (HTTP ${w.status})` }); return; }

      res.status(200).json({ ok: true, target: 'draft', before, after, affected: 1 });
      return;
    }

    // ---------------------------------------------------------------------------------------
    // TEMPLATE — changes every blast using it. Works for bee and html alike.
    // ---------------------------------------------------------------------------------------
    const templateId = row.cakemail_template_id;
    if (!templateId) { res.status(400).json({ error: 'No design is attached to this blast, so there is no template to edit.' }); return; }
    const cm = parseCakemailFrom(row.email_from);
    if (!cm) { res.status(400).json({ error: 'this blast does not send through CakeMail' }); return; }

    // The owner is resolved, not assumed — a design can be borrowed from another account.
    let detail = null, owner = null;
    for (const candidate of [cm.accountId, ...cakemailAccounts().map(a => a.id).filter(id => id !== cm.accountId)]) {
      if (!cakemailKey(candidate)) continue;
      try { const j = await cakemailGet(`/templates/${templateId}`, { accountId: candidate }); if (j && j.data) { detail = j.data; owner = candidate; break; } } catch { /* next */ }
    }
    if (!detail) { res.status(502).json({ error: `Could not read template ${templateId} from any account we hold a key for.` }); return; }

    const shape = designShape(detail.content);
    if (shape.kind === 'none') { res.status(400).json({ error: 'This design has no editable text — nothing for the model to change.' }); return; }

    // How many other queued blasts this edit will also change. Reported back so the UI can say
    // it plainly after the fact as well as before.
    const sharedRes = await fetch(`${supaUrl}/rest/v1/campaign_queue?select=id&cakemail_template_id=eq.${encodeURIComponent(templateId)}&id=neq.${encodeURIComponent(queueId)}&status=not.in.(sent,partial)`, { headers: h });
    const shared = sharedRes.ok ? ((await sharedRes.json().catch(() => [])) || []).length : 0;

    if (shape.kind === 'bee') {
      const nodes = beeTextNodes(detail.content.json);
      const numbered = nodes.map((html, i) => `[${i + 1}] ${toText(html)}`).join('\n');
      const out = await ask([
        { role: 'system', content: RULES.concat(
            `This design has ${nodes.length} text block${nodes.length === 1 ? '' : 's'}, numbered below.`,
            `Return JSON: {"blocks": ["<new text for 1>", "<new text for 2>", ...]} with EXACTLY ${nodes.length} item${nodes.length === 1 ? '' : 's'}, in the same order.`,
            'Each item must be a PLAIN STRING, not an object. Return a block unchanged if the instruction does not concern it. Never merge, split, add or drop blocks.',
          ).join('\n') },
        { role: 'user', content: `${context(row)}\n\nBlocks:\n${numbered}\n\nWhat to change: ${instruction}` },
      ]);
      const blocks = out.blocks;
      if (!Array.isArray(blocks) || blocks.length !== nodes.length) {
        res.status(502).json({ error: `The model returned ${Array.isArray(blocks) ? blocks.length : 'no'} blocks for a design with ${nodes.length}. Nothing was changed.` });
        return;
      }
      // Only blocks whose TEXT actually changed are rewritten. An untouched block keeps its
      // original markup — links, bold, inline styles and all — instead of being flattened by a
      // round trip through plain text it did not need.
      // Every item is resolved to text BEFORE anything is written. One unreadable item fails the
      // whole edit, because the alternative is a design half in the model's words and half in
      // "[object Object]".
      const wants = blocks.map(asBlockText);
      const badAt = wants.findIndex(w => w === null);
      if (badAt >= 0) {
        res.status(502).json({ error: `The model returned block ${badAt + 1} in a form this cannot read (${typeof blocks[badAt]}). Nothing was changed.` });
        return;
      }
      const changed = [];
      const next = nodes.map((orig, i) => {
        const want = String(wants[i]).trim();
        if (!want || want === toText(orig)) return orig;
        changed.push({ index: i + 1, before: toText(orig), after: want });
        return `<p>${toHtml(want)}</p>`;
      });
      if (!changed.length) { res.status(200).json({ ok: true, target: 'template', kind: 'bee', changed: [], affected: shared + 1, note: noChangeNote(instruction) }); return; }

      await step('Playbook Mail to save the design', cakemailPatch(`/templates/${templateId}`, { accountId: owner,
        body: { content: { ...detail.content, json: applyBeeText(detail.content.json, next) } } }));
      res.status(200).json({ ok: true, target: 'template', kind: 'bee', name: detail.name, changed, affected: shared + 1 });
      return;
    }

    // html / custom: one body, edited whole.
    const before = String(detail.content.html || '');
    const out = await ask([
      { role: 'system', content: RULES.concat(
          'Return JSON: {"copy": "<the full rewritten body text>"}.',
        ).join('\n') },
      { role: 'user', content: `${context(row)}\n\nCurrent copy:\n"""\n${toText(before)}\n"""\n\nWhat to change: ${instruction}` },
    ]);
    const after = String(asBlockText(out.copy) || '').trim();
    if (!after) { res.status(502).json({ error: 'The model did not return a usable body' }); return; }
    await step('Playbook Mail to save the design', cakemailPatch(`/templates/${templateId}`, { accountId: owner,
      body: { content: { ...detail.content, html: `<p>${toHtml(after)}</p>` } } }));
    res.status(200).json({ ok: true, target: 'template', kind: 'html', name: detail.name,
      changed: [{ index: 1, before: toText(before), after }], affected: shared + 1 });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
