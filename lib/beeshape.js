// The shape and typography of a CakeMail design: sizes, spacing, roundness, alignment.
//
// WHY THIS EXISTS. lib/beetext.js edits the words and lib/beestyle.js the colours. What is left
// of "change the design" is how it is SET: text too small, buttons too square, bands too tight,
// everything hard against the left edge. Those live in the same style objects as the colours
// and are the same shape of problem, so this is the same shape of answer — slots, collapsed by
// role and value, index-matched, validated before anything is written.
//
// WHAT IS DELIBERATELY NOT HERE, and why each one is left out:
//
//   computedStyle.*   DERIVED. The builder works these out from everything else — 108.000px,
//                     540.000px — and writing one sets a value the next edit in the builder
//                     will overwrite, or worse, won't. A design can be left disagreeing with
//                     itself in a way nothing in the editor explains.
//   image.width/height
//                     The intrinsic size of the file. Changing them does not resize anything,
//                     it stretches it. Image size belongs to percWidth and to the builder.
//   colour values     Already owned by lib/beestyle.js. Two modules writing the same property
//                     would race and the second would win silently.
//
// EVERY VALUE IS CHECKED AGAINST ITS OWN PROPERTY, not against a general "looks like CSS".
// font-weight accepts 100-900, bold and normal; text-align accepts four keywords; a length
// accepts px, % or auto and nothing else. A model that answers "a bit bigger" fails the whole
// edit rather than writing those words into a style property, where they are silently ignored
// and the design simply does not change — the worst outcome, because it reads as the feature
// being broken rather than the answer being wrong.

const clone = o => JSON.parse(JSON.stringify(o));

const LENGTH = /^(0|-?\d+(\.\d+)?(px|%|em|rem))$/i;
const LENGTH_AUTO = /^(auto|0|-?\d+(\.\d+)?(px|%|em|rem))$/i;
const BORDER = /^\d+(\.\d+)?px\s+(none|solid|dashed|dotted|double)\s+(#[0-9a-f]{3,8}|rgba?\([^)]*\)|transparent)$/i;
const ALIGN = /^(left|center|right|justify)$/i;
const WEIGHT = /^([1-9]00|normal|bold|bolder|lighter)$/i;
const LINE = /^(normal|\d+(\.\d+)?(px|%|em)?)$/i;

// FONT FAMILIES ARE A WHITELIST, not a validator. An email client renders what it has, and a
// design that asks for a font nobody installed falls back to something the designer never saw.
// These are the stacks that are safe in mail, written exactly as BEE writes them, so a model
// can only pick one that already works rather than invent "Helvetica Neue, sans" and have it
// degrade differently in every inbox.
export const FONT_STACKS = [
  "Arial, 'Helvetica Neue', Helvetica, sans-serif",
  "'Lucida Sans Unicode', 'Lucida Grande', 'Lucida Sans', Verdana, sans-serif",
  'Tahoma, Verdana, Segoe, sans-serif',
  "'Trebuchet MS', 'Lucida Grande', 'Lucida Sans Unicode', 'Lucida Sans', Tahoma, sans-serif",
  "Georgia, Times, 'Times New Roman', serif",
  "'Times New Roman', Times, Baskerville, Georgia, serif",
  'Verdana, Geneva, sans-serif',
  "Courier, 'Courier New', monospace",
];
const sameFont = (a, b) => String(a).replace(/['"\s]/g, '').toLowerCase() === String(b).replace(/['"\s]/g, '').toLowerCase();

// property -> { test, hint }. The hint is what the model is told the property accepts; nothing
// else describes the contract, so it lives next to the thing that enforces it.
const PROPS = {
  'font-size':      { test: v => LENGTH.test(v),     hint: 'a length like 16px' },
  'font-weight':    { test: v => WEIGHT.test(v),     hint: 'normal, bold or 100-900' },
  'line-height':    { test: v => LINE.test(v),       hint: 'a number, percentage or length like 140%' },
  'letter-spacing': { test: v => LENGTH.test(v),     hint: 'a length like 0px' },
  'text-align':     { test: v => ALIGN.test(v),      hint: 'left, center, right or justify' },
  'font-family':    { test: v => FONT_STACKS.some(f => sameFont(f, v)), hint: 'one of the listed font stacks, copied exactly' },
  'padding-top':    { test: v => LENGTH.test(v),     hint: 'a length like 24px' },
  'padding-bottom': { test: v => LENGTH.test(v),     hint: 'a length like 24px' },
  'padding-left':   { test: v => LENGTH.test(v),     hint: 'a length like 24px' },
  'padding-right':  { test: v => LENGTH.test(v),     hint: 'a length like 24px' },
  'border-radius':  { test: v => LENGTH.test(v),     hint: 'a length like 6px; 0px is square' },
  'border-top':     { test: v => BORDER.test(v),     hint: 'width style colour, like 1px solid #e2e2e2' },
  'border-bottom':  { test: v => BORDER.test(v),     hint: 'width style colour, like 1px solid #e2e2e2' },
  'border-left':    { test: v => BORDER.test(v),     hint: 'width style colour, like 1px solid #e2e2e2' },
  'border-right':   { test: v => BORDER.test(v),     hint: 'width style colour, like 1px solid #e2e2e2' },
  'width':          { test: v => LENGTH_AUTO.test(v), hint: 'a length, a percentage, or auto' },
};

// What this property DOES, in the words someone would use for it. Built from the path, like
// lib/beestyle.js, so a design that nests a module one level deeper still gets a sensible name
// instead of silently dropping out of the list.
function roleOf(path) {
  const m = /descriptor\.([a-z]+)\./i.exec(path);
  const kind = m ? m[1].toLowerCase() : null;
  if (kind === 'button') return 'button';
  if (kind === 'divider') return 'divider';
  if (kind === 'image') return 'image';
  if (kind) return kind;
  if (/\.columns\[/.test(path)) return 'column';
  if (/\.rows\[/.test(path)) return 'band';
  return 'page';
}

// One traversal for reading and writing, so they cannot disagree about what the Nth slot is.
// computedStyle is skipped WHOLE — not just its colour keys — because everything under it is
// derived and none of it is ours to set.
function walk(node, visit, path = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item, i) => walk(item, visit, `${path}[${i}]`)); return; }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'computedStyle') continue;
    const here = path ? `${path}.${key}` : key;
    const role = roleOf(here);
    // An image's width and height are the file's own dimensions, not a layout choice.
    const intrinsic = role === 'image' && (key === 'width' || key === 'height');
    if (PROPS[key] && typeof value === 'string' && value.trim() && !intrinsic) visit(node, key, role);
    else walk(value, visit, here);
  }
}

