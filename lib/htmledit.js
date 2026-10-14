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
function walk(html, visit) {
  const s = String(html || '');
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { if (i < s.length) visit(s.slice(i), i, s.length); return; }
    if (lt > i) visit(s.slice(i, lt), i, lt);

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
    i = j + 1;
  }
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

// The copy as one readable block, numbered, for showing a model what it is editing. Entities
// are softened to the characters they stand for so the model reads sentences rather than
// markup, and writes sentences back.
export function htmlTextToPrompt(html) {
  return htmlTextNodes(html)
    .map((t, i) => `[${i + 1}] ${t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}
