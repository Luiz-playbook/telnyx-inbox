// The editable words inside RENDERED email HTML.
//
// WHY THIS EXISTS, when lib/beetext.js already edits a design's words.
//
// beetext edits the BEE blob, and a BEE blob is not HTML — it has to go back to CakeMail and be
// rendered before anybody can see it. That is exactly right for the two edits that change the
// template: overwrite it, or copy it and change the copy. Both of those end with a template in
// Playbook Mail, so a round trip through Playbook Mail is no imposition.
//
// It is wrong for the third one. "Change it for this send only, and do not touch my Playbook
// Mail library" cannot go through CakeMail at all — the moment it does, there is something in
// the library that was not there before. So that edit works on what the row already holds: the
// rendered, token-filled HTML in campaign_queue.email_html, which is the exact thing the tick
// will send. Edit it, store it, done — nothing leaves this system.
//
// WHY A TOKENIZER AND NOT A REGEX. Rendered email HTML is table soup with <style> blocks and
// Outlook conditional comments in it. A naive />([^<]+)</ scan treats CSS as copy: a child
// selector like `.a > .b { }` looks exactly like a text run, and rewriting one corrupts the
// stylesheet of an email that has already been approved. So tags, comments, <style> and
// <script> are walked properly, with quoted attribute values respected, and only genuine text
// between elements is offered.
//
// ORDER IS THE CONTRACT, as in beetext.js: the Nth run out is the Nth run back in, and apply()
// refuses a list of the wrong length rather than guessing.

