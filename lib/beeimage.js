// The images in a CakeMail design: what they say, and where they go.
//
// WHAT THIS CAN CHANGE, and the one thing it cannot.
//
// An image module is descriptor.image.{src, alt, href, target, width, height, percWidth}. Three
// of those are editable here and matter more than they look:
//
//   alt     What the recipient reads when the picture does not load, which in email is most of
//           the time — Outlook and Gmail both block remote images by default until someone
//           clicks. "Alternate text", CakeMail's placeholder, is what 955831 still says. A
//           design whose hero image is blocked currently shows the words "Alternate text".
//   href    Where clicking it goes. On a ticket blast the hero image is the biggest click
//           target in the email, and pointing it at the right fixture is a real edit.
//   target  _self or _blank, and nothing else.
//
// SRC IS NOT EDITABLE, and not for want of trying. Swapping a picture needs somewhere to get
// one, and there is nowhere: CakeMail exposes no asset endpoint we can reach (/assets, /images,
// /files, /media all 404; /brands exists but our token lacks the scope), and the images already
// present across every design in every account come to ten files, nine of them CakeMail's own
// demo placeholders. A model cannot invent a URL that resolves, and one that does not resolves
// to a broken image in a sent email. So the picture itself stays a Playbook Mail job until
// either the brands scope is granted or a person supplies a URL.
//
// INDEXED, NOT COLLAPSED, unlike colours and sizes. Two images sharing the same alt text are
// still two images and will usually want different answers — "the hero" and "the footer logo"
// are not one decision the way "the button colour" is.

const clone = o => JSON.parse(JSON.stringify(o));

// Empty is allowed and common: an image with no href is simply not a link, and forcing one on
// every picture in a design would turn a footer logo into a click target nobody intended.
const HREF = /^$|^(https?:\/\/|mailto:|tel:)/i;
const TARGET = /^(_self|_blank)$/i;

// The fields a caller may set, with what each accepts. Anything not listed here — src, the
// dimensions, prefix — is read for context and never written.
const FIELDS = {
  alt: { test: () => true, hint: 'any text' },
  href: { test: v => HREF.test(String(v).trim()), hint: 'a URL starting http:// or https://, or empty for no link' },
  target: { test: v => TARGET.test(String(v).trim()), hint: '_self or _blank' },
};

// One traversal for reading and writing, in document order, so the Nth image out is the Nth
// image back in.
function walk(node, visit, path = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item, i) => walk(item, visit, `${path}[${i}]`)); return; }
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    if (key === 'image' && value && typeof value === 'object' && !Array.isArray(value) && typeof value.src === 'string') visit(value);
    else walk(value, visit, here);
  }
}

// Every image, in document order. `file` is the last segment of the URL, decoded — it is the
// only handle anyone has on WHICH picture this is, and "cakemail-demo-content-logo@3x.png"
// tells a model considerably more about what it is looking at than an index does.
export function beeImageSlots(json) {
  const out = [];
  if (json) walk(json, img => {
    let file = '';
    try { file = decodeURIComponent(String(img.src).split('?')[0].split('/').pop() || ''); } catch { file = String(img.src).split('/').pop() || ''; }
    out.push({
      file,
      alt: typeof img.alt === 'string' ? img.alt : '',
      href: typeof img.href === 'string' ? img.href : '',
      target: typeof img.target === 'string' ? img.target : '',
      width: img.width || null,
    });
  });
  return out;
}

// `items` must be the same length and order beeImageSlots() returned. Each item is an object of
// the fields to change; a field left out, null, or equal to what is there already is untouched.
// Throws on a value the field does not accept, so the caller refuses the whole edit.
export function applyBeeImages(json, items) {
  const slots = beeImageSlots(json);
  if (!Array.isArray(items) || items.length !== slots.length) {
    throw new Error(`beeimage: expected ${slots.length} image${slots.length === 1 ? '' : 's'}, got ${Array.isArray(items) ? items.length : typeof items}`);
  }
  // Checked in full BEFORE anything is written, so a bad value in the last image does not leave
  // the first three already changed.
  const wanted = items.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const set = {};
    for (const [field, spec] of Object.entries(FIELDS)) {
      const v = item[field];
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (s === String(slots[i][field] || '').trim()) continue;
      if (!spec.test(s)) {
        throw new Error(`beeimage: image ${i + 1} ${field} expects ${spec.hint}, got ${JSON.stringify(s).slice(0, 48)}.`);
      }
      set[field] = s;
    }
    return Object.keys(set).length ? set : null;
  });
  if (!wanted.some(Boolean)) return json;

  const copy = clone(json);
  let i = 0;
  walk(copy, img => {
    const set = wanted[i++];
    if (set) Object.assign(img, set);
  });
  return copy;
}

// The images as a model sees them. The file name is the handle; alt and href are what it may
// change. src is shown and never asked for, so there is no invitation to invent one.
export function beeImagesToPrompt(json) {
  return beeImageSlots(json)
    .map((s, i) => `[${i + 1}] ${s.file}${s.width ? ` (${s.width} wide)` : ''}\n`
      + `      alt  = ${JSON.stringify(s.alt)}\n`
      + `      link = ${s.href ? s.href : '(none)'}`)
    .join('\n');
}
