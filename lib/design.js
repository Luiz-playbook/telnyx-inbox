// Is the design on a row still what the CakeMail template says, and how do we take an update?
//
// The row holds a SNAPSHOT (migration 120), so an edit made in CakeMail after attaching does not
// reach it. That is deliberate — what a person approved must be what is sent — but it leaves a
// question the Queue has to be able to answer: has the template moved on since?
//
// ANSWERED BY COMPARING RENDERS, NOT BY A STORED TIMESTAMP. CakeMail's /render is deterministic:
// the same template rendered twice a second apart returns byte-identical HTML (verified
// 2026-10-12 on 952135 and 968380, 6146b and 30702b). So the current state can simply be
// re-rendered and compared with what the row holds, which needs no extra column, no migration,
// and cannot drift the way a cached timestamp can.
//
// It also catches a second kind of staleness a timestamp would miss: if the row's own game or
// date changed, fillTokens now produces different text from the same template, and what the row
// holds is equally out of date.

import { cakemailGet, cakemailAccounts, parseCakemailFrom } from './cakemail.js';
import { fillTokens } from './tokens.js';

// WHICH ACCOUNT OWNS IT — the row's own first, the rest only on a miss. Same order and same
// reasoning as the attach path in api/cakemail-templates.js: a design does not have to live in
// the sending account, and the owner is resolved rather than stored.
export function templateAccountCandidates(row) {
  const cm = parseCakemailFrom(row && row.email_from);
  const own = cm ? cm.accountId : null;
  const rest = cakemailAccounts().map(a => a.id).filter(id => id !== own);
  return own ? [own, ...rest] : rest;
}

// The attached template as it stands in CakeMail RIGHT NOW, filled for this row — i.e. exactly
// what attaching it again would store. Null when it cannot be read at all, which is a different
// answer from "unchanged" and is kept distinct on purpose: callers must not treat an outage as
// confirmation that nothing moved.
export async function renderAttachedTemplate(row) {
  const id = row && row.cakemail_template_id;
  if (!id) return null;
  for (const accountId of templateAccountCandidates(row)) {
    try {
      const raw = await cakemailGet(`/templates/${id}/render`, { accountId, raw: true });
      const html = typeof raw === 'string' ? raw : (raw && (raw.data || raw.html)) || '';
      if (html.trim()) return { html: fillTokens(html, row), accountId };
    } catch { /* try the next account */ }
  }
  return null;
}

// true  — CakeMail has moved on and the row would send something older.
// false — the row matches the template.
// null  — COULD NOT TELL. CakeMail was unreachable, the template was deleted, or the row has no
//         design. Never collapsed into `false`: "we checked and it is fine" and "we could not
//         check" must not look the same to a caller deciding whether to warn someone.
export async function designIsStale(row) {
  if (!row || !row.email_html || !row.cakemail_template_id) return null;
  const fresh = await renderAttachedTemplate(row);
  if (!fresh) return null;
  return fresh.html !== row.email_html;
}
