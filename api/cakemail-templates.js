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
import { cakemailGet, cakemailKey, cakemailKeyEnvName, parseCakemailFrom } from '../lib/cakemail.js';
import { defangHtml } from '../lib/defang.js';
import { fillTokens, gameLabel, prettyDate } from '../lib/tokens.js';

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
  updated_on: t.updated_on || t.created_on || null,
});

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

    const templateId = String(body.template_id || '').trim();
    if (!/^[0-9]+$/.test(templateId)) { res.status(400).json({ error: 'template_id must be a CakeMail template id' }); return; }

    const cm = parseCakemailFrom(row.email_from);
    if (!cm) { res.status(400).json({ error: 'this blast does not send through CakeMail, so a CakeMail template cannot be attached to it' }); return; }
    if (!cakemailKey(cm.accountId)) { res.status(502).json({ error: missingKey(cm.accountId) }); return; }

    let name = null, html = '';
    try {
      // Name first, so the badge can be labelled and so a wrong id fails BEFORE anything is
      // written. The render is the expensive call of the two.
      const detail = await cakemailGet(`/templates/${templateId}`, { accountId: cm.accountId });
      name = (detail && detail.data && detail.data.name) || `Template ${templateId}`;
      const raw = await cakemailGet(`/templates/${templateId}/render`, { accountId: cm.accountId, raw: true });
      html = typeof raw === 'string' ? raw : (raw && (raw.data || raw.html)) || '';
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
    res.status(200).json({ ok: true, attached: true, template_id: Number(templateId), name, bytes: filled.length, empties, unconfirmed: wasConfirmed });
    return;
  }

  if (req.method !== 'GET') { res.status(405).json({ error: 'GET or POST' }); return; }

  // ---------------------------------------------------------------------------------------
  // GET — browse and preview.
  // ---------------------------------------------------------------------------------------
  const accountId = String(req.query?.account_id || '').trim();
  if (!/^[0-9]+$/.test(accountId)) { res.status(400).json({ error: 'account_id is required' }); return; }
  if (!cakemailKey(accountId)) { res.status(502).json({ error: missingKey(accountId) }); return; }

  const wantId = String(req.query?.id || '').trim();
  if (wantId) {
    if (!/^[0-9]+$/.test(wantId)) { res.status(400).json({ error: 'id must be a CakeMail template id' }); return; }
    try {
      const raw = await cakemailGet(`/templates/${wantId}/render`, { accountId, raw: true });
      const html = typeof raw === 'string' ? raw : (raw && (raw.data || raw.html)) || '';
      if (!html) { res.status(502).json({ error: 'CakeMail returned no rendered HTML for this template' }); return; }
      // DEFANGED. This is the only HTML that reaches the browser, and it reaches it with every
      // href moved to data-href — see lib/defang.js.
      res.status(200).json({ ok: true, id: Number(wantId), html: defangHtml(html) });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
    return;
  }

  try {
    // Newest edit first, which is the order someone who just built a template expects to find
    // it in. 100 per page: these libraries are small — the live accounts hold single digits —
    // and a picker that paged would be more machinery than the thing it is picking from.
    const q = new URLSearchParams({ page: '1', per_page: '100', with_count: 'true', sort: '-updated_on' });
    const j = await cakemailGet(`/templates?${q}`, { accountId });
    const templates = rowsOf(j).map(slim);
    res.status(200).json({ ok: true, account_id: accountId, count: templates.length, templates });
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