// Runs that are only whitespace, or only an entity standing in for whitespace, are structural
// spacing in a table layout and not copy anybody wants rewritten.
const BLANK = /^(\s|&nbsp;|&#160;|&#xa0;|&emsp;|&ensp;|&thinsp;|&zwnj;)*$/i;

// Walk the document once and hand every text run to `visit(text, start, end)`. One traversal,
// used by the reader and the writer, so they cannot disagree about what the Nth run is.
function walk(html, visit, onTag) {
  const s = String(html || '');
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { if (visit && i < s.length) visit(s.slice(i), i, s.length); return; }
    if (visit && lt > i) visit(s.slice(i, lt), i, lt);

    // A comment runs to --> and may contain whole elements (Outlook conditionals do).
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    // A raw-text element's contents are CSS or JavaScript, never copy.
    const raw = /^<\s*(style|script|title)\b/i.exec(s.slice(lt, lt + 16));
    if (raw) {
      const close = new RegExp(`</\\s*${raw[1]}\\s*>`, 'i');
      const rest = s.slice(lt + 1);
      const m = close.exec(rest);
      i = m ? lt + 1 + m.index + m[0].length : s.length;
      continue;
    }
    // An ordinary tag: find its end, stepping over > inside quoted attribute values.
    let j = lt + 1, quote = null;
    while (j < s.length) {
      const c = s[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    if (onTag) onTag(s.slice(lt, j + 1), lt, j + 1);
    i = j + 1;
  }
}

// ============================================================================================
// EVERYTHING ELSE A RENDERED EMAIL CARRIES: its colours, its sizes, its images.
//
// WHY THIS IS HERE AND NOT ONLY IN THE BEE MODULES. "Change it for this send only" edits the
// rendered HTML, because nothing may be written to Playbook Mail. Until now that meant words
// only, and the editor showed a Words section and nothing else -- which reads as the feature
// being half-built rather than as a deliberate limit.
//
// It does not have to be. Measured on the live 30 KB render on 2026-10-14: every colour in the
// design appears in an inline style="" attribute, and NONE appears only in a <style> block.
// Email HTML is inline by necessity, because mail clients strip stylesheets. So the same slot
// discipline the BEE modules use works directly on the rendered document.
//
// ROLES ARE COARSER HERE, and honestly so. A BEE blob says "this colour is a button background";
// rendered HTML says "this colour is on a td". So a slot is named by its property and the tag it
// sits on -- "a color", "td background-color" -- which is less precise than the builder's own
// vocabulary and is the true shape of the information available at this stage.

// Every tag in document order, for a caller that needs to point at an element rather than at
// its words — "show me where this colour is" means highlighting a <td>, not a sentence.
export function walkHtmlTags(html, visit) { walk(html, null, visit); }

const STYLE_ATTR = /(\sstyle\s*=\s*")([^"]*)(")/i;
const TAGNAME = /^<\s*([a-z0-9]+)/i;

// Walk every tag's style="" declarations. `visit(tag, prop, value, declIndex)` is called once per
// declaration, in document order, which is the order both the reader and the writer use.
function walkDecls(html, visit) {
  walk(html, null, (tag, start) => {
    const m = STYLE_ATTR.exec(tag);
    if (!m) return;
    const name = (TAGNAME.exec(tag) || [, ''])[1].toLowerCase();
    m[2].split(';').forEach((decl, k) => {
      const c = decl.indexOf(':');
      if (c < 0) return;
      const prop = decl.slice(0, c).trim().toLowerCase();
      const value = decl.slice(c + 1).trim();
      if (prop && value) visit({ tag: name, start }, prop, value, k);
    });
  });
}

// Rewrite declarations in place. `pick(tag, prop, value)` returns a replacement or null.
function rewriteDecls(html, pick) {
  const edits = [];
  walk(html, null, (tag, start, end) => {
    const m = STYLE_ATTR.exec(tag);
    if (!m) return;
    const name = (TAGNAME.exec(tag) || [, ''])[1].toLowerCase();
    let touched = false;
    const next = m[2].split(';').map(decl => {
      const c = decl.indexOf(':');
      if (c < 0) return decl;
      const prop = decl.slice(0, c).trim().toLowerCase();
      const value = decl.slice(c + 1).trim();
      const to = pick({ tag: name }, prop, value);
      if (to === null || to === undefined || to === value) return decl;
      touched = true;
      return decl.slice(0, c + 1) + (decl[c + 1] === ' ' ? ' ' : '') + to;
    }).join(';');
    if (touched) edits.push([start + m.index + m[1].length, start + m.index + m[1].length + m[2].length, next]);
  });
  let out = String(html || '');
  for (let i = edits.length - 1; i >= 0; i--) out = out.slice(0, edits[i][0]) + edits[i][2] + out.slice(edits[i][1]);
  return out;
}

const COLOUR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([^)]*\))$/i;
const normc = v => {
  let x = String(v || '').trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(x)) x = '#' + x[1] + x[1] + x[2] + x[2] + x[3] + x[3];
  return x.replace(/\s+/g, '');
};
const COLOUR_PROPS = new Set(['color', 'background-color', 'background', 'border-color', 'border-top-color', 'border-bottom-color']);

// One slot per distinct (tag, property, colour), in first-appearance order -- the same collapsing
// lib/beestyle.js does, for the same reason: one decision, not two hundred.
export function htmlColourSlots(html) {
  const slots = [], seen = new Map();
  walkDecls(html, (t, prop, value) => {
    if (!COLOUR_PROPS.has(prop) || !COLOUR_RE.test(value)) return;
    const k = `${t.tag}|${prop}|${normc(value)}`;
    if (seen.has(k)) { slots[seen.get(k)].count++; return; }
    seen.set(k, slots.length);
    slots.push({ role: `${t.tag} ${prop}`, prop, value: value.trim(), count: 1 });
  });
  return slots;
}

