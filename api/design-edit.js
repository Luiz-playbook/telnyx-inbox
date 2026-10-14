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
//             Words, colours, sizes and images, the same as the other two: every colour in a
//             rendered email is in an inline style="" attribute, because mail clients strip
//             stylesheets, so the slot discipline works directly on the document. This started
//             out words-only, which showed a Words section and nothing else and read as a
//             half-built feature rather than a deliberate limit.
//   template  saves into the template itself, for every blast using it.
//
// "Make a copy and edit that" is not a third target here. It is the existing duplicate route in
// api/cakemail-templates.js followed by an ordinary template save, composed by the caller — the
// same way the AI editor composes it. Reimplementing the duplicate would mean a second piece of
// code deciding which account the copy lands in and what it is called, and the two would drift.

import { supabaseKey } from '../lib/supabase.js';
import { defangHtml } from '../lib/defang.js';
import { gate } from '../lib/auth.js';
import { cakemailGet, cakemailPatch, cakemailKey, parseCakemailFrom, cakemailAccounts } from '../lib/cakemail.js';
import { beeTextNodes, applyBeeText, designShape, setInnerText } from '../lib/beetext.js';
import { beeColourSlots, applyBeeColours } from '../lib/beestyle.js';
import { beeStyleSlots, applyBeeStyles, fontChoices } from '../lib/beeshape.js';
import { beeImageSlots, applyBeeImages } from '../lib/beeimage.js';
import { bodyPlan } from '../lib/tokens.js';
import { htmlTextSlots, htmlTextNodes, applyHtmlText, htmlColourSlots, applyHtmlColours,
         htmlStyleSlots, applyHtmlStyles, htmlImageSlots, applyHtmlImages,
         walkHtmlTags, bodyRunIndex } from '../lib/htmledit.js';

export const config = { maxDuration: 30 };

const TARGETS = ['send', 'template'];

// WHICH RUN THE BLAST'S OWN COPY WILL OVERWRITE.
//
// A design with no [BODY] has the row's copy dropped into its FIRST NON-EMPTY PARAGRAPH when it
// sends — lib/tokens.js injectBody(), and the row's badge says so. The preview does the same.
//
// That silently defeated the editor. Vhea edited the first block, it saved correctly into
// email_html, and both the preview and the send then replaced it with the row's copy: the field
// looked broken when it was in fact being obeyed and then overruled. Measured on the live row —
// stored run 1 was "vhea here", the preview showed "Hey there,…", and the send would have gone
// out with the latter.
//
// So that one run is not the design's to edit. It is the blast's own words, shown where they
// will actually land, and writing to it writes email_copy. Everything either side of it is
// still the design's.
//
// Same for a [BODY] token: it is a text run too, and rewriting it would break the fill outright.
// Delegates to lib/htmledit.js so the AI editor and this one cannot disagree about which run
// the blast's copy lands on. Both used to work it out separately, which is how one question
// grows two answers.
function bodyRunOf(html) {
  const mode = bodyPlan(html).mode;
  const index = bodyRunIndex(html, mode);
  return index ? { index, mode } : null;
}

// SHOWING SOMEBODY WHICH BLOCK "TEXT 20" IS.
//
// A list of numbered boxes is unusable on a design with thirty of them: the number says nothing
// about where the words are, and scrolling a preview hunting for them is worse than opening the
// builder. So the preview can be asked to come back with one run marked, and the browser is
// pointed at the marker's anchor, which scrolls it into view without any script running inside
// the frame — the frame is sandboxed with scripts off and must stay that way, because what is in
// it is a third party's HTML.
//
// MATCHED BY TEXT, NOT BY INDEX, when the preview is a template render. A bee blob's 20 text
// nodes become 28 runs in the rendered HTML — the render adds structure — so run N and node N
// are not the same thing and lining them up by position would point at the wrong paragraph.
// Matching on the words themselves is right when they are unique and harmless when they are not:
// the worst case is marking the first of two identical lines.
// POINTING AT AN ELEMENT, for the colour, size and image slots. A text run can be wrapped; a
// colour cannot — it belongs to a tag. So the first tag carrying that exact declaration gets an
// id to scroll to and an outline to see, appended to whatever style it already had so nothing
// it was already doing is lost.
function markElement(html, test) {
  let at = null;
  walkHtmlTags(html, (tag, start, end) => {
    if (at) return;
    const name = (/^<\s*([a-z0-9]+)/i.exec(tag) || [, ''])[1].toLowerCase();
    const style = (/\sstyle\s*=\s*"([^"]*)"/i.exec(tag) || [, ''])[1];
    if (test(name, style, tag)) at = { tag, start, end };
  });
  if (!at) return { html, found: false };
  const OUTLINE = 'outline:3px solid #e8590c;outline-offset:2px';
  const withStyle = /\sstyle\s*=\s*"/i.test(at.tag)
    ? at.tag.replace(/(\sstyle\s*=\s*")/i, ' id="pb-here"$1' + OUTLINE + ';')
    : at.tag.replace(/^<\s*([a-z0-9]+)/i, '<$1 id="pb-here" style="' + OUTLINE + '"');
  return { html: html.slice(0, at.start) + withStyle + html.slice(at.end), found: true };
}

const normHex = v => {
  let x = String(v || '').trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(x)) x = '#' + x[1] + x[1] + x[2] + x[2] + x[3] + x[3];
  return x.replace(/\s+/g, '');
};

