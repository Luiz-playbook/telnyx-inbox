// The colours inside a CakeMail design, for every design type.
//
// WHY THIS EXISTS. lib/beetext.js unlocked editing a `bee` template's WORDS by round-tripping
// the descriptor.<kind>.html strings. Colours are the other half of what anybody actually wants
// to change, and they are not in those strings at all — checked against 955831 on 2026-10-14,
// zero of its nineteen text nodes carry an inline colour. They live in style properties
// scattered through the builder blob:
//
//   page.body.container.style.background-color                       the page behind everything
//   page.body.content.style.color                                    default body text
//   page.body.content.computedStyle.linkColor                        default link
//   page.rows[].container.style.background-color                     a band's background
//   page.rows[].content.style.color                                  a band's text
//   page.rows[].columns[].modules[].descriptor.text.style.color      a text module
//   ...descriptor.text.computedStyle.linkColor                       a link inside one
//   ...descriptor.button.style.background-color                      a button
//   ...descriptor.button.style.color                                 a button's label
//
// SLOTS, NOT NODES, and that is the whole design of this file. A 30 KB template has hundreds of
// colour properties and perhaps six distinct colours; asking a model to hand back hundreds of
// values in order is an invitation to drift, and most of them would come back identical anyway.
// So identical colours playing the same ROLE are collapsed into one slot. "The buttons are
// #009370" is one decision, and it is made once.
//
// Role matters as well as value, because the same green is often both a button and a link.
// Keyed on value alone, "make the buttons blue" would silently recolour every link in the
// design — a change nobody asked for, in a shared asset, discoverable only by reading it.
//
// ORDER IS THE CONTRACT, as in beetext.js: slots come out in first-appearance order, and
// apply() refuses a list of the wrong length rather than guessing, because a mismatch means the
// caller is working from a different version of the design.

const clone = o => JSON.parse(JSON.stringify(o));

// #abc, #aabbcc, #aabbccdd, rgb()/rgba(). Anything else at these keys is not a colour we are
// prepared to rewrite, and is left alone rather than guessed at.
const COLOUR = /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([^)]*\))$/i;

// The property names BEE keeps colours under. Deliberately a list and not "any key containing
// the word colour": `linkColor` is one of these and `computedStyle` holds others that are
// derived rather than set, so the set is named explicitly and grows only on evidence.
const COLOUR_KEYS = new Set(['color', 'linkColor', 'background-color', 'backgroundColor', 'border-color', 'borderColor']);

export const isColour = v => typeof v === 'string' && COLOUR.test(v.trim());

// Normalised for COMPARISON only — never for writing. #FFF, #ffffff and #FFFFFF are the same
// colour and must land in the same slot, or a design would present three decisions where it
// has one. What gets written back is whatever the caller supplies, verbatim.
export const sameColour = (a, b) => norm(a) === norm(b);
function norm(v) {
  let s = String(v || '').trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^#[0-9a-f]{8}$/.test(s) && s.endsWith('ff')) s = s.slice(0, 7);
  return s.replace(/\s+/g, '');
}

// A readable name for what a colour property DOES, built from the path rather than from a
// lookup table of exact paths — a table would quietly stop matching the first time BEE nests
// something one level deeper, and stopping silently is the failure that matters here.
function roleOf(path, key) {
  const module = /descriptor\.([a-z]+)\./i.exec(path);
  const kind = module ? module[1].toLowerCase() : null;
  const isBg = /background/i.test(key);
  const isLink = /link/i.test(key);
  if (kind === 'button') return isBg ? 'button background' : 'button text';
  if (kind === 'text' || kind === 'paragraph' || kind === 'heading' || kind === 'title') {
    return isLink ? 'link in text' : (isBg ? 'text block background' : 'text');
  }
  if (kind) return `${kind} ${isBg ? 'background' : (isLink ? 'link' : 'colour')}`;
  if (/rows\[/.test(path) || /\.rows\./.test(path)) return isBg ? 'band background' : (isLink ? 'band link' : 'band text');
  if (/body\.container/.test(path)) return 'page background';
  if (/body\.content/.test(path)) return isLink ? 'default link' : 'default text';
  return isBg ? 'background' : (isLink ? 'link' : 'colour');
}

// One traversal, used by both the reader and the writer, so they cannot disagree about what a
// slot is. `visit(node, key, role)` is called for every colour-valued property.
function walk(node, visit, path = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item, i) => walk(item, visit, `${path}[${i}]`)); return; }
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    if (COLOUR_KEYS.has(key) && isColour(value)) visit(node, key, roleOf(here, key));
    else walk(value, visit, here);
  }
}

// The design's palette: one entry per distinct (role, colour), in first-appearance order.
// `count` is how many properties that slot covers, which is what makes "the buttons" a single
// decision rather than eleven.
export function beeColourSlots(json) {
  const slots = [];
  const index = new Map();
  if (json) walk(json, (node, key, role) => {
    const k = `${role}|${norm(node[key])}`;
    if (index.has(k)) { slots[index.get(k)].count++; return; }
    index.set(k, slots.length);
    slots.push({ role, value: String(node[key]).trim(), count: 1 });
  });
  return slots;
}

// `values` must be the same length and order beeColourSlots() returned. An entry that is null,
// empty, or equal to the slot it replaces leaves that slot alone. Returns a new blob.
//
// Every value is checked against COLOUR before anything is written: a model that answers
// "dark blue" instead of "#1e3a8a" must fail the whole edit rather than put the words "dark
// blue" into a style property, where it would render as no colour at all and look like the
// design had broken by itself.
export function applyBeeColours(json, values) {
  const slots = beeColourSlots(json);
  if (!Array.isArray(values) || values.length !== slots.length) {
    throw new Error(`beestyle: expected ${slots.length} colour${slots.length === 1 ? '' : 's'}, got ${Array.isArray(values) ? values.length : typeof values}`);
  }
  const wanted = values.map((v, i) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const s = String(v).trim();
    if (!isColour(s)) throw new Error(`beestyle: slot ${i + 1} (${slots[i].role}) is not a colour: ${JSON.stringify(s).slice(0, 40)}`);
    return sameColour(s, slots[i].value) ? null : s;
  });
  if (!wanted.some(Boolean)) return json;

  const index = new Map(slots.map((s, i) => [`${s.role}|${norm(s.value)}`, i]));
  const copy = clone(json);
  walk(copy, (node, key, role) => {
    const i = index.get(`${role}|${norm(node[key])}`);
    if (i !== undefined && wanted[i]) node[key] = wanted[i];
  });
  return copy;
}

// The palette as a model sees it. Numbered, because it has to hand back the same count in the
// same order, and told what each colour is for and how much of the design it covers — without
// that, "make it feel calmer" has no way to tell the page background from a divider.
export function beeColoursToPrompt(json) {
  return beeColourSlots(json)
    .map((s, i) => `[${i + 1}] ${s.value}  — ${s.role}${s.count > 1 ? ` (used in ${s.count} places)` : ''}`)
    .join('\n');
}