export function applyHtmlColours(html, values) {
  const slots = htmlColourSlots(html);
  if (!Array.isArray(values) || values.length !== slots.length) {
    throw new Error(`htmledit: expected ${slots.length} colour${slots.length === 1 ? '' : 's'}, got ${Array.isArray(values) ? values.length : typeof values}`);
  }
  const want = new Map();
  values.forEach((v, i) => {
    if (v === null || v === undefined || String(v).trim() === '') return;
    const x = String(v).trim();
    if (normc(x) === normc(slots[i].value)) return;
    if (!COLOUR_RE.test(x)) throw new Error(`htmledit: slot ${i + 1} (${slots[i].role}) is not a colour: ${JSON.stringify(x).slice(0, 40)}`);
    want.set(`${slots[i].role}|${normc(slots[i].value)}`, x);
  });
  if (!want.size) return html;
  return rewriteDecls(html, (t, prop, value) => {
    if (!COLOUR_PROPS.has(prop)) return null;
    return want.get(`${t.tag} ${prop}|${normc(value)}`) ?? null;
  });
}

const SIZE_PROPS = {
  'font-size':      v => /^(0|-?\d+(\.\d+)?(px|%|em|rem|pt))$/i.test(v),
  'line-height':    v => /^(normal|\d+(\.\d+)?(px|%|em)?)$/i.test(v),
  'letter-spacing': v => /^(normal|0|-?\d+(\.\d+)?(px|em))$/i.test(v),
  'font-weight':    v => /^([1-9]00|normal|bold|bolder|lighter)$/i.test(v),
  'text-align':     v => /^(left|center|right|justify)$/i.test(v),
  'border-radius':  v => /^(0|\d+(\.\d+)?(px|%))$/i.test(v),
  'padding-top':    v => /^(0|\d+(\.\d+)?(px|%))$/i.test(v),
  'padding-bottom': v => /^(0|\d+(\.\d+)?(px|%))$/i.test(v),
  'padding-left':   v => /^(0|\d+(\.\d+)?(px|%))$/i.test(v),
  'padding-right':  v => /^(0|\d+(\.\d+)?(px|%))$/i.test(v),
};

export function htmlStyleSlots(html) {
  const slots = [], seen = new Map();
  walkDecls(html, (t, prop, value) => {
    if (!SIZE_PROPS[prop] || value === 'undefined') return;
    const k = `${t.tag}|${prop}|${value.toLowerCase()}`;
    if (seen.has(k)) { slots[seen.get(k)].count++; return; }
    seen.set(k, slots.length);
    slots.push({ role: t.tag, prop, value: value.trim(), count: 1 });
  });
  return slots;
}

export function applyHtmlStyles(html, values) {
  const slots = htmlStyleSlots(html);
  if (!Array.isArray(values) || values.length !== slots.length) {
    throw new Error(`htmledit: expected ${slots.length} style value${slots.length === 1 ? '' : 's'}, got ${Array.isArray(values) ? values.length : typeof values}`);
  }
  const want = new Map();
  values.forEach((v, i) => {
    if (v === null || v === undefined || String(v).trim() === '') return;
    const x = String(v).trim();
    if (x.toLowerCase() === slots[i].value.toLowerCase()) return;
    if (!SIZE_PROPS[slots[i].prop](x)) throw new Error(`htmledit: ${slots[i].role} ${slots[i].prop} will not take ${JSON.stringify(x).slice(0, 40)}`);
    want.set(`${slots[i].role}|${slots[i].prop}|${slots[i].value.toLowerCase()}`, x);
  });
  if (!want.size) return html;
  return rewriteDecls(html, (t, prop, value) => want.get(`${t.tag}|${prop}|${value.toLowerCase()}`) ?? null);
}

// IMAGES. alt is on the <img>; the link is on the <a> that wraps it, which in table-based email
// is always the tag immediately before. Both are read and written as whole attributes rather
// than through a style declaration, so they get their own small pass.
const ATTR = (name) => new RegExp(`(\\s${name}\\s*=\\s*")([^"]*)(")`, 'i');