// One entry point for all four kinds, so the browser only has to say which list and which row.
function markSlot(html, { kind, index, text }) {
  const i = Number(index);
  if (kind === 'colour') {
    const slot = htmlColourSlots(html)[i - 1];
    if (!slot) return { html, found: false };
    const tag = slot.role.split(' ')[0];
    return markElement(html, (name, style) => name === tag && style.split(';').some(d => {
      const c = d.indexOf(':');
      return c > 0 && d.slice(0, c).trim().toLowerCase() === slot.prop && normHex(d.slice(c + 1)) === normHex(slot.value);
    }));
  }
  if (kind === 'style') {
    const slot = htmlStyleSlots(html)[i - 1];
    if (!slot) return { html, found: false };
    return markElement(html, (name, style) => name === slot.role && style.split(';').some(d => {
      const c = d.indexOf(':');
      return c > 0 && d.slice(0, c).trim().toLowerCase() === slot.prop && d.slice(c + 1).trim().toLowerCase() === slot.value.toLowerCase();
    }));
  }
  if (kind === 'image') {
    let n = 0;
    return markElement(html, (name) => name === 'img' && ++n === i);
  }
  return markRun(html, { index: i, text });
}

function markRun(html, { index, text }) {
  const slots = htmlTextSlots(html);
  let hit = -1;
  if (text) {
    const want = flat(text);
    hit = slots.findIndex(s => flat(s.text) === want);
    if (hit < 0) hit = slots.findIndex(s => flat(s.text).includes(want) && want.length > 8);
  }
  if (hit < 0 && Number.isInteger(index) && index >= 1 && index <= slots.length) hit = index - 1;
  if (hit < 0) return { html, found: false };
  const s0 = slots[hit];
  const open = '<a id="pb-here" name="pb-here" style="background:#ffe08a;outline:3px solid #e8590c;outline-offset:2px;border-radius:3px;text-decoration:none;color:inherit">';
  return { html: html.slice(0, s0.start) + open + html.slice(s0.start, s0.end) + '</a>' + html.slice(s0.end), found: true };
}
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

  // ?highlight=<n> — the preview HTML with that run marked, for "show me where this is".
  // Read-only, and defanged exactly like every other preview: see lib/defang.js.
  const highlight = req.method !== 'POST' ? String(req.query?.highlight || '').trim() : '';
  if (highlight) {
    const wantText = String(req.query?.text || '');
    let source = String(row.email_html || '');
    if (target !== 'send' && row.cakemail_template_id) {
      try {
        const { owner: o } = await ownerOf(row.cakemail_template_id, (parseCakemailFrom(row.email_from) || {}).accountId);
        const raw = await cakemailGet(`/templates/${row.cakemail_template_id}/render`, { accountId: o, raw: true });
        source = typeof raw === 'string' ? raw : (raw && (raw.data || raw.html)) || source;
      } catch { /* fall back to the row's own copy, which is the same design */ }
    }
    if (!source.trim()) { res.status(400).json({ error: 'nothing to preview' }); return; }
    const marked = markSlot(source, { kind: String(req.query?.kind || 'text'), index: Number(highlight), text: wantText });
    res.status(200).json({ ok: true, html: defangHtml(marked.html), found: marked.found });
    return;
  }

  // ---------------------------------------------------------------------------------- SEND
  // The finished email, edited in place. No template is involved, so there is nothing to read
  // colours or sizes out of — those belong to the design this was rendered from.
  if (target === 'send') {
    const html0 = String(row.email_html || '');
    if (!html0.trim()) { res.status(400).json({ error: 'This blast has no design on it yet.' }); return; }
    const runs = htmlTextNodes(html0);

    if (req.method !== 'POST') {
      const br = bodyRunOf(html0);
      res.status(200).json({ ok: true, target: 'send', kind: 'rendered', name: row.cakemail_template_name || null, shared: 0,
        body_run: br ? br.index : null, body_mode: br ? br.mode : null,
        text: runs.map((t, i) => ({ index: i + 1,
          // The body slot shows the blast's OWN words, because that is what will be there.
          value: br && br.index === i + 1 ? String(row.email_copy || '') : flat(t),
          is_body: !!(br && br.index === i + 1) })),
        colours: htmlColourSlots(html0).map((c, i) => ({ index: i + 1, ...c })),
        styles: htmlStyleSlots(html0).map((c, i) => ({ index: i + 1, ...c })),
        images: htmlImageSlots(html0).map((c, i) => ({ index: i + 1, ...c })),
        fonts: [],
        note: 'Changes here apply to this blast only. Nothing is saved to Playbook Mail, and this blast stops following the template.' });
      return;
    }

    const changed = { text: [], colours: [], styles: [], images: [] };
    const br = bodyRunOf(html0);
    let html = html0, newCopy = null;
    try {
      if (Array.isArray(body.text)) {
        if (body.text.length !== runs.length) throw new Error(`Expected ${runs.length} text values, got ${body.text.length}.`);
        const next = runs.map((orig, i) => {
          const v = body.text[i] == null ? null : String(body.text[i]);
          // The body slot is the row's copy, not the design's markup. Left out of the HTML edit
          // entirely: writing it there would be overwritten by the fill a moment later.
          if (br && br.index === i + 1) {
            if (v !== null && v.trim() && v !== String(row.email_copy || '')) {
              newCopy = v;
              changed.text.push({ index: i + 1, before: String(row.email_copy || ''), after: v, body: true });
            }
            return null;
          }
          if (v === null || !v.trim() || v === flat(orig)) return null;
          changed.text.push({ index: i + 1, before: flat(orig), after: v });
          return v;
        });
        html = applyHtmlText(html, next);
      }
      if (Array.isArray(body.colours)) {
        const slots = htmlColourSlots(html);
        if (body.colours.length !== slots.length) throw new Error(`Expected ${slots.length} colours, got ${body.colours.length}.`);
        html = applyHtmlColours(html, body.colours);
        slots.forEach((c, i) => {
          const v = body.colours[i] == null ? null : String(body.colours[i]).trim();
          if (v && v.toLowerCase() !== c.value.toLowerCase()) changed.colours.push({ index: i + 1, role: c.role, before: c.value, after: v, count: c.count });
        });
      }
      if (Array.isArray(body.styles)) {
        const slots = htmlStyleSlots(html);
        if (body.styles.length !== slots.length) throw new Error(`Expected ${slots.length} style values, got ${body.styles.length}.`);
        html = applyHtmlStyles(html, body.styles);
        slots.forEach((c, i) => {
          const v = body.styles[i] == null ? null : String(body.styles[i]).trim();
          if (v && v.toLowerCase() !== c.value.toLowerCase()) changed.styles.push({ index: i + 1, role: c.role, prop: c.prop, before: c.value, after: v, count: c.count });
        });
      }
      if (Array.isArray(body.images)) {
        const slots = htmlImageSlots(html);
        if (body.images.length !== slots.length) throw new Error(`Expected ${slots.length} images, got ${body.images.length}.`);
        html = applyHtmlImages(html, body.images);
        slots.forEach((im, i) => {
          const g = body.images[i] || {};
          for (const f of ['alt', 'href']) {
            const v = g[f] == null ? null : String(g[f]).trim();
            if (v !== null && v !== String(im[f] || '').trim()) changed.images.push({ index: i + 1, file: im.file, field: f, before: im[f] || '', after: v });
          }
        });
      }
    } catch (e) {
      res.status(400).json({ error: `${String((e && e.message) || e)} Nothing was changed.` });
      return;
    }

    const total = changed.text.length + changed.colours.length + changed.styles.length + changed.images.length;
    if (!total) { res.status(200).json({ ok: true, target: 'send', changed, total: 0, affected: 1 }); return; }

    // THE SMS IS PASSED THROUGH AS IT IS STORED, NOT AS NULL — queue_set_copy writes both
    // columns, and sending null here would silently erase the row's text message. Same trap the
    // Queue's own Save guards against; see the note in api/design-ai.js.
    if (newCopy !== null) {
      const c = await fetch(`${supaUrl}/rest/v1/rpc/queue_set_copy`, { method: 'POST', headers: h,
        body: JSON.stringify({ p_id: queueId, p_email: newCopy, p_sms: row.sms_copy ?? null }) });
      if (!c.ok) { res.status(502).json({ error: `queue_set_copy failed (HTTP ${c.status}). Nothing was changed.` }); return; }
    }

    const keptName = row.cakemail_template_name || null;
    // Only when the design itself moved. A body-copy-only edit must not detach the row from its
    // template: the words it changed were never the template's.
    const designMoved = html !== html0;
    if (designMoved) {
      const w = await fetch(`${supaUrl}/rest/v1/rpc/queue_set_email_html`, { method: 'POST', headers: h,
        body: JSON.stringify({ p_id: queueId, p_html: html, p_template_id: null, p_template_name: null }) });
      if (!w.ok) { res.status(502).json({ error: `queue_set_email_html failed (HTTP ${w.status}). Nothing was changed.` }); return; }
    }
    res.status(200).json({ ok: true, target: 'send', changed, total, affected: 1,
                           detached: designMoved, detached_from: designMoved ? keptName : null });
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
