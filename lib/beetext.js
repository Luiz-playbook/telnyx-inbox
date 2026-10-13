// The editable words inside a CakeMail design, for every design type.
//
// WHY THIS EXISTS. A `bee` template stores no HTML at all — content.html is null and the design
// lives as a BEE builder blob in content.json. The obvious reading of that is "you cannot edit a
// bee template without converting HTML back into BEE JSON", which is true of the LAYOUT and is
// the reason this looked blocked.
//
// It is not true of the TEXT. Checked against every design in both live accounts on 2026-10-14:
//
//   952135 Ticketblast   1 text node    descriptor.paragraph.html
//   955831 Untitled     19 text nodes   descriptor.text.html
//   957798 hiring        4 text nodes   descriptor.text.html
//   968380 Untitled     19 text nodes   descriptor.text.html
//
// Every word a person would want to change sits in a `descriptor.<kind>.html` string, and
// nothing else in the blob needs to be understood to change one. Read those strings out, edit
// them, put them back at the same positions: rows, columns, images, spacing, colours and the
// builder's own metadata are never touched, so the design still opens and edits normally in
// CakeMail afterwards.
//
// ORDER IS THE CONTRACT. nodes() and apply() walk identically, so the Nth string out is the Nth
// string back in. apply() refuses a list of the wrong length rather than guessing, because a
// mismatch means the caller is working from a different version of the design and writing it
// would scramble the copy across the layout.

// Deep clone without structuredClone, which is fine here: a BEE blob is plain JSON by
// definition — it was parsed from a response body.
const clone = o => JSON.parse(JSON.stringify(o));

// Walk in a fixed order and hand every text-bearing node to `visit`. One traversal, used by both
// readers and writers, so they cannot disagree about what the Nth node is.
//
// TWO KEYS, NOT ONE. `html` is where BEE keeps a text module's words. A BUTTON does not use it:
// its words are in descriptor.button.label, which meant the one line in a design most likely to
// need changing — the call to action — was the one line this could not reach. Checked across
// every live design on 2026-10-14: `label` occurs in exactly one place, under descriptor.button,
// so it is matched on that path rather than on the bare key name, and a `label` that turns up
// somewhere else in a future design is left alone instead of being silently rewritten.
function walk(node, visit, path = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item, i) => walk(item, visit, `${path}[${i}]`)); return; }
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    // Anything else called html (a whole-page export, say) is not a module's copy.
    if (key === 'html' && typeof value === 'string') visit(node, key);
    else if (key === 'label' && typeof value === 'string' && /descriptor\.button$/.test(path)) visit(node, key);
    else walk(value, visit, here);
  }
}

// TEXT IN, MARKUP KEPT, when the original holds exactly one run of words.
//
// A rewritten block used to be replaced wholesale with `<p>new words</p>`, which is fine for a
// bare paragraph and wrong for anything carrying its own styling. A BEE button label is
// `<div class="txtTinyMce-wrapper"><p style="..."><span style="...">Add an action</span></p></div>`
// — flatten that and the button keeps its colour but loses the wrapper the builder expects.
//
// So where there is one run of text, only that run is replaced and every tag around it stays
// exactly as it was. Where there are several (a block of three paragraphs, say), the caller's
// wholesale replacement is still the right answer: one new string cannot be distributed across
// three runs without inventing where the breaks go, and blanking the other two would leave
// empty paragraphs holding space in the design. Returns null when it does not apply, so the
// caller can tell the difference between "done" and "not my case".
const RUNS = /(>)([^<>]*[^\s<>][^<>]*)(<)/g;
export function setInnerText(html, text) {
  const src = String(html || '');
  const matches = [...src.matchAll(RUNS)];
  if (matches.length !== 1) return null;
  const esc = String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const m = matches[0];
  return src.slice(0, m.index) + m[1] + esc + m[3] + src.slice(m.index + m[0].length);
}

// The editable strings, in document order. Empty strings are INCLUDED: a module that is blank
// today is still a slot, and dropping it would shift every index after it.
export function beeTextNodes(json) {
  const out = [];
  if (json) walk(json, (node, key) => out.push(node[key]));
  return out;
}

// `texts` must be the same length and order beeTextNodes() returned. Returns a new blob.
export function applyBeeText(json, texts) {
  const want = beeTextNodes(json).length;
  if (!Array.isArray(texts) || texts.length !== want) {
    throw new Error(`beetext: expected ${want} text node${want === 1 ? '' : 's'}, got ${Array.isArray(texts) ? texts.length : typeof texts}`);
  }
  const copy = clone(json);
  let i = 0;
  walk(copy, (node, key) => { node[key] = String(texts[i++] ?? node[key]); });
  return copy;
}

// A design's words as one readable block, for showing a model what it is editing. Numbered,
// because the model has to hand back the same count in the same order and a bare list of
// paragraphs invites it to merge two.
export function beeTextToPrompt(json) {
  return beeTextNodes(json)
    .map((html, i) => `[${i + 1}] ${String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

// WHAT KIND OF DESIGN THIS IS, and therefore how it gets edited:
//   bee   -> the text nodes above
//   html  -> content.html, edited directly
//   none  -> nothing editable found; the caller must refuse rather than write something odd
export function designShape(content) {
  const c = content || {};
  if (c.json && beeTextNodes(c.json).length) return { kind: 'bee', nodes: beeTextNodes(c.json).length };
  if (typeof c.html === 'string' && c.html.trim()) return { kind: 'html', nodes: 1 };
  return { kind: 'none', nodes: 0 };
}