// One entry per distinct (role, property, value), in first-appearance order. `count` is how
// many properties it covers: "the bands are padded 60px" is one decision across six bands, and
// presenting it six times would invite six different answers.
export function beeStyleSlots(json) {
  const slots = [];
  const index = new Map();
  if (json) walk(json, (node, key, role) => {
    const value = String(node[key]).trim();
    const k = `${role}|${key}|${value.toLowerCase()}`;
    if (index.has(k)) { slots[index.get(k)].count++; return; }
    index.set(k, slots.length);
    slots.push({ role, prop: key, value, count: 1 });
  });
  return slots;
}

// `values` must be the same length and order beeStyleSlots() returned. null, empty, or a value
// equal to the one it replaces leaves that slot alone. Throws on anything the property does not
// accept, so the caller refuses the whole edit rather than writing half of it.
export function applyBeeStyles(json, values) {
  const slots = beeStyleSlots(json);
  if (!Array.isArray(values) || values.length !== slots.length) {
    throw new Error(`beeshape: expected ${slots.length} style value${slots.length === 1 ? '' : 's'}, got ${Array.isArray(values) ? values.length : typeof values}`);
  }
  // FONTS ALREADY IN THE DESIGN COUNT AS VALID, whatever the whitelist says. A live design uses
  // "Montserrat, Trebuchet MS, Lucida Grande", which is not one of the stacks above — and with
  // the whitelist alone as the test, that design could never be edited at all, because handing
  // its OWN value back failed validation. The whitelist is there to stop a model inventing a
  // font nobody has; it was never meant to overrule what a designer already chose.
  const present = new Set(beeStyleSlots(json).filter(s => s.prop === 'font-family')
    .map(s => s.value.replace(/['"\s]/g, '').toLowerCase()));

  const wanted = values.map((v, i) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const s = String(v).trim();
    const slot = slots[i];
    // UNCHANGED IS ALWAYS ALLOWED, and it is tested FIRST. A slot's current value comes out of
    // the design, not out of this file's idea of what is acceptable, so validating before
    // comparing turns any value we did not anticipate into a design that cannot be touched.
    if (s.toLowerCase() === slot.value.toLowerCase()) return null;
    const ok = PROPS[slot.prop].test(s)
      || (slot.prop === 'font-family' && present.has(s.replace(/['"\s]/g, '').toLowerCase()));
    if (!ok) {
      throw new Error(`beeshape: slot ${i + 1} (${slot.role} ${slot.prop}) expects ${PROPS[slot.prop].hint}, got ${JSON.stringify(s).slice(0, 40)}.`);
    }
    return s;
  });
  if (!wanted.some(Boolean)) return json;

  const index = new Map(slots.map((s, i) => [`${s.role}|${s.prop}|${s.value.toLowerCase()}`, i]));
  const copy = clone(json);
  walk(copy, (node, key, role) => {
    const i = index.get(`${role}|${key}|${String(node[key]).trim().toLowerCase()}`);
    if (i !== undefined && wanted[i]) node[key] = wanted[i];
  });
  return copy;
}

// The slots as a model sees them: numbered, named, told what each one accepts. The accepted
// form is on every line rather than in a preamble, because the mistake to prevent is answering
// one slot in the wrong units, not misunderstanding the task.
export function beeStylesToPrompt(json) {
  return beeStyleSlots(json)
    .map((s, i) => `[${i + 1}] ${s.role} ${s.prop} = ${s.value}${s.count > 1 ? ` (${s.count} places)` : ''}  — accepts ${PROPS[s.prop].hint}`)
    .join('\n');
}

// The font stacks this design may use: the safe-in-mail list, plus whatever it already uses.
// Given to the model verbatim, because "copied exactly" is only a usable instruction if it can
// see the exact strings — and because a design's own font is the one answer most likely to be
// right when the instruction is about something else entirely.
export function fontChoices(json) {
  const mine = beeStyleSlots(json).filter(s => s.prop === 'font-family').map(s => s.value);
  const seen = new Set();
  return [...mine, ...FONT_STACKS].filter(f => {
    const k = f.replace(/['"\s]/g, '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
