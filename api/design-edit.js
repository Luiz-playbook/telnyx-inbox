// Edit a blast's design by hand, in SendBlaster, without going to Playbook Mail.
//
// WHY THIS EXISTS RATHER THAN AN EMBEDDED EDITOR. The obvious answer to "let me edit the design
// here" is to put CakeMail's editor in an iframe, and that is not available to us: app.cakemail
// .com sends `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, so
// the browser refuses to render it on our origin. That is their policy and there is no trick
// around it. Checked on 2026-10-14.
//
// The second answer is Beefree's own SDK — their designs ARE Beefree documents
// ("type":"mailup-bee-page-properties", page.template = template-base/basic/2.0.0), so the real
// builder would load them unchanged. It needs a commercial Beefree account, which is a
// procurement decision rather than a build.
//
// So this is the third answer, and it costs nothing: the design's editable parts are already
// readable and writable, slot by slot, by the four modules the AI editor uses. This hands those
// same slots to a person instead of to a model. Everything the AI can change by being asked,
// somebody can now change by typing it — with the live preview beside it.
//
// WHAT IT CANNOT DO, and says so: adding, removing or reordering blocks, and swapping the
// pictures themselves. Those are structural, and structure is what the real builder is for.
//
// THREE PLACES A SAVE CAN LAND, the same three as the AI editor, for the same reasons:
//
//   send      the design THIS BLAST SENDS. Edits the rendered HTML already on the row
//             (lib/htmledit.js) and drops the template link, so queue-tick cannot overwrite it.
//             Text only: the finished email is the only thing being changed, and colours and
//             sizing live in the design it was rendered from.
//   template  saves into the template itself, for every blast using it.
//
// "Make a copy and edit that" is not a third target here. It is the existing duplicate route in
// api/cakemail-templates.js followed by an ordinary template save, composed by the caller — the
// same way the AI editor composes it. Reimplementing the duplicate would mean a second piece of
// code deciding which account the copy lands in and what it is called, and the two would drift.

import { supabaseKey } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';
import { cakemailGet, cakemailPatch, cakemailKey, parseCakemailFrom, cakemailAccounts } from '../lib/cakemail.js';
import { beeTextNodes, applyBeeText, designShape, setInnerText } from '../lib/beetext.js';
import { beeColourSlots, applyBeeColours } from '../lib/beestyle.js';
import { beeStyleSlots, applyBeeStyles, fontChoices } from '../lib/beeshape.js';
import { beeImageSlots, applyBeeImages } from '../lib/beeimage.js';
import { htmlTextNodes, applyHtmlText } from '../lib/htmledit.js';

export const config = { maxDuration: 30 };

const TARGETS = ['send', 'template'];
const flat = t => String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();

// Plain text to the markup a design expects, for a block that has no single run to write into.
// Escaped first: one unescaped angle bracket inside 30 KB of design is a broken email nobody
// notices until it has gone out.
const toHtml = t => String(t || '')
  .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  .replace(/\n{2,}/g, '</p><p>')
  .replace(/\n/g, '<br>');

