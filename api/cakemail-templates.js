// The CakeMail template library, for the Queue's "Choose CakeMail Template" button.
//
// WHY AN ENDPOINT AND NOT A BROWSER CALL. The PAT can send mail. lib/cakemail.js says so at the
// top and means it: it is server-side only, never in ui/config.js. So every call here is
// proxied, behind the same sign-in as the rest of /api.
//
// WHY THE APPLY HAPPENS HERE TOO, and not in the page. Attaching a design means fetching the
// template's rendered HTML — a live document, with live tracked links and a live one-click
// unsubscribe in it. Handing that to the browser to post back would put a working unsubscribe
// URL into the DOM of a page an operator is clicking around in, which is the hazard
// lib/defang.js exists to describe. So POST takes an id, and the HTML is fetched, token-filled
// and written to the row without ever leaving the server. The browser sees only the DEFANGED
// preview, which cannot navigate anywhere.
//
//   GET  ?account_id=<id>                 -> the account's templates: id, name, tags, thumbnail
//   GET  ?account_id=<id>&id=<tpl>        -> that template rendered, DEFANGED, for preview
//   POST { queue_id, template_id }        -> attach: render, fill tokens, write to the row
//   POST { queue_id, detach: true }       -> detach: clear the three columns together
//
// The account is never taken from the caller on POST. It is read from the row's own email_from
// (`cakemail:<account_id>:<sender_id>`), because a template can only be rendered by the token
// that owns it — asking account 1761047's token for one of Cole's templates is a 401, and
// letting the browser name the account would be letting it pick which token to spend.

import { supabaseKey } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';
import { cakemailGet, cakemailPost, cakemailKey, cakemailKeyEnvName, parseCakemailFrom, cakemailAccounts } from '../lib/cakemail.js';
import { defangHtml } from '../lib/defang.js';
import { designIsStale } from '../lib/design.js';
import { fillTokens, gameLabel, prettyDate, injectBody, wantsBody, bodyPlan } from '../lib/tokens.js';

export const config = { maxDuration: 30 };

// A CakeMail list response is `{ pagination, data: [...] }`; single-object endpoints are
// `{ data: {...} }`. Mirrors rowsOf in lib/cakemail.js, and accepts a bare array for the same
// reason: answering with an empty library because the envelope changed would read as "this
// account has no templates", which is a different and much quieter kind of wrong.
const rowsOf = j => (Array.isArray(j) ? j : (Array.isArray(j && j.data) ? j.data : []));

const missingKey = id =>
  `CakeMail is not configured for account ${id} — set ${cakemailKeyEnvName(id)} on the server`;

// Only ever the fields the picker draws. The full record carries content.json — a BEE builder
// blob that can run to tens of kilobytes per template and that nothing in the browser can read.
const slim = t => ({
  id: t.id,
  name: t.name || 'Untitled template',
  description: t.description || null,
  tags: Array.isArray(t.tags) ? t.tags : [],
  // The screenshot service CakeMail points at. Null for a template that has never been opened
  // in their editor, which the picker renders as a name-only tile rather than a broken image.
  thumbnail_url: t.thumbnail_url || null,
  // Epoch SECONDS, like every other CakeMail timestamp (see the note in lib/cakemail.js).
  //
  // BOTH DATES, SEPARATELY. They were folded into one field, which was fine while the picker
  // only sorted by it -- and wrong the moment the picker had to offer "newest first" and "last
  // edited" as different orders, because a template built in January and tweaked yesterday
  // belongs in a different place in each.
  updated_on: t.updated_on || t.created_on || null,
  created_on: t.created_on || t.updated_on || null,
});

