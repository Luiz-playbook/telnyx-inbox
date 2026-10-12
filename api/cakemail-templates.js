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
import { cakemailGet, cakemailKey, cakemailKeyEnvName, parseCakemailFrom, cakemailAccounts } from '../lib/cakemail.js';
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

    // WHICH ACCOUNT OWNS THIS TEMPLATE — resolved, not assumed.
    //
    // The design does not have to live in the sending account: the picker can browse any account
    // we hold a key for, because the HTML is copied onto the row and still goes out from the
    // row's own sender. So the template id here may belong to a different account than cm.
    //
    // RESOLVED RATHER THAN PASSED IN, and that is the point. Passing it would mean storing it
    // too — otherwise Refresh, which re-attaches by id alone and may run days later from a
    // fresh page load, would look in the row's account and not find it. That would be a fourth
    // column and a second migration to carry something the API can simply be asked. Template ids
    // are account-scoped at the URL but globally unique in practice, so the owner is found by
    // trying the row's own account first and the rest only if that misses.
    const candidates = [cm.accountId, ...cakemailAccounts().map(a => a.id).filter(id => id !== cm.accountId)];
    let name = null, html = '', owner = null, lastErr = null;
    for (const candidate of candidates) {
      try {
        // Name first, so a wrong id fails BEFORE anything is written. The render is the
        // expensive call of the two.
        const detail = await cakemailGet(`/templates/${templateId}`, { accountId: candidate });
        name = (detail && detail.data && detail.data.name) || `Template ${templateId}`;
        const raw = await cakemailGet(`/templates/${templateId}/render`, { accountId: candidate, raw: true });
        html = typeof raw === 'string' ? raw : (raw && (raw.data || raw.html)) || '';
        owner = candidate;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!owner) {
      res.status(502).json({ error: `CakeMail could not read template ${templateId} from any account we hold a key for. ${String((lastErr && lastErr.message) || '')}`.trim() });
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
    res.status(200).json({ ok: true, attached: true, template_id: Number(templateId), name, bytes: filled.length, empties, unconfirmed: wasConfirmed,
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
    const r = await fetch(`${supaUrl}/rest/v1/campaign_queue?select=email_html,cakemail_template_id,cakemail_template_name&id=eq.${encodeURIComponent(wantRow)}&limit=1`, { headers: h });
    if (!r.ok) { res.status(502).json({ error: `campaign_queue read failed (HTTP ${r.status})` }); return; }
    const row = (await r.json().catch(() => []))[0];
    if (!row) { res.status(404).json({ error: 'that blast is not in the queue' }); return; }
    if (!row.email_html) { res.status(200).json({ ok: true, attached: false }); return; }
    res.status(200).json({
      ok: true, attached: true,
      template_id: row.cakemail_template_id, name: row.cakemail_template_name,
      html: defangHtml(row.email_html),
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