// Resolved, not assumed — a design can be borrowed from another account. Same reasoning as the
// note at the top of api/cakemail-templates.js.
async function ownerOf(templateId, firstAccountId) {
  const first = String(firstAccountId || '');
  const candidates = [first, ...cakemailAccounts().map(a => String(a.id)).filter(id => id !== first)]
    .filter(id => id && cakemailKey(id));
  let lastErr = null;
  for (const accountId of candidates) {
    try {
      const j = await cakemailGet(`/templates/${templateId}`, { accountId });
      if (j && j.data) return { owner: accountId, detail: j.data };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not read template ${templateId} from any account we hold a key for. ${String((lastErr && lastErr.message) || '')}`.trim());
}

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  const supaUrl = process.env.SUPABASE_URL;
  const key = supabaseKey();
  if (!supaUrl || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const h = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  const body = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})) : {};
  const queueId = String((req.method === 'POST' ? body.queue_id : req.query?.queue_id) || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(queueId)) { res.status(400).json({ error: 'queue_id must be a row id' }); return; }

  const qr = await fetch(`${supaUrl}/rest/v1/rpc/get_campaign_queue`, { method: 'POST', headers: h, body: '{}' });
  if (!qr.ok) { res.status(502).json({ error: `get_campaign_queue failed (HTTP ${qr.status})` }); return; }
  const row = (await qr.json().catch(() => [])).find(x => String(x.id) === queueId);
  if (!row) { res.status(404).json({ error: 'that blast is not in the queue' }); return; }
  if (row.status === 'sent' || row.status === 'partial') {
    res.status(409).json({ error: 'this blast has already gone out — its design cannot be changed' });
    return;
  }

  const target = TARGETS.includes(body.target || req.query?.target) ? (body.target || req.query.target) : 'send';

  // ---------------------------------------------------------------------------------- SEND
  // The finished email, edited in place. No template is involved, so there is nothing to read
  // colours or sizes out of — those belong to the design this was rendered from.
  if (target === 'send') {
    const html = String(row.email_html || '');
    if (!html.trim()) { res.status(400).json({ error: 'This blast has no design on it yet.' }); return; }
    const runs = htmlTextNodes(html);

    if (req.method !== 'POST') {
      res.status(200).json({ ok: true, target: 'send', name: row.cakemail_template_name || null,
        text: runs.map((t, i) => ({ index: i + 1, value: flat(t) })),
        colours: [], styles: [], images: [], fonts: [], shared: 0,
        note: 'Editing just this blast works on the finished email, so it covers the words. Colours and sizing belong to the design itself — switch to a copy, or to the template, for those.' });
      return;
    }

    const want = Array.isArray(body.text) ? body.text : null;
    if (!want || want.length !== runs.length) {
      res.status(400).json({ error: `Expected ${runs.length} text values, got ${want ? want.length : 'none'}. Nothing was changed.` });
      return;
    }
    const changed = [];
    const next = runs.map((orig, i) => {
      const v = want[i] === null || want[i] === undefined ? null : String(want[i]);
      if (v === null || !v.trim() || v === flat(orig)) return null;
      changed.push({ index: i + 1, before: flat(orig), after: v });
      return v;
    });
    if (!changed.length) { res.status(200).json({ ok: true, target: 'send', changed: [], affected: 1 }); return; }

    const keptName = row.cakemail_template_name || null;
    const w = await fetch(`${supaUrl}/rest/v1/rpc/queue_set_email_html`, { method: 'POST', headers: h,
      body: JSON.stringify({ p_id: queueId, p_html: applyHtmlText(html, next), p_template_id: null, p_template_name: null }) });
    if (!w.ok) { res.status(502).json({ error: `queue_set_email_html failed (HTTP ${w.status}). Nothing was changed.` }); return; }
    res.status(200).json({ ok: true, target: 'send', changed, affected: 1, detached_from: keptName });
    return;
  }

  // ------------------------------------------------------------------------ COPY / TEMPLATE
  let templateId = row.cakemail_template_id;
  if (!templateId) { res.status(400).json({ error: 'No design is attached to this blast, so there is no template to edit.' }); return; }
  const cm = parseCakemailFrom(row.email_from);
  if (!cm) { res.status(400).json({ error: 'this blast does not send through CakeMail' }); return; }

  let { owner, detail } = await ownerOf(templateId, cm.accountId).catch(e => { throw e; });
  const shape = designShape(detail.content);

  // How many other queued blasts a save here would also change. The UI says it before anybody
  // commits, not after.
  const sharedRes = await fetch(`${supaUrl}/rest/v1/campaign_queue?select=id&cakemail_template_id=eq.${encodeURIComponent(templateId)}&id=neq.${encodeURIComponent(queueId)}&status=not.in.(sent,partial)`, { headers: h });
  const shared = sharedRes.ok ? ((await sharedRes.json().catch(() => [])) || []).length : 0;

  // ------------------------------------------------------------------ GET: what is editable
  if (req.method !== 'POST') {
    if (shape.kind === 'bee') {
      const json = detail.content.json;
      res.status(200).json({ ok: true, target, kind: 'bee', name: detail.name, owner, shared,
        text: beeTextNodes(json).map((t, i) => ({ index: i + 1, value: flat(t) })),
        colours: beeColourSlots(json).map((s, i) => ({ index: i + 1, ...s })),
        styles: beeStyleSlots(json).map((s, i) => ({ index: i + 1, ...s })),
        images: beeImageSlots(json).map((s, i) => ({ index: i + 1, ...s })),
        fonts: fontChoices(json) });
      return;
    }
    if (shape.kind === 'html') {
      const runs = htmlTextNodes(detail.content.html);
      res.status(200).json({ ok: true, target, kind: 'html', name: detail.name, owner, shared,
        text: runs.map((t, i) => ({ index: i + 1, value: flat(t) })),
        colours: [], styles: [], images: [], fonts: [],
        note: 'This design is plain HTML rather than a builder document, so its words are editable here and its styling is not.' });
      return;
    }
    res.status(400).json({ error: 'This design has nothing editable in it.' });
    return;
  }

  // ------------------------------------------------------------------ POST: apply and save
  //
  // THE COPY IS MADE FIRST, and only if there is something to save. Duplicating and then finding
  // nothing changed would leave an unexplained template in somebody's library.
  const changed = { text: [], colours: [], styles: [], images: [] };
  let json = shape.kind === 'bee' ? detail.content.json : null;
  let html = shape.kind === 'html' ? String(detail.content.html || '') : null;

  try {
    if (shape.kind === 'bee') {
      const nodes = beeTextNodes(json);
      if (Array.isArray(body.text)) {
        if (body.text.length !== nodes.length) throw new Error(`Expected ${nodes.length} text values, got ${body.text.length}.`);
        const next = nodes.map((orig, i) => {
          const v = body.text[i] === null || body.text[i] === undefined ? null : String(body.text[i]);
          if (v === null || !v.trim() || v === flat(orig)) return orig;
          changed.text.push({ index: i + 1, before: flat(orig), after: v });
          return setInnerText(orig, v) ?? `<p>${toHtml(v)}</p>`;
        });
        json = applyBeeText(json, next);
      }
      if (Array.isArray(body.colours)) {
        const slots = beeColourSlots(json);
        if (body.colours.length !== slots.length) throw new Error(`Expected ${slots.length} colours, got ${body.colours.length}.`);
        json = applyBeeColours(json, body.colours);
        slots.forEach((s, i) => {
          const v = body.colours[i] == null ? null : String(body.colours[i]).trim();
          if (v && v.toLowerCase() !== s.value.toLowerCase()) changed.colours.push({ index: i + 1, role: s.role, before: s.value, after: v, count: s.count });
        });
      }
      if (Array.isArray(body.styles)) {
        const slots = beeStyleSlots(json);
        if (body.styles.length !== slots.length) throw new Error(`Expected ${slots.length} style values, got ${body.styles.length}.`);
        json = applyBeeStyles(json, body.styles);
        slots.forEach((s, i) => {
          const v = body.styles[i] == null ? null : String(body.styles[i]).trim();
          if (v && v.toLowerCase() !== s.value.toLowerCase()) changed.styles.push({ index: i + 1, role: s.role, prop: s.prop, before: s.value, after: v, count: s.count });
        });
      }
      if (Array.isArray(body.images)) {
        const slots = beeImageSlots(json);
        if (body.images.length !== slots.length) throw new Error(`Expected ${slots.length} images, got ${body.images.length}.`);
        json = applyBeeImages(json, body.images);
        slots.forEach((s, i) => {
          const g = body.images[i] || {};
          for (const f of ['alt', 'href']) {
            const v = g[f] == null ? null : String(g[f]).trim();
            if (v !== null && v !== String(s[f] || '').trim()) changed.images.push({ index: i + 1, file: s.file, field: f, before: s[f] || '', after: v });
          }
        });
      }
    } else {
      const runs = htmlTextNodes(html);
      if (Array.isArray(body.text)) {
        if (body.text.length !== runs.length) throw new Error(`Expected ${runs.length} text values, got ${body.text.length}.`);
        const next = runs.map((orig, i) => {
          const v = body.text[i] == null ? null : String(body.text[i]);
          if (v === null || !v.trim() || v === flat(orig)) return null;
          changed.text.push({ index: i + 1, before: flat(orig), after: v });
          return v;
        });
        html = applyHtmlText(html, next);
      }
    }
  } catch (e) {
    res.status(400).json({ error: `${String((e && e.message) || e)} Nothing was changed.` });
    return;
  }

  const total = changed.text.length + changed.colours.length + changed.styles.length + changed.images.length;
  if (!total) { res.status(200).json({ ok: true, target, changed, total: 0, affected: shared + 1, note: 'Nothing was changed.' }); return; }

  // Only `content` is sent. A PATCH carrying the name, tags or description as well would
  // rewrite fields nobody touched, and a template whose description quietly changed because
  // somebody edited a colour is the kind of thing that erodes trust in the whole feature.
  const content = shape.kind === 'bee' ? { ...detail.content, json } : { ...detail.content, html };
  await cakemailPatch(`/templates/${templateId}`, { accountId: owner, body: { content } });

  res.status(200).json({ ok: true, target, changed, total, affected: shared + 1,
                         template_id: templateId, name: detail.name });
}
