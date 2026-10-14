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
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  for (const [key, value] of Object.entries(node)) {
    // `html` directly under a descriptor is where BEE keeps a module's words — paragraph, text,
    // heading, button label. Anything else called html (a whole-page export, say) is not a
    // module's copy and is left alone.
    if (key === 'html' && typeof value === 'string') visit(node, key);
    else walk(value, visit);
  }
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