export function htmlImageSlots(html) {
  const out = [];
  let pendingHref = null;
  walk(html, null, (tag) => {
    const name = (TAGNAME.exec(tag) || [, ''])[1].toLowerCase();
    if (name === 'a') { const m = ATTR('href').exec(tag); pendingHref = m ? m[2] : ''; return; }
    if (name !== 'img') return;
    const src = (ATTR('src').exec(tag) || [, , ''])[2];
    let file = '';
    try { file = decodeURIComponent(String(src).split('?')[0].split('/').pop() || ''); } catch { file = String(src).split('/').pop() || ''; }
    out.push({ file, alt: (ATTR('alt').exec(tag) || [, , ''])[2], href: pendingHref || '' });
    pendingHref = null;
  });
  return out;
}

const HREF_OK = /^$|^(https?:\/\/|mailto:|tel:)/i;

export function applyHtmlImages(html, items) {
  const slots = htmlImageSlots(html);
  if (!Array.isArray(items) || items.length !== slots.length) {
    throw new Error(`htmledit: expected ${slots.length} image${slots.length === 1 ? '' : 's'}, got ${Array.isArray(items) ? items.length : typeof items}`);
  }
  items.forEach((it, i) => {
    if (!it) return;
    if (it.href !== null && it.href !== undefined && !HREF_OK.test(String(it.href).trim())) {
      throw new Error(`htmledit: image ${i + 1} link must start http:// or https://, or be empty`);
    }
  });
  // Written back last-first so earlier offsets stay valid, exactly as applyHtmlText does.
  const edits = [];
  let n = 0, lastA = null;
  walk(html, null, (tag, start, end) => {
    const name = (TAGNAME.exec(tag) || [, ''])[1].toLowerCase();
    if (name === 'a') { lastA = { tag, start, end }; return; }
    if (name !== 'img') return;
    const want = items[n] || {};
    const slot = slots[n];
    n++;
    if (want.alt !== null && want.alt !== undefined && String(want.alt) !== slot.alt) {
      const m = ATTR('alt').exec(tag);
      const v = String(want.alt).replace(/"/g, '&quot;');
      edits.push(m
        ? [start + m.index + m[1].length, start + m.index + m[1].length + m[2].length, v]
        : [start + tag.length - (tag.endsWith('/>') ? 2 : 1), start + tag.length - (tag.endsWith('/>') ? 2 : 1), ` alt="${v}"`]);
    }
    if (want.href !== null && want.href !== undefined && String(want.href).trim() !== slot.href) {
      const to = String(want.href).trim().replace(/"/g, '&quot;');
      const m = lastA ? ATTR('href').exec(lastA.tag) : null;
      if (m) {
        edits.push([lastA.start + m.index + m[1].length, lastA.start + m.index + m[1].length + m[2].length, to]);
      } else if (to) {
        // NO ANCHOR TO EDIT, SO ONE IS ADDED. Half this design's images are links and half are
        // not, and "you may change this image's link, but only if somebody already gave it one"
        // is not a rule anyone can hold in their head -- especially when the same edit against
        // the TEMPLATE works either way, because descriptor.image.href is just a field. The
        // <img> is wrapped where it stands, which is what a builder does too; it adds no row
        // and moves nothing.
        edits.push([start, start, `<a href="${to}" target="_blank">`]);
        edits.push([end, end, '</a>']);
      }
    }
    lastA = null;
  });
  edits.sort((a, b) => a[0] - b[0]);
  let out = String(html || '');
  for (let i = edits.length - 1; i >= 0; i--) out = out.slice(0, edits[i][0]) + edits[i][2] + out.slice(edits[i][1]);
  return out;
}

// The editable runs, in document order. Blank runs are skipped entirely rather than carried as
// empty slots: unlike a BEE module, a whitespace run in table markup is not a place anybody
// would ever want words, and offering several hundred of them would bury the real copy.
export function htmlTextSlots(html) {
  const out = [];
  walk(html, (text, start, end) => { if (!BLANK.test(text)) out.push({ text, start, end }); });
  return out;
}

// Just the strings, for a caller that only wants to read.
export const htmlTextNodes = html => htmlTextSlots(html).map(s => s.text);

// `texts` must be the same length and order htmlTextSlots() returned. An entry that is null,
// empty, or unchanged leaves that run exactly as it was, markup and entities intact.
//
// Written back LAST RUN FIRST so that every offset still refers to the string it was measured
// against; replacing left to right would shift every later run by the length difference.
export function applyHtmlText(html, texts) {
  const slots = htmlTextSlots(html);
  if (!Array.isArray(texts) || texts.length !== slots.length) {
    throw new Error(`htmledit: expected ${slots.length} text run${slots.length === 1 ? '' : 's'}, got ${Array.isArray(texts) ? texts.length : typeof texts}`);
  }
  let out = String(html || '');
  for (let i = slots.length - 1; i >= 0; i--) {
    const want = texts[i];
    if (want === null || want === undefined) continue;
    const s = String(want);
    if (!s.trim() || s === slots[i].text) continue;
    // Escaped, because a model will produce an ampersand or an angle bracket sooner or later
    // and one of those raw inside 30 KB of email is a broken layout nobody notices until it
    // has gone out. The run's own leading and trailing whitespace is preserved: it is doing
    // spacing work between inline elements.
    const lead = /^\s*/.exec(slots[i].text)[0];
    const tail = /\s*$/.exec(slots[i].text)[0];
    const esc = s.trim().replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    out = out.slice(0, slots[i].start) + lead + esc + tail + out.slice(slots[i].end);
  }
  return out;
}

// WHICH RUN THE BLAST'S OWN COPY WILL LAND ON, given the plan lib/tokens.js worked out.
//
// A design with no [BODY] has the row's copy dropped into its first non-empty paragraph at send
// time, so that run is not the design's to edit: writing it is obeyed and then overruled a
// moment later. Both editors need to know which one it is, and they were each about to work it
// out for themselves — which is how two answers to one question start disagreeing.
//
// `mode` comes from bodyPlan(): 'token', 'first-paragraph', or anything else for neither.
export function bodyRunIndex(html, mode) {
  const slots = htmlTextSlots(html);
  if (mode === 'token') {
    const i = slots.findIndex(s => s.text.includes('[BODY]'));
    return i < 0 ? null : i + 1;
  }
  if (mode !== 'first-paragraph') return null;
  const strip = x => String(x).replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
  const re = /(<p\b[^>]*>)([\s\S]*?)(<\/p>)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (strip(m[2]) === '') continue;
    const start = m.index, end = m.index + m[0].length;
    const i = slots.findIndex(x => x.start >= start && x.end <= end);
    return i < 0 ? null : i + 1;
  }
  return null;
}

// Colours, sizes and images as a model sees them, in the same numbered shape the bee modules
// use. Kept here so the AI editor and the hand editor describe one design the same way.
export const htmlColoursToPrompt = html => htmlColourSlots(html)
  .map((c, i) => `[${i + 1}] ${c.value}  — ${c.role}${c.count > 1 ? ` (${c.count} places)` : ''}`).join('\n');

export const htmlStylesToPrompt = html => htmlStyleSlots(html)
  .map((c, i) => `[${i + 1}] ${c.role} ${c.prop} = ${c.value}${c.count > 1 ? ` (${c.count} places)` : ''}`).join('\n');

export const htmlImagesToPrompt = html => htmlImageSlots(html)
  .map((s, i) => `[${i + 1}] ${s.file}\n      alt  = ${JSON.stringify(s.alt)}\n      link = ${s.href || '(none)'}`).join('\n');

// The copy as one readable block, numbered, for showing a model what it is editing. Entities
// are softened to the characters they stand for so the model reads sentences rather than
// markup, and writes sentences back.
export function htmlTextToPrompt(html) {
  return htmlTextNodes(html)
    .map((t, i) => `[${i + 1}] ${t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}