// WHICH ACCOUNT OWNS THIS TEMPLATE. A design does not have to live in the account the blast
// sends from -- we copy the rendered HTML onto the row, and the row still sends from its own
// sender -- so a template id arriving here may belong to any account we hold a key for.
//
// Every CakeMail call must NAME an account, and naming the wrong one is a 400 Forbidden rather
// than a 404: the API will not tell you a template exists elsewhere. So the owner is found by
// trying, starting with the account most likely to be right and falling back to the others.
// Resolved rather than stored, because Refresh re-attaches by id alone days later from a fresh
// page load, and a stored owner would be a fourth column and a second migration to carry
// something the API can simply be asked.
//
// Used by BOTH the attach path and the preview. The preview used to pin itself to the account
// in the query string, which made opening a foreign design from the row fail with the raw
// "400: Forbidden" while attaching that same design worked.
async function renderFromAnyAccount(templateId, firstAccountId) {
  const first = String(firstAccountId || '');
  const candidates = [first, ...cakemailAccounts().map(a => String(a.id)).filter(id => id !== first)]
    .filter(id => id && cakemailKey(id));
  let lastErr = null;
  for (const accountId of candidates) {
    try {
      // Name first, so a wrong id fails BEFORE anything is written or rendered. The render is
      // the expensive call of the two.
      const detail = await cakemailGet(`/templates/${templateId}`, { accountId });
      const name = (detail && detail.data && detail.data.name) || `Template ${templateId}`;
      const raw = await cakemailGet(`/templates/${templateId}/render`, { accountId, raw: true });
      const html = typeof raw === 'string' ? raw : (raw && (raw.data || raw.html)) || '';
      return { owner: accountId, name, html, foreign: accountId !== first };
    } catch (e) { lastErr = e; }
  }
  const tried = candidates.length;
  throw new Error(`CakeMail could not read template ${templateId} from ${tried === 1 ? 'that account' : `any of the ${tried} accounts`} we hold a key for. ${String((lastErr && lastErr.message) || '')}`.trim());
}

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  const supaUrl = process.env.SUPABASE_URL;
  const key = supabaseKey();
  if (!supaUrl || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const h = { apikey: key, Authorization: `Bearer ${key}` };

  // ---------------------------------------------------------------------------------------
  // POST — attach or detach. Everything that touches a queue row is here.
  // ---------------------------------------------------------------------------------------
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    const queueId = String(body.queue_id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(queueId)) { res.status(400).json({ error: 'queue_id must be a row id' }); return; }

    // The row, through get_campaign_queue() rather than the table: the token fill needs team,
    // opponent, event_date and sport, and those are JOINED IN by that function from
    // events_master — they are not columns on campaign_queue. Reading the table directly would
    // fill [GAME] with nothing on every row.
    const qr = await fetch(`${supaUrl}/rest/v1/rpc/get_campaign_queue`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{}' });
    if (!qr.ok) { res.status(502).json({ error: `get_campaign_queue failed (HTTP ${qr.status})` }); return; }
    const all = await qr.json().catch(() => []);
    const row = (Array.isArray(all) ? all : []).find(x => String(x.id) === queueId);
    if (!row) { res.status(404).json({ error: 'that blast is not in the queue' }); return; }

    // A sent row is history. Rewriting what it sent would make the Queue disagree with what is
    // in the recipients' inboxes and with what Market History reports.
    //
    // PARTIAL COUNTS AS SENT, which is the Queue's own rule — it renders both read-only with
    // `sent = r.status==='sent' || r.status==='partial'` (ui/index.html), so the button is never
    // offered on either. Checked here as well because the UI not offering something is not the
    // same as the server refusing it. A partial row is the worse of the two to touch: a channel
    // has already delivered, queue-tick has no per-channel guard, and re-sending would mail the
    // half that already worked a second time.
    if (row.status === 'sent' || row.status === 'partial') {
      res.status(409).json({ error: row.status === 'partial'
        ? 'this blast has already partly gone out — its copy cannot be changed'
        : 'this blast has already been sent — its copy cannot be changed' });
      return;
    }

    // Noted BEFORE the write, because the write is what changes it (migration 121).
    const wasConfirmed = row.status === 'confirmed';

    if (body.detach) {
      const ok = await setHtml(supaUrl, h, queueId, null, null, null);
      if (!ok.ok) { res.status(502).json({ error: ok.error }); return; }
      res.status(200).json({ ok: true, attached: false, unconfirmed: wasConfirmed });
      return;
    }

    // DUPLICATE — the one and only write this app makes to CakeMail, and it is deliberately a
    // separate, explicitly-requested action rather than anything automatic.
    //
    // A template is shared. Editing it to suit one market rewrites it for every blast using it.
    // Copying it first gives this blast a design of its own to edit freely, and leaves the
    // original exactly as the other blasts expect it.
    //
    // THE COPY LANDS IN THE SENDING ACCOUNT, not the account it came from. That is the point for
    // a design borrowed from elsewhere — afterwards the blast owns its design outright, in the
    // account it sends from, and the loan is over.
    // SAVE THIS BLAST'S OWN DESIGN BACK INTO PLAYBOOK MAIL, as a template.
    //
    // A "this blast only" edit deliberately leaves the row with a design and no template, which
    // is right while it is a one-off and wrong the moment somebody likes it: there was no way to
    // promote it, because every other route here copies an EXISTING template and this row has
    // none. Vhea asked for the button, and it closes the loop — edit freely on one blast, then
    // keep the result for everything else.
    //
    // CREATED FROM THE RENDERED HTML, since that is all the row has. CakeMail takes it as
    // content {type:'html'} — verified against the live API on 2026-10-14 by creating one,
    // reading it back as type "html", rendering it, and deleting it again. It will open in
    // Playbook Mail's HTML editor rather than the drag-and-drop builder, because it is HTML and
    // not a builder document; the response says so and the UI repeats it, since finding that
    // out by opening it would be an unpleasant surprise.
    if (body.save_as_template) {
      const cmSave = parseCakemailFrom(row.email_from);
      if (!cmSave) { res.status(400).json({ error: 'this blast does not send through CakeMail' }); return; }
      if (!cakemailKey(cmSave.accountId)) { res.status(502).json({ error: missingKey(cmSave.accountId) }); return; }
      const html = String(row.email_html || '').trim();
      if (!html) { res.status(400).json({ error: 'This blast has no design to save.' }); return; }

      const label = String(row.title || '').replace(/^\s*\[TEST\]\s*/i, '').trim().slice(0, 60);
      const name = String(body.name || '').trim().slice(0, 120) || `${label || 'Blast'} — saved from SendBlaster`;
      try {
        const made = await cakemailPost('/templates', {
          accountId: cmSave.accountId,
          body: {
            name,
            description: `Saved from the blast "${label}" in SendBlaster. Built from the design that blast was sending.`,
            content: { type: 'html', subject: String(row.email_subject || '').slice(0, 200), html },
          },
        });
        const newId = made && (made.id || (made.data && made.data.id));
        if (!newId) throw new Error('CakeMail returned no id for the new template');
        res.status(200).json({ ok: true, saved: true, template_id: Number(newId), name,
                               account_id: cmSave.accountId, kind: 'html' });
      } catch (e) {
        res.status(502).json({ error: String((e && e.message) || e) });
      }
      return;
    }

    if (body.duplicate) {
      const srcId = String(body.template_id || row.cakemail_template_id || '').trim();
      if (!/^[0-9]+$/.test(srcId)) { res.status(400).json({ error: 'template_id is required to duplicate' }); return; }
      const cmDup = parseCakemailFrom(row.email_from);
      if (!cmDup) { res.status(400).json({ error: 'this blast does not send through CakeMail' }); return; }
      if (!cakemailKey(cmDup.accountId)) { res.status(502).json({ error: missingKey(cmDup.accountId) }); return; }

      let src = null, from = null;
      for (const candidate of [cmDup.accountId, ...cakemailAccounts().map(a => a.id).filter(id => id !== cmDup.accountId)]) {
        try { const j = await cakemailGet(`/templates/${srcId}`, { accountId: candidate }); if (j && j.data) { src = j.data; from = candidate; break; } } catch { /* next */ }
      }
      if (!src) { res.status(502).json({ error: `Could not read template ${srcId} from any account we hold a key for.` }); return; }

      // The name has to say what it is at a glance in CakeMail's own list, where it sits beside
      // the original with no other context.
      const label = String(row.title || '').replace(/^\s*\[TEST\]\s*/i, '').trim().slice(0, 60);
      const name = `${src.name || 'Template'} — ${label || 'copy'}`.slice(0, 120);
      try {
        const made = await cakemailPost('/templates', {
          accountId: cmDup.accountId,
          body: {
            name,
            description: `Copied from template ${srcId} for the blast "${label}". Editing this one affects only that blast.`,
            content: src.content,
            ...(Array.isArray(src.tags) && src.tags.length ? { tags: src.tags } : {}),
          },
        });
        const newId = made && (made.id || (made.data && made.data.id));
        if (!newId) throw new Error('CakeMail returned no id for the new template');
        res.status(200).json({ ok: true, duplicated: true, template_id: Number(newId), name, account_id: cmDup.accountId, from_account_id: from });
      } catch (e) {
        res.status(502).json({ error: String((e && e.message) || e) });
      }
      return;
    }

    const templateId = String(body.template_id || '').trim();
    if (!/^[0-9]+$/.test(templateId)) { res.status(400).json({ error: 'template_id must be a CakeMail template id' }); return; }

    const cm = parseCakemailFrom(row.email_from);
    if (!cm) { res.status(400).json({ error: 'this blast does not send through CakeMail, so a CakeMail template cannot be attached to it' }); return; }
    if (!cakemailKey(cm.accountId)) { res.status(502).json({ error: missingKey(cm.accountId) }); return; }

    // WHICH ACCOUNT OWNS THIS TEMPLATE — resolved, not assumed, and not stored. See
    // renderFromAnyAccount above for why. The row's own account is tried first.
    let name = null, html = '', owner = null;
    try {
      ({ name, html, owner } = await renderFromAnyAccount(templateId, cm.accountId));
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e) });
      return;
    }
    if (!html.trim()) { res.status(502).json({ error: `CakeMail returned no HTML for template ${templateId}. A template that has never been saved in the editor renders empty.` }); return; }

    // The SAME fill api/queue-draft.js applies to a stored template — see lib/tokens.js. A
    // CakeMail design is written with the same [GAME]/[DATE]/[SPORT] placeholders, and an
    // unfilled one would be delivered literally to the whole market.
    const filled = fillTokens(html, row);

    const ok = await setHtml(supaUrl, h, queueId, filled, Number(templateId), name);
    if (!ok.ok) { res.status(502).json({ error: ok.error }); return; }

    // WHAT IS WORTH WARNING ABOUT, and what very much is not.
    //
    // NOT a leftover-[TOKEN] scan like the one in api/queue-draft.js. Checked against the live
    // library on 2026-10-10: two of the three templates in account 1679383 carry [SHOWEMAIL],
    // [UNSUBSCRIBE] and [GLOBAL_UNSUBSCRIBE], which are CAKEMAIL'S OWN merge tags — CakeMail
    // substitutes them at send time, the unsubscribe ones are required for CAN-SPAM/CASL, and
    // flagging them would tell an operator to go and delete the compliance link. A generic scan
    // here fires on almost every real design and is worse than no check at all.
    //
    // What CAN go wrong is the opposite: a token we DO own resolving to nothing. fillTokens
    // always replaces [GAME]/[DATE]/[SPORT], so they never survive — but a row with no
    // event_date turns "on [DATE]" into "on ", which reads as a broken sentence to the whole
    // market and is invisible in a preview of the template's own copy. So the check is: which
    // of our three does this design use, and which of those came out empty for THIS row.
    const empties = [
      ['[GAME]', gameLabel(row)],
      ['[DATE]', prettyDate(row.event_date)],
      ['[SPORT]', row.sport],
    ].filter(([tok, val]) => html.includes(tok) && !String(val || '').trim()).map(([tok]) => tok);

    // `unconfirmed` is reported so the UI can say the approval was withdrawn. Migration 121
    // does it inside the same UPDATE rather than as a second call from here: the cron runs
    // hourly, and two statements would leave a window in which the row is confirmed AND already
    // carries the new design — the exact state being prevented.
    res.status(200).json({ ok: true, attached: true, template_id: Number(templateId), name, bytes: filled.length, empties, unconfirmed: wasConfirmed, wants_body: wantsBody(filled), body_plan: bodyPlan(filled),
      source_account_id: owner, foreign: owner !== cm.accountId });
    return;
  }

  if (req.method !== 'GET') { res.status(405).json({ error: 'GET or POST' }); return; }

  // ---------------------------------------------------------------------------------------
  // GET — browse and preview.
  // ---------------------------------------------------------------------------------------
  // ?queue_id=<uuid> — THE DESIGN THIS ROW WILL ACTUALLY SEND, for the preview in the Queue.
  //
  // Deliberately the row's STORED email_html and not a fresh render of the template. They are
  // not the same thing and the difference is the whole point of migration 120: the row holds a
  // copy taken at the moment it was attached, with [GAME]/[DATE]/[SPORT] already filled for THIS
  // blast. Re-rendering the template here would show a preview with empty tokens, and would show
  // any edit made in CakeMail since — i.e. it would show something other than what is going to
  // be sent, in the one place whose job is to show what is going to be sent. Refresh is how a
  // CakeMail edit is deliberately taken.
  //
  // Defanged, like every other preview — see lib/defang.js.
  const wantRow = String(req.query?.queue_id || '').trim();
  if (wantRow) {
    if (!/^[0-9a-f-]{36}$/i.test(wantRow)) { res.status(400).json({ error: 'queue_id must be a row id' }); return; }
    // THROUGH get_campaign_queue(), NOT THE TABLE — the same reason the attach path gives. The
    // staleness check re-runs fillTokens, which needs event_date and sport, and those are JOINED
    // IN from events_master; they are not columns on campaign_queue. Reading the table directly
    // 400s on event_date, and if it did not it would quietly compare against a render with the
    // date missing and call every row stale.
    const r = await fetch(`${supaUrl}/rest/v1/rpc/get_campaign_queue`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{}' });
    if (!r.ok) { res.status(502).json({ error: `get_campaign_queue failed (HTTP ${r.status})` }); return; }
    const all = await r.json().catch(() => []);
    const row = (Array.isArray(all) ? all : []).find(x => String(x.id) === wantRow);
    if (!row) { res.status(404).json({ error: 'that blast is not in the queue' }); return; }
    if (!row.email_html) { res.status(200).json({ ok: true, attached: false }); return; }
    res.status(200).json({
      ok: true, attached: true,
      template_id: row.cakemail_template_id, name: row.cakemail_template_name,
      // The SAME injection api/queue-tick.js does on the way out. A preview that skipped it
      // would show [BODY] sitting in the middle of the design while recipients get the copy —
      // which is the one thing this view must never do.
      wants_body: wantsBody(row.email_html),
      // WHERE the copy lands, and how much of the design is left untouched when it has to
      // guess. See lib/tokens.js — the fallback is a guess and the count is what says so.
      body_plan: bodyPlan(row.email_html),
      // HOW MANY OTHER BLASTS SHARE THIS DESIGN. One template in CakeMail, many rows: editing it
      // there changes every one of them, and with the tick now pulling updates automatically
      // they would all take that change at send. The row has to be able to say so BEFORE
      // somebody opens the editor.
      shared_with: await sharedCount(supaUrl, h, row.cakemail_template_id, wantRow),
      // HAS CAKEMAIL MOVED ON. true/false/null, and null is not false — see lib/design.js. The
      // row renders the warning only on a definite true, so an outage never produces a scary
      // banner about a design that is probably fine.
      stale: await designIsStale(row),
      html: defangHtml(injectBody(row.email_html, row)),
    });
    return;
  }

  // ?accounts=1 — which CakeMail accounts the picker may browse.
  //
  // A DESIGN DOES NOT HAVE TO LIVE IN THE SENDING ACCOUNT. We copy the rendered HTML onto the
  // row and send it from whatever sender the row already has, so a template built under a
  // retired sender is still perfectly usable: nothing is ever sent FROM the account it was
  // browsed from. That is what makes listing every account safe, and it is the whole reason
  // Cole's Ticketblast can be put on a production blast.
  //
  // `can_send` is the warning the picker shows. Cole's sender is deliberately absent from
  // EMAIL_SENDERS (ui/index.html) because every Playbook template signs off as Josh, so a blast
  // FROM cole@ would contradict itself in the inbox. Browsing his designs does not resurrect
  // that sender, and the flag says so rather than leaving the account looking fully available.
  if (String(req.query?.accounts || '').trim()) {
    res.status(200).json({ ok: true, accounts: cakemailAccounts() });
    return;
  }

  const accountId = String(req.query?.account_id || '').trim();
  if (!/^[0-9]+$/.test(accountId)) { res.status(400).json({ error: 'account_id is required' }); return; }
  if (!cakemailKey(accountId)) { res.status(502).json({ error: missingKey(accountId) }); return; }

  const wantId = String(req.query?.id || '').trim();
  if (wantId) {
    if (!/^[0-9]+$/.test(wantId)) { res.status(400).json({ error: 'id must be a CakeMail template id' }); return; }
    try {
      // account_id is where to LOOK FIRST, not the only place to look — see
      // renderFromAnyAccount. The picker always passes the account it listed from, so that
      // first try is the hit in the ordinary case and nothing extra is called.
      const { html, name, owner, foreign } = await renderFromAnyAccount(wantId, accountId);
      if (!html.trim()) { res.status(502).json({ error: `CakeMail returned no HTML for template ${wantId}. A template that has never been saved in the editor renders empty.` }); return; }
      // DEFANGED. This is the only HTML that reaches the browser, and it reaches it with every
      // href moved to data-href — see lib/defang.js.
      // The name comes back too: the preview can be opened on a design that is attached to a
      // row but no longer in the account's listing, and a real name beats "Design 955831".
      res.status(200).json({ ok: true, id: Number(wantId), name, html: defangHtml(html),
                             source_account_id: owner, foreign });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
    return;
  }

  try {
    // NEWEST FIRST, BY CREATION. Someone who has just built a template looks for it at the top,
    // and "top" has to mean the same thing every time they open this -- an edit-ordered list
    // reshuffles itself whenever anybody touches anything, including this app's own AI edits.
    // The picker can re-sort by last edited; this is only where it starts.
    //
    // EVERY PAGE, not the first hundred. The live accounts hold single digits and the first
    // version read one page on that basis, which silently becomes "your library is the hundred
    // CakeMail happened to return first" for an org that grows. The cap is there so a runaway
    // account cannot hold a request open indefinitely; it is reported rather than hidden,
    // because a truncated library that says it is complete is the bad outcome here.
    const PER = 100, MAX_PAGES = 20;
    const templates = [];
    let total = null, truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({ page: String(page), per_page: String(PER), with_count: 'true', sort: '-created_on' });
      const j = await cakemailGet(`/templates?${q}`, { accountId });
      const rows = rowsOf(j);
      if (total === null) total = Number(j && j.pagination && j.pagination.count);
      templates.push(...rows.map(slim));
      if (rows.length < PER) break;
      if (page === MAX_PAGES) truncated = true;
    }
    res.status(200).json({ ok: true, account_id: accountId, count: templates.length,
                           total: Number.isFinite(total) ? total : templates.length, truncated, templates });
  } catch (e) {
    // The message from lib/cakemail.js is already specific ("CakeMail GET /templates -> 401:
    // Invalid token") and is passed through rather than flattened into an empty library: a
    // token that cannot read templates and an account that has none must not look the same.
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}

// One writer for both attach and detach, so the three columns can never be set apart from each
// other. queue_set_email_html is service_role only (migration 120).
async function setHtml(supaUrl, h, id, html, templateId, name) {
  const r = await fetch(`${supaUrl}/rest/v1/rpc/queue_set_email_html`, {
    method: 'POST',
    headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ p_id: id, p_html: html, p_template_id: templateId, p_template_name: name }),
  });
  if (r.ok) return { ok: true };
  const detail = await r.text().catch(() => '');
  return { ok: false, error: `queue_set_email_html failed (HTTP ${r.status}) ${detail.slice(0, 200)}` };
}

// Other queue rows sending the same design. Excludes this row and anything already sent, since
// those cannot be affected by an edit made now.
async function sharedCount(supaUrl, h, templateId, selfId) {
  if (!templateId) return 0;
  const q = `${supaUrl}/rest/v1/campaign_queue?select=id&cakemail_template_id=eq.${encodeURIComponent(templateId)}`
          + `&id=neq.${encodeURIComponent(selfId)}&status=not.in.(sent,partial)`;
  const r = await fetch(q, { headers: { ...h, Prefer: 'count=exact' } });
  if (!r.ok) return 0;
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}
