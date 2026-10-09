// Every blast this business has sent, from whichever platform sent it, in one list.
//
// The Market History tab used to read salesmsg_broadcasts directly from the browser, so it
// showed only what the Salesmsg sync had pulled — and nothing else. The Textable history
// imported on 2026-07-31 lives in ticketblaster_market_blasts_log (the table the decider
// reads for cooldown) and was therefore invisible in the tab named after it.
//
// WHY AN ENDPOINT RATHER THAN A DIRECT TABLE READ. ticketblaster_market_blasts_log is not
// readable with the anon key — RLS returns an empty array rather than an error, which is
// exactly how the tab could look "empty" while holding 11 rows. Reading it needs the
// service-role key, and that key must never reach the browser. So the join happens here.
//
// Returns blast history: market, channel, recipients, when, and the copy that was sent.
// No credentials, no recipient addresses — just what was blasted where.

import { supabaseKey } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';
import { cakemailGet, cakemailKey, cakemailKeyEnvName } from '../lib/cakemail.js';
import { hubspotToken } from '../lib/hubspot.js';

export const config = { maxDuration: 30 };

const num = v => (v == null || v === '' ? null : Number(v));

// CakeMail sub-account id -> a name a person recognises. Built from the environment, like
// lib/cakemail.js does, so moving a sub-account is a deployment change and not a code change.
// An unknown id falls back to the raw number rather than being hidden: an unlabelled account is
// something to notice, not something to swallow.
// Make a sent email safe to LOOK at.
//
// sandbox="" on the iframe stops scripts, forms and top-level navigation — but it does NOT stop
// a click navigating the iframe itself. Every blast ends in a one-click Unsubscribe, and that
// URL unsubscribes on GET: previewing a blast in the panel could quietly opt a real contact out
// of a real list (Vhea, 2026-09-08). Every tracked link in the body has the same shape, so a
// stray click could also register a click against the campaign and move the numbers this tab
// reports.
//
// Defanged HERE rather than in the browser, so a live href never reaches the page at all. The
// address is kept in data-href so it is still inspectable, and the anchors keep their styling —
// the point of the preview is to see what was sent, underlines included.
function defangHtml(html) {
  const inert =
    '<style>a{pointer-events:none!important;cursor:default!important}' +
    'form{pointer-events:none!important}</style>';
  const body = String(html)
    // href on anchors -> data-href. Handles quoted and bare values.
    .replace(/(<a\b[^>]*?)\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1 data-href=$2')
    // and the same for a form that would post somewhere
    .replace(/(<form\b[^>]*?)\saction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1 data-action=$2')
    // <base> would re-point every relative URL; nothing in a preview needs one
    .replace(/<base\b[^>]*>/gi, '');
  return inert + body;
}

function accountLabels() {
  // Seeded with the live ids so an account can still be NAMED on a deploy that is missing its
  // environment — which is the deploy most likely to be raising an error about it. Built only
  // from the *_ACCOUNT_ID vars, this map was empty in exactly the case it was needed for, and
  // the error fell back to "account 1679383". These ids mirror FALLBACK_ACCOUNT_ENV in
  // lib/cakemail.js, which resolves the same three the same way and for the same reason.
  // Anything the environment declares still wins, so moving a sub-account is a deployment
  // change and not a code change.
  const map = {
    '1679383': 'Playbook Sports - Cole',
    '1761047': 'Playbook Sports - Josh',
    '1679456': 'Test',
  };
  const put = (env, label) => { const id = (process.env[env] || '').trim(); if (id) map[id] = label; };
  put('PBSPORTS_COLE_CAKEMAIL_ACCOUNT_ID', 'Playbook Sports - Cole');
  put('PBSPORTS_CAKEMAIL_ACCOUNT_ID', 'Playbook Sports - Josh');
  put('PBTESTACCOUNT_CAKEMAIL_ACCOUNT_ID', 'Test');
  return map;
}

// Said in the two places a missing PAT surfaces — the HTML preview and the recipient roster.
// The account is NAMED rather than numbered, because the id is a lookup for the reader and the
// name is what every other part of this tab shows. cakemailKeyEnvName exists to state the exact
// variable to set, so the message carries the diagnosis and the fix together.
function missingKeyError(accountId) {
  const name = accountLabels()[String(accountId || '')] || (accountId ? `account ${accountId}` : 'this account');
  return `no CakeMail key for ${name} — set ${cakemailKeyEnvName(accountId)} on this deployment`;
}

// Resolve HubSpot identity, company and deal for a page of contacts, in two batched calls.
//
// SHARED BY ?recipients= AND ?activity=. The roster and the per-send activity list render the
// same row — name, status, HubSpot link, deal — so they must enrich identically. Keeping two
// copies of this guaranteed they would drift, and the drift would show as the same person
// having a deal on one tab and not the other.
//
// Mutates `contacts` in place and never throws: enrichment is an addition to a roster that is
// already useful, so a missing migration or a slow database leaves every row exactly as it was
// rather than losing the whole tab.
async function enrichContacts(contacts, url, h) {
      // FILL THE GAPS FROM THE MIRROR. A contact found once through the lookup is cached in
      // hubspot.hubspot_contacts — but the roster is rebuilt from CakeMail every time, and
      // CakeMail still has no recordid for them. Without this, reopening the panel offered "Find
      // in HubSpot" for somebody we had already found, forever.
      //
      // One batched call for the whole page rather than one per contact. Failure is not fatal:
      // the button reappears, which is the old behaviour, not a broken screen.
      const missing = contacts.filter(c => !c.hubspot_id && c.email).map(c => c.email);
      if (missing.length) {
        try {
          const idsR = await fetch(`${url}/rest/v1/rpc/hubspot_ids_for_emails`, {
            method: 'POST', headers: { ...h, 'content-type': 'application/json' },
            body: JSON.stringify({ p_emails: missing }),
          });
          if (idsR.ok) {
            const pairs = await idsR.json().catch(() => []);
            const byEmail = new Map((Array.isArray(pairs) ? pairs : []).map(p => [String(p.email || '').toLowerCase(), p.hs_object_id]));
            for (const c of contacts) {
              if (c.hubspot_id || !c.email) continue;
              const id = byEmail.get(c.email.toLowerCase());
              // `from_mirror` so the UI can tell a CakeMail-supplied id from one we resolved.
              if (id != null) { c.hubspot_id = String(id); c.from_mirror = true; }
            }
          }
        } catch { /* leave them unresolved; the Find button still works */ }
      }

      // THE DEAL, FOR THE WHOLE PAGE, IN ONE CALL. The deal is the thing worth seeing on a
      // recipient — "is this person attached to a live account, and which" — so it is resolved
      // for everyone we can name, not only for the rows somebody thinks to click. A page is 100
      // contacts; asking per person would be 100 round trips to paint one screen.
      //
      // Deliberately not fatal. A missing migration, an empty mirror or a slow database leaves
      // every row exactly as it was — the roster is still useful without deal data, and losing
      // the whole tab because an enrichment failed would be the wrong trade.
      const withEmail = contacts.filter(c => c.email).map(c => c.email);
      if (withEmail.length) {
        try {
          const dr = await fetch(`${url}/rest/v1/rpc/hubspot_deals_for_emails`, {
            method: 'POST', headers: { ...h, 'content-type': 'application/json' },
            body: JSON.stringify({ p_emails: withEmail }),
          });
          if (dr.ok) {
            const rows2 = await dr.json().catch(() => []);
            const byEmail = new Map((Array.isArray(rows2) ? rows2 : [])
              .map(r => [String(r.email || '').toLowerCase(), r]));
            for (const c of contacts) {
              const d = c.email && byEmail.get(c.email.toLowerCase());
              if (!d) continue;
              // WHETHER THE MIRROR KNOWS THEM AT ALL, which is not the same as whether the row has
              // a HubSpot link. Half of these contacts carry a recordid from CakeMail, so they link
              // out fine while being entirely absent from hubspot.hubspot_contacts — and for
              // those no company or deal can be resolved at all. The panel has to be able to say
              // "we do not know this person" rather than "this person has no deal".
              c.in_mirror = true;
              // The id comes back here too, so a contact the mirror knows gets its link even if
              // the pass above was skipped because CakeMail had already supplied one.
              if (!c.hubspot_id && d.hs_object_id != null) { c.hubspot_id = String(d.hs_object_id); c.from_mirror = true; }
              // Company is REFERENCE, deal is the answer — both are sent, and the UI ranks them.
              c.company_name = d.company_name || null;
              c.company_id = d.company_id != null ? String(d.company_id) : null;
              c.company_count = d.company_count || 0;
              if (d.deal_id != null) {
                c.deal = {
                  id: String(d.deal_id),
                  name: d.deal_name || null,
                  stage: d.deal_stage || null,
                  // The readable form, plus HubSpot's own won/lost flags — see migration 067.
                  // The UI must never infer either of those from the text.
                  stage_label: d.deal_stage_label || null,
                  is_won: !!d.deal_is_won,
                  is_lost: !!d.deal_is_lost,
                  pipeline: d.deal_pipeline || null,
                  pipeline_label: d.deal_pipeline_label || null,
                  amount: d.deal_amount == null ? null : Number(d.deal_amount),
                  closedate: d.deal_closedate || null,
                  modified: d.deal_modified || null,
                  // "their deal" and "a deal at their company" are different claims and the row
                  // must not present them identically.
                  via: d.deal_via || null,
                };
              }
            }
          }
        } catch { /* deal data is an enrichment; the roster stands without it */ }
      }
}

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  const url = process.env.SUPABASE_URL;
  const key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const h = { apikey: key, Authorization: `Bearer ${key}` };

  // ?lookup=<email> — find one person in HubSpot, on demand.
  //
  // WHY THIS EXISTS. A CakeMail list contact carries a `recordid` that is the HubSpot contact id,
  // and the roster links straight through to HubSpot on it. But only about half of them have one
  // — 15 of 30 in the sample — so the other half show no link and no company, and the only thing
  // known about them is an email address. This turns that address into the record.
  //
  // PROXIED, NOT CALLED FROM THE BROWSER. The n8n webhook URL would otherwise have to be
  // published in config.js to every visitor, and it answers "is this address one of your
  // contacts, and who are they" — which is not a question a page should be able to ask on behalf
  // of anyone who opens it. Here it is behind the same sign-in as the rest of /api.
  //
  // The webhook itself checks the mirror first and only calls HubSpot on a miss, caching what it
  // finds — so a second look at the same person costs nothing.
  const wantLookup = String(req.query?.lookup || '').trim();
  if (wantLookup) {
    const hook = (process.env.HUBSPOT_CONTACT_LOOKUP_URL || '').trim();
    if (!hook) {
      res.status(200).json({ ok: true, available: false,
        reason: 'Contact lookup is not configured. Set HUBSPOT_CONTACT_LOOKUP_URL on the server.' });
      return;
    }
    try {
      const hr = await fetch(hook, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Sent whether or not the webhook currently checks it. If the endpoint is given a
          // secret later — and it should be, it reads out real people's details — this side
          // already speaks it and nothing here has to change.
          'x-inbox-secret': process.env.REPLY_SECRET || '',
        },
        // ?force=1 re-reads the contact from HubSpot even when the mirror already holds them.
        // Records go stale — a deal moves stage, a contact changes company — and without this
        // the mirror branch answers first and nothing ever checks.
        body: JSON.stringify({ email: wantLookup, force: String(req.query?.force || '') === '1' }),
      });
      const d = await hr.json().catch(() => null);
      if (!hr.ok) {
        // 400 from the webhook means the address was unusable — pass that through as a real
        // answer rather than a server error, because the caller can act on it.
        res.status(hr.status === 400 ? 200 : 502).json({
          ok: hr.status === 400, available: true, found: false,
          reason: (d && (d.error || d.reason)) || `lookup failed (HTTP ${hr.status})`,
        });
        return;
      }
      // THE WEBHOOK RETURNS MORE THAN THE CONTACT NOW — it fetches and caches the contact's
      // companies and deals in the same request, and resolves which deal applies. Those fields
      // were being dropped here, so the work was done, cached, and then thrown away before it
      // reached the browser.
      //
      // Every field is optional: an older lookup workflow that answers with the contact alone
      // still works, and the row simply shows what it always showed.
      // The webhook answers with the raw HubSpot deal, where dealstage is an opaque id. The
      // batch path resolves it through hubspot.hubspot_deal_stages; this one has to as well, or
      // a row filled in by clicking shows "1607069" beside neighbours reading "Closed".
      let stageMap = null;
      if (d && d.deal && d.deal.dealstage) {
        try {
          const sr = await fetch(`${url}/rest/v1/rpc/hubspot_stage_labels`, {
            method: 'POST', headers: { ...h, 'content-type': 'application/json' },
            body: JSON.stringify({ p_stage_ids: [String(d.deal.dealstage)] }),
          });
          if (sr.ok) { const rows = await sr.json().catch(() => []); stageMap = Array.isArray(rows) ? rows[0] : null; }
        } catch { /* the raw id still renders; a label is an improvement, not a requirement */ }
      }
      const deal = d && d.deal ? {
        id: String(d.deal.hs_object_id != null ? d.deal.hs_object_id : d.deal_id),
        name: d.deal.dealname || null,
        stage: d.deal.dealstage || null,
        stage_label: (stageMap && stageMap.stage_label) || d.deal.dealstage || null,
        is_won: !!(stageMap && stageMap.is_won),
        is_lost: !!(stageMap && stageMap.is_lost),
        pipeline: d.deal.pipeline || null,
        pipeline_label: (stageMap && stageMap.pipeline_label) || null,
        amount: d.deal.amount == null ? null : Number(d.deal.amount),
        closedate: d.deal.closedate || null,
        modified: d.deal.hs_lastmodifieddate || null,
        via: d.deal_via || null,
      } : null;
      // The latest-modified company, which is the one the deal fallback keys on. The webhook
      // sends every company it found; the newest is the one worth naming.
      const comps = Array.isArray(d && d.companies) ? d.companies.slice() : [];
      comps.sort((a, b) => String(b.hs_lastmodifieddate || '').localeCompare(String(a.hs_lastmodifieddate || '')));
      res.status(200).json({ ok: true, available: true, found: !!(d && d.found),
        source: d && d.source, contact: (d && d.contact) || null,
        deal,
        company_name: comps.length ? (comps[0].name || null) : null,
        company_count: comps.length,
        reason: d && d.reason });
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e) });
    }
    return;
  }
  // ?recipients=<campaign_id>[&cursor=] — who a blast went to.
  //
  // ONE PAGE AT A TIME. A market list runs to a few thousand contacts (Washington State is
  // 2,684 across 27 pages), so this is opened deliberately from the panel and paged, never
  // loaded with the table.
  //
  // WHAT THIS IS, EXACTLY: the CakeMail list as it stands TODAY, not the roster at send time.
  // We never recorded the latter. Lists are also reused — 303 campaigns share 99 lists, and the
  // Pennsylvania list has been sent to seven times — so this is the market audience rather than
  // this campaign than anyone else. The UI says so; the honest framing has to travel with the
  // data, or it becomes a per-send recipient list in the reader mind.
  // ?sms_recipients=1&state=<code>&at=<iso>[&message=<copy>] — who an SMS blast went to.
  //
  // A DIFFERENT PARAMETER FROM ?recipients BECAUSE IT IS A DIFFERENT FACT. That one returns the
  // CakeMail list as it stands today; this returns recipients actually recorded at send time.
  // Collapsing them into one endpoint would mean one label over two things that disagree about
  // what they are claiming, which is the confusion the CakeMail note above exists to avoid.
  //
  // MATCHED ON MARKET AND TIME, NOT AN ID, because the rows this tab lists carry no campaign_queue
  // id — ticketblaster_market_blasts_log is a historical import and nothing in this repo writes
  // it.
  //
  // ONE SOURCE: blast_recipients. 095 also read public.telnyx_messages, on the theory that the
  // two-way inbox was the only pre-existing record of an outbound SMS. Measured across all 11
  // SMS blasts in the history — 796 reported recipients — it recovered ZERO rows, because that
  // table is inbox traffic (22 rows, 11 outbound, one number, all on 2026-07-02) and every blast
  // predates it. It could only ever have answered wrongly, so 097 removed it.
  //
  // EXPECT THIS TO BE EMPTY FOR OLD BLASTS, and that is the honest answer rather than a bug:
  // per-recipient history did not exist before migration 095 (2026-10-06).
  if (String(req.query?.sms_recipients || '').trim()) {
    const at = String(req.query?.at || '').trim();
    const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null;
    if (!when) { res.status(400).json({ error: 'at=<ISO timestamp> is required' }); return; }
    const r = await fetch(`${url}/rest/v1/rpc/blast_recipients_for`, {
      method: 'POST', headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({
        p_market:  String(req.query?.state || '').trim() || null,
        p_channel: 'sms',
        p_at:      when,
        // The function ignores this since 097 (it only narrowed the removed telnyx half). Still
        // passed because the signature kept it, and changing a function's arguments while the
        // deployed route calls it is a worse trade than one unused parameter.
        p_message: String(req.query?.message || '').trim() || null,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ error: `blast_recipients_for failed (HTTP ${r.status})`, detail: detail.slice(0, 300) });
      return;
    }
    const list = await r.json().catch(() => []);
    const rows = Array.isArray(list) ? list : [];
    res.status(200).json({ ok: true, recipients: rows, count: rows.length });
    return;
  }

  const wantRecips = String(req.query?.recipients || '').trim();
  if (wantRecips) {
    if (!/^[0-9]+$/.test(wantRecips)) { res.status(400).json({ error: 'recipients must be a campaign id' }); return; }
    const rows = await fetch(`${url}/rest/v1/blast_templates?select=account_id,list_id,list_name,scheduled_for&campaign_id=eq.${wantRecips}&limit=1`, { headers: h })
      .then(r => r.ok ? r.json() : []).catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) { res.status(404).json({ error: `campaign ${wantRecips} is not in blast history` }); return; }
    if (!row.list_id) { res.status(200).json({ ok: true, available: false, reason: 'This campaign has no list recorded, so its recipients cannot be looked up.' }); return; }
    const accountId = String(row.account_id || '');
    if (!cakemailKey(accountId)) { res.status(502).json({ error: missingKeyError(accountId) }); return; }
    try {
      const cur = String(req.query?.cursor || '').trim();
      const q = new URLSearchParams({ per_page: '100' });
      if (cur) q.set('cursor', cur);
      const j = await cakemailGet(`/lists/${row.list_id}/contacts?${q}`, { accountId });
      const data = (j && j.data) || [];
      const attr = (c, name) => (c.custom_attributes || []).find(a => a.name === name)?.value ?? null;
      const contacts = data.map(c => ({
        email: c.email || null,
        first: attr(c, 'firstname'), last: attr(c, 'lastname'),
        // The Playbook/HubSpot record id CakeMail carries per contact. Only about half the list
        // has one, which is why the mirror is consulted for the rest below.
        hubspot_id: attr(c, 'recordid'),
        status: c.status || null,
        bounces: c.bounces_count == null ? null : Number(c.bounces_count),
      }));

      await enrichContacts(contacts, url, h);

      res.status(200).json({
        ok: true, available: true,
        list_id: String(row.list_id), list_name: row.list_name || null,
        contacts,
        next_cursor: (j && j.pagination && j.pagination.cursor && j.pagination.cursor.next) || null,
      });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
    return;
  }

  // ?activity=<campaign_id>&type=<type> — WHO THIS SEND ACTUALLY REACHED, and what they did.
  //
  // This is a different question from ?recipients=, and a better one. ?recipients= reads
  // /lists/{id}/contacts, which is the list as it stands TODAY — shared by every blast to that
  // market, so it cannot say who a past send went to. The panel said as much in so many words
  // ("CakeMail keeps no record of who a past send reached"). That was wrong: /logs/campaigns
  // records one row per address per event, and it is how CakeMail's own "Sent to / Opened /
  // Clicked / Unsubscribed / Flagged as spam / Bounced" tabs are built.
  //
  // TYPE NAMES ARE VERIFIED AGAINST THE LIVE API, not inferred from the CakeMail UI labels:
  //
  //   sent  open  clickthru  unsubscribe  spam  bounce        valid
  //   delivered  click                                        REJECTED by the API
  //
  // `clickthru`, not `click` — the row even carries a clickthru_url. And `bounce` is an
  // aggregate: filtering on it returns every bounce with its own subtype in the row's `type`
  // (bounce_hb, bounce_sb, …), so the nine subtypes never need nine requests.
  //
  // NEEDS logs:read ON THAT ACCOUNT'S TOKEN. Cole's PAT has campaigns+reports but not logs or
  // suppressions, so his campaigns answer 403 here while production works — the 403 is passed
  // through with the scope named rather than being flattened into an empty roster, because
  // "nobody opened this" and "we are not allowed to ask" must not look the same.
  const wantActivity = String(req.query?.activity || '').trim();
  if (wantActivity) {
    if (!/^[0-9]+$/.test(wantActivity)) { res.status(400).json({ error: 'activity must be a campaign id' }); return; }
    const TYPES = new Set(['sent', 'open', 'clickthru', 'unsubscribe', 'spam', 'bounce']);
    const type = String(req.query?.type || 'sent').trim();
    if (!TYPES.has(type)) { res.status(400).json({ error: `type must be one of ${[...TYPES].join(', ')}` }); return; }

    const rows = await fetch(`${url}/rest/v1/blast_templates?select=account_id,list_name,scheduled_for&campaign_id=eq.${wantActivity}&limit=1`, { headers: h })
      .then(r => r.ok ? r.json() : []).catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) { res.status(404).json({ error: `campaign ${wantActivity} is not in blast history` }); return; }
    const accountId = String(row.account_id || '');
    if (!cakemailKey(accountId)) { res.status(502).json({ error: missingKeyError(accountId) }); return; }

    try {
      const cur = String(req.query?.cursor || '').trim();
      const q = new URLSearchParams({ per_page: '100', with_count: 'true', filter: `type==${type}` });
      if (cur) q.set('cursor', cur);
      const j = await cakemailGet(`/logs/campaigns/${wantActivity}?${q}`, { accountId });
      const data = (j && j.data) || [];

      // ONE ROW PER PERSON, not per event. 437 `open` events on a 545-address campaign is 250
      // people reading more than once; a roster that listed the same address five times would
      // be unreadable and would misstate the audience. occurrences is summed so the repeat is
      // still visible, and the first and last timestamps are kept because "opened once on the
      // day" and "opened six times over a week" are different signals.
      const byEmail = new Map();
      for (const e of data) {
        const email = String(e.email || '').trim().toLowerCase();
        if (!email) continue;
        const prev = byEmail.get(email);
        const ts = Number(e.timestamp) || null;
        if (!prev) {
          byEmail.set(email, {
            email,
            // The row's own type, which for a bounce is the SUBTYPE — bounce_hb, not bounce.
            activity_type: e.type || type,
            occurrences: Number(e.occurrences) || 1,
            first_at: ts, last_at: ts,
            clickthru_url: e.clickthru_url || null,
            user_agent: e.user_agent || null,
          });
        } else {
          prev.occurrences += Number(e.occurrences) || 1;
          if (ts != null) {
            if (prev.first_at == null || ts < prev.first_at) prev.first_at = ts;
            if (prev.last_at == null || ts > prev.last_at) prev.last_at = ts;
          }
          if (!prev.clickthru_url && e.clickthru_url) prev.clickthru_url = e.clickthru_url;
        }
      }
      const contacts = [...byEmail.values()].map(c => ({
        ...c,
        first: null, last: null, hubspot_id: null, status: null,
        first_at: c.first_at ? new Date(c.first_at * 1000).toISOString() : null,
        last_at: c.last_at ? new Date(c.last_at * 1000).toISOString() : null,
      }));

      // Same enrichment the roster gets, so the two tabs cannot disagree about a person.
      await enrichContacts(contacts, url, h);

      res.status(200).json({
        ok: true, available: true, type,
        list_name: row.list_name || null,
        // Events, not people — the difference is the point, so both are reported.
        events: (j && j.pagination && j.pagination.count != null) ? Number(j.pagination.count) : null,
        people: contacts.length,
        contacts,
        next_cursor: (j && j.pagination && j.pagination.cursor && j.pagination.cursor.next) || null,
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 403 here is a scope problem, and saying so is the whole difference between a fixable
      // report and a tab that looks empty. See the note above.
      const scope = e && e.status === 403;
      res.status(scope ? 200 : 502).json(scope
        ? { ok: true, available: false, type,
            reason: `This account's CakeMail token cannot read campaign logs (${msg}). `
                  + `Add the logs:read scope to the token for account ${accountId} to see per-send activity.` }
        : { error: msg });
    }
    return;
  }

  // ?replies=<campaign_id> — who replied to a blast.
  //
  // NEEDS A HUBSPOT TOKEN, WHICH THE SERVER DOES NOT HAVE YET. CakeMail exposes no reply metric
  // of any kind (checked the whole report payload), and blasts send with no reply_to override,
  // so replies land in Josh mailbox — which IS connected to HubSpot, 19,320 incoming emails
  // logged. Matching them to a blast on the subject line is verified: the Atlanta blast of
  // 2026-08-04 "tickets to see Messi & quick call" has replies logged as
  // "Re: tickets to see Messi & quick call".
  //
  // Until HUBSPOT_TOKEN is set this answers available:false with the reason, rather than 500 or
  // an empty list — "no replies" and "we cannot see replies" are different facts and the panel
  // must not show the second as the first.
  const wantReplies = String(req.query?.replies || '').trim();
  if (wantReplies) {
    if (!/^[0-9]+$/.test(wantReplies)) { res.status(400).json({ error: 'replies must be a campaign id' }); return; }
    const token = hubspotToken();   // HUBSPOT_ACCESS_TOKEN or HUBSPOT_TOKEN — see lib/hubspot.js
    if (!token) {
      // The old wording ("not connected to this server yet") made this read as a switch nobody had
      // flicked. The real position is upstream of us: CakeMail reports opens and clicks and has no
      // reply data of any kind — checked across the whole report payload — and blasts send with no
      // reply_to override, so an emailed reply lands in the sender's own mailbox. Recovering it
      // means matching those mailbox threads to a blast by subject line, which is a thing to build,
      // not a credential to set.
      res.status(200).json({ ok: true, available: false,
        reason: 'Coming Soon',
        detail: 'This feature is not yet available for emails.' });
      return;
    }
    const rows = await fetch(`${url}/rest/v1/blast_templates?select=subject,scheduled_for&campaign_id=eq.${wantReplies}&limit=1`, { headers: h })
      .then(r => r.ok ? r.json() : []).catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) { res.status(404).json({ error: `campaign ${wantReplies} is not in blast history` }); return; }
    if (!row.subject) {
      res.status(200).json({ ok: true, available: false,
        reason: 'No subject line was captured for this blast, and replies are matched on the subject.' });
      return;
    }
    try {
      // Replies keep arriving for weeks — the Messi blasts drew replies from 5 to 31 August — so
      // the window is generous rather than a day or two.
      const from = row.scheduled_for ? Date.parse(row.scheduled_for) : 0;
      const body = {
        filterGroups: [{ filters: [
          { propertyName: 'hs_email_direction', operator: 'EQ', value: 'INCOMING_EMAIL' },
          { propertyName: 'hs_email_subject', operator: 'CONTAINS_TOKEN', value: row.subject },
          ...(from ? [{ propertyName: 'hs_timestamp', operator: 'GTE', value: String(from) }] : []),
        ] }],
        properties: ['hs_email_subject', 'hs_email_from_email', 'hs_email_from_firstname',
                     'hs_email_from_lastname', 'hs_email_text', 'hs_timestamp'],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
        limit: 100,
      };
      const hr = await fetch('https://api.hubapi.com/crm/v3/objects/emails/search', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const hj = await hr.json().catch(() => null);
      if (!hr.ok) { res.status(502).json({ error: `HubSpot ${hr.status}: ${(hj && hj.message) || 'search failed'}` }); return; }

      // A subject match is not proof on its own: nine subjects are reused across markets, and a
      // CONTAINS_TOKEN match is looser still. Compare the stripped subject exactly.
      const norm = t => String(t || '').replace(/^\s*(re|fwd|fw)\s*:\s*/gi, '').replace(/^\s*\[external\]\s*/i, '').trim().toLowerCase();
      const target = norm(row.subject);
      const hits = ((hj && hj.results) || []).filter(e => norm(e.properties?.hs_email_subject) === target);

      // ONE ROW PER PERSON, not per message. A thread runs to four or five replies from the same
      // contact; counting messages would read as five interested people.
      const byPerson = new Map();
      for (const e of hits) {
        const p = e.properties || {};
        const key = String(p.hs_email_from_email || e.id).toLowerCase();
        const at = p.hs_timestamp || null;
        const prev = byPerson.get(key);
        if (prev) { prev.messages += 1; if (at && (!prev.at || at > prev.at)) { prev.at = at; prev.text = p.hs_email_text || prev.text; prev.id = e.id; } continue; }
        byPerson.set(key, {
          id: e.id, email: p.hs_email_from_email || null,
          first: p.hs_email_from_firstname || null, last: p.hs_email_from_lastname || null,
          at, text: p.hs_email_text || null, messages: 1,
        });
      }
      const people = [...byPerson.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      res.status(200).json({ ok: true, available: true, subject: row.subject, people, messages: hits.length });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
    return;
  }
  // ?html=<campaign_id> — the email exactly as it was sent, rendered.
  //
  // SERVED THROUGH HERE RATHER THAN LINKING THE HOSTED COPY. Every campaign carries a
  // show_email_link_url ("view in browser"), and it frames fine — frame-ancestors is *. But it
  // is a TRACKED link on link.playbookemail.com, so opening it may register as a view against
  // the campaign and inflate the open counts this same tab reports. Previewing a blast must not
  // change its numbers. CakeMail's /render-html is the same document with no tracking on it.
  //
  // The PAT also stays server-side, which it must: it can send mail.
  const wantHtml = String(req.query?.html || '').trim();
  if (wantHtml) {
    if (!/^[0-9]+$/.test(wantHtml)) { res.status(400).json({ error: 'html must be a campaign id' }); return; }
    // The account decides which PAT can read it — they are not interchangeable (lib/cakemail.js).
    const rows = await fetch(`${url}/rest/v1/blast_templates?select=account_id,name,subject&campaign_id=eq.${wantHtml}&limit=1`, { headers: h })
      .then(r => r.ok ? r.json() : []).catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) { res.status(404).json({ error: `campaign ${wantHtml} is not in blast history` }); return; }
    const accountId = String(row.account_id || '');
    if (!cakemailKey(accountId)) { res.status(502).json({ error: missingKeyError(accountId) }); return; }
    try {
      const raw = await cakemailGet(`/campaigns/${wantHtml}/render-html`, { accountId, raw: true });
      const html = typeof raw === 'string' ? raw : (raw && (raw.data || raw.html)) || '';
      if (!html) { res.status(502).json({ error: 'CakeMail returned no rendered HTML for this campaign' }); return; }
      res.status(200).json({ ok: true, campaign_id: wantHtml, name: row.name || null, subject: row.subject || null, html: defangHtml(html) });
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e) });
    }
    return;
  }

  const get = async (path) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { headers: h });
    if (!r.ok) return [];
    const j = await r.json().catch(() => []);
    return Array.isArray(j) ? j : [];
  };

  // Try the richer select, fall back to the narrower one. PostgREST 400s the WHOLE request for
  // one unknown column, and `get` cannot tell that apart from "no rows" — so before migration
  // 047 adds blast_templates.subject/sender, asking for them would blank the entire CakeMail
  // source and the tab would look like the sync never ran. Degrading beats vanishing.
  const getOrFallback = async (path, fallbackPath) => {
    const rows = await get(path);
    return rows.length ? rows : get(fallbackPath);
  };

  try {
    const [blasts, broadcasts, campaigns, bridge, lastFetch, appSends] = await Promise.all([
      get('ticketblaster_market_blasts_log?select=id,market_key,state_code,channel,template_name,recipient_count,source,blasted_at,message,notes&order=blasted_at.desc&limit=1000'),
      get('salesmsg_broadcasts?select=broadcast_id,name,channel,status,recipients,sent_count,delivered_count,message,sent_at&order=sent_at.desc&limit=1000'),
      // CakeMail sends. This is the history Cole actually reads when deciding what to blast,
      // and it is the decider's performance source (v_blast_scored -> v_market_performance) —
      // it belonged in the tab named Market History from the start. Kept fresh by
      // api/cakemail-sync.js.
      getOrFallback(
        // The bounce breakdown and the remaining rates are here for the panel's Reports tab,
        // which reproduces CakeMail's own per-campaign report. They were already synced by
        // api/cakemail-sync.js and simply never read.
        'blast_templates?select=campaign_id,account_id,name,list_name,scheduled_for,sent_emails,active_emails,opens,unique_opens,unopens,implied_opens,forwards,clicks,unique_clicks,bounces,bounces_hard,bounces_soft,bounces_dns_failure,bounces_full_mailbox,bounces_mail_blocked,bounces_transient,bounces_address_changed,bounces_challenge_response,unsubscribes,spams,open_rate,click_rate,clickthru_rate,bounce_rate,unsubscribe_rate,spam_rate,unopen_rate,sent_rate,email_template,subject,sender&order=scheduled_for.desc&limit=1000',
        'blast_templates?select=campaign_id,name,list_name,scheduled_for,sent_emails,open_rate,clickthru_rate,email_template&order=scheduled_for.desc&limit=1000'),
      // v_list_market, NOT market_bridge_list. The view is what v_blast_scored joins on, and it
      // resolves a list name three ways: an exact bridge row, a trailing state code
      // ('… · ICP — AZ' -> AZ -> phoenix), or a state name in the text ('Wisconsin' ->
      // milwaukee) — the last two only for states holding exactly one market. Reading the raw
      // bridge here would make this tab disagree with the decider it is meant to explain:
      // a blast would read "not bridged to a market" while v_market_performance was scoring it.
      // See migration 109.
      get('v_list_market?select=list_name,market_key&limit=5000'),
      // When the CakeMail sync last actually wrote. AI-970 asks the tab to state its own
      // freshness, and until now nothing did — the history could be three months stale and the
      // page looked identical to the day it was current.
      get('blast_templates?select=fetched_at&order=fetched_at.desc.nullslast&limit=1'),
      // BLASTS THIS APP SENT ITSELF, which until now appeared in Market History nowhere at all.
      //
      // api/queue-tick.js calls log_market_blast(code, name, channel, queue_id, segment) — and
      // THAT overload writes to public.market_blast_log, a cooldown ledger. The tab reads
      // ticketblaster_market_blasts_log, which a DIFFERENT overload of the same function name
      // writes and which only ever received the 2026-07-31 Textable import. So every send made
      // through this application was invisible here: 9 of them, including an SMS.
      //
      // campaign_queue is read rather than market_blast_log because the ledger carries only
      // market/channel/segment/queue id — no copy, no counts, no sender. The queue row has all
      // of it, and status='sent' is set by the same code path that writes the ledger.
      get('campaign_queue?select=id,title,state_code,state_name,segment,sms,email,sms_copy,email_copy,email_subject,phone_count,email_count,sms_from,email_from,sent_at,event_id&status=eq.sent&order=sent_at.desc&limit=1000'),
    ]);

    // list_name -> market_key, the same mapping v_blast_scored joins on. A list the resolver
    // cannot place shows with market null rather than being dropped: an unmapped list is a gap
    // to fix, not a campaign that did not happen.
    const marketOf = new Map(bridge.map(b => [b.list_name, b.market_key]));
    const acctLabel = accountLabels();

    // ---- "of the last 10 campaigns" ------------------------------------------------------
    //
    // CakeMail's per-campaign report puts an average beside every rate ("Open rate of the last
    // 10 campaigns — 60.49% avg."). Reproduced here rather than linked to, so the panel's
    // Reports tab reads the same as the CakeMail screen it mirrors.
    //
    // THE DEFINITION IS NOT A GUESS. It was derived from a real CakeMail report (campaign
    // 15501805, account 1761047) and every published average reproduces exactly:
    //
    //   open       (51.76 + 50.71 + 100 + 0 + 100) / 5 = 60.49%
    //   unsub      (1.27 + 1.28 + 0 + 0 + 0)       / 5 =  0.51%
    //   delivery   (90.45 + 90.46 + 100 + 100+100) / 5 = 96.18%
    //   bounce     (9.55 + 9.54 + 0 + 0 + 0)       / 5 =  3.82%
    //
    // So: the UNWEIGHTED mean of each campaign's own rate, over the ten most recent campaigns
    // ON THE SAME ACCOUNT, INCLUDING the campaign being viewed, and over however many exist
    // when there are fewer than ten. Not weighted by volume — a 2-recipient test send counts
    // as much as a 13,599-recipient blast, which is why those 100% test opens drag the average
    // to 60%. That is what CakeMail shows, so it is what this shows.
    //
    // Delivery rate is the one figure CakeMail does not store: it is (sent - bounces) / sent,
    // which matches the 90.45% on the report above (314 sent, 30 bounced, 284 delivered).
    const deliveryRate = c => {
      const sent = Number(c.sent_emails);
      if (!Number.isFinite(sent) || sent <= 0) return null;
      const b = Number(c.bounces) || 0;
      return ((sent - b) / sent) * 100;
    };
    const RATE_KEYS = ['open_rate', 'click_rate', 'clickthru_rate', 'bounce_rate',
                       'unsubscribe_rate', 'spam_rate'];
    // Campaigns per account, newest first. The outer query already orders by scheduled_for
    // desc, so pushing in order preserves it.
    const byAccount = new Map();
    for (const c of campaigns) {
      const k = String(c.account_id || '');
      if (!byAccount.has(k)) byAccount.set(k, []);
      byAccount.get(k).push(c);
    }
    // campaign_id -> { open_rate: n, ..., delivery_rate: n, n: howManyCampaignsAveraged }
    const baselineOf = new Map();
    for (const [, list] of byAccount) {
      for (let i = 0; i < list.length; i++) {
        // "Last 10 including this one" = this campaign and the nine sent before it.
        const window = list.slice(i, i + 10);
        const avg = pick => {
          const vals = window.map(pick).filter(v => Number.isFinite(v));
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        const out = { n: window.length, delivery_rate: avg(deliveryRate) };
        for (const key of RATE_KEYS) out[key] = avg(c => Number(c[key]));
        baselineOf.set(String(list[i].campaign_id), out);
      }
    }

    // One shape for both, so the table does not care where a row came from. `source` is the
    // platform, and it is shown — a Textable blast and a CakeMail one are not interchangeable
    // when you are reading history to decide what worked.
    // APP SENDS -> history rows, one per channel the row actually used.
    //
    // A queue row can carry both channels, and Market History is per channel, so a row that sent
    // SMS and email becomes two.
    //
    // CAKEMAIL EMAIL IS DELIBERATELY SKIPPED. Those sends are already in this list from the
    // CakeMail source below, fetched from CakeMail itself with opens, clicks and bounces that
    // the queue row does not have. Emitting them from here as well would double every email
    // blast in the tab and show the worse copy of each.
    //
    // The source label is derived from the sender, because that is what actually decides the
    // carrier: an sms_from shaped 'salesmsg:<team>:<phone>' went to Salesmsg (lib/salesmsg.js)
    // and anything else went to Telnyx via the n8n bulk webhook. Same for email with
    // 'cakemail:' against the Gmail webhook. Keep in step with parseSalesmsgFrom /
    // parseCakemailFrom in api/queue-tick.js.
    const appRows = [];
    for (const q of (appSends || [])) {
      const isSalesmsg = String(q.sms_from || '').startsWith('salesmsg:');
      const isCakemail = String(q.email_from || '').startsWith('cakemail:');
      const base = {
        sent_at: q.sent_at,
        name: q.title || '(untitled blast)',
        market: q.state_name || null,
        state_code: q.state_code || null,
        status: null,
        notes: q.segment ? `segment ${q.segment}` : null,
      };
      if (q.sms) {
        appRows.push({
          ...base,
          id: `cq:${q.id}:sms`,
          channel: 'SMS',
          source: isSalesmsg ? 'salesmsg' : 'telnyx',
          recipients: num(q.phone_count),
          // Handed to the carrier, not confirmed delivered — the same distinction queue-tick's
          // status string draws, and gap 1 is about. A number here would claim more than we know.
          sent_count: null,
          message: q.sms_copy || null,
          subject: null,
          sender: q.sms_from || null,
          engagement: { available: false, why: 'SMS blasts carry no open or click tracking.' },
        });
      }
      if (q.email && !isCakemail) {
        appRows.push({
          ...base,
          id: `cq:${q.id}:email`,
          channel: 'Email',
          source: 'gmail',
          recipients: num(q.email_count),
          sent_count: null,
          message: q.email_copy || null,
          subject: q.email_subject || null,
          sender: q.email_from || null,
          engagement: { available: false, why: 'Email sent through the Gmail webhook carries no open or click tracking.' },
        });
      }
    }

    const rows = [
      ...appRows,
      ...blasts.map(b => ({
        id: b.id,
        sent_at: b.blasted_at,
        name: b.template_name || '(untitled blast)',
        channel: (b.channel || 'sms').toLowerCase() === 'email' ? 'Email' : 'SMS',
        source: b.source || 'log',
        market: b.market_key || null,
        state_code: b.state_code || null,
        recipients: num(b.recipient_count),
        sent_count: null,               // the log records the send, not per-recipient delivery
        status: null,
        message: b.message || null,
        subject: null,                  // the log stores the copy, never the envelope
        sender: null,
        notes: b.notes || null,
        // AI-971. NOT zero — unmeasured. Textable/SMS carries no open or click tracking at all,
        // and a 0 in those columns would read as "nobody opened it" rather than "nobody could
        // have known". The UI renders available:false as an em dash with the reason on hover.
        engagement: { available: false, why: 'SMS blasts carry no open or click tracking.' },
      })),
      ...broadcasts.map(b => ({
        id: `sm:${b.broadcast_id}`,
        sent_at: b.sent_at,
        name: b.name || '(untitled broadcast)',
        channel: b.channel === 'Email' ? 'Email' : (b.channel || 'SMS'),
        source: 'salesmsg',
        market: null,                   // Salesmsg broadcasts target audiences, not markets
        state_code: null,
        recipients: num(b.recipients),
        sent_count: num(b.sent_count),
        status: b.status || null,
        message: b.message || null,
        subject: null,                  // Salesmsg broadcasts carry no subject line
        sender: null,
        notes: null,
        engagement: { available: false, why: 'Salesmsg broadcasts carry no open or click tracking.' },
      })),
      ...campaigns.map(c => {
        const mk = marketOf.get(c.list_name) || null;
        return {
          id: `cm:${c.campaign_id}`,
          sent_at: c.scheduled_for,
          name: c.name || '(untitled campaign)',
          channel: 'Email',                 // CakeMail is email-only
          source: 'cakemail',
          market: mk && mk !== 'other' ? mk : null,
          state_code: null,                 // the bridge resolves to a market, not a state
          recipients: num(c.sent_emails),
          sent_count: num(c.sent_emails),
          status: null,
          // blast_templates.email_template holds the sent BODY (Cole's plain-text copy), which
          // is what the other two sources put in `message` — one shape across all three.
          message: c.email_template || null,
          // Null on the 140 seeded rows (that import never captured them) and on anything
          // synced before migration 047. The UI drops whichever line is missing.
          subject: c.subject || null,
          sender: c.sender || null,
          // WHICH CakeMail sub-account sent it. Two accounts are in play — Cole's holds the
          // history, production is where sends moved on 2026-07-31 — and they are not the same
          // as the sender: Josh, Jake, Will and Zay have all sent from Cole's account. Reading
          // history without knowing the account makes those look like one stream.
          account: c.account_id ? { id: String(c.account_id), label: acctLabel[String(c.account_id)] || String(c.account_id) } : null,
          notes: [
            mk ? null : `list "${c.list_name || '?'}" not bridged to a market`,
          ].filter(Boolean).join(' · ') || null,

          // AI-971. Already captured by the CakeMail sync and never shown until now — every
          // one of these was sitting in blast_templates, populated on 302 of 303 campaigns.
          //
          // UNIQUE opens and clicks are the headline, not raw totals. The raw "opens" counts
          // every time a tracking pixel loaded, so one person reading a mail four times reads
          // as four; unique_opens is people. The totals are kept for the drawer, where the gap
          // between them is context rather than a number to compare markets on.
          //
          // Rates are CakeMail's own definitions, passed through untouched: open_rate is
          // against active_emails and clickthru_rate is clicks-over-opens. v_market_performance
          // already weights on exactly those, so recomputing here would quietly redefine what
          // "18% open" means for every existing consumer.
          //
          // available stays true when every figure is 0: for an email blast, zero opens is a
          // real measurement and must render as 0 (AC). Only a channel that cannot measure at
          // all gets available:false.
          engagement: {
            available: c.opens != null || c.unique_opens != null || c.open_rate != null,
            opens: num(c.unique_opens), opens_total: num(c.opens),
            clicks: num(c.unique_clicks), clicks_total: num(c.clicks),
            open_rate: num(c.open_rate), click_rate: num(c.click_rate),
            clickthru_rate: num(c.clickthru_rate), bounce_rate: num(c.bounce_rate),
            bounces: num(c.bounces), unsubscribes: num(c.unsubscribes), spams: num(c.spams),
            delivered: num(c.active_emails),
          },

          // THE PANEL'S REPORTS TAB — CakeMail's per-campaign report, rebuilt from data this
          // app already holds. No CakeMail call: every figure below is a blast_templates
          // column, so the tab works for all 311 campaigns including the 140 seeded ones, and
          // keeps working when a token loses a scope.
          //
          // Rates are passed through as CakeMail defines them (open_rate against
          // active_emails, clickthru_rate as clicks-over-opens) — see the engagement note
          // above for why they are never recomputed here.
          //
          // delivery_rate and the hard/soft split are the two things CakeMail derives rather
          // than stores. The split is hard vs EVERYTHING ELSE, which is how the CakeMail screen
          // presents it: a 30-bounce campaign with 15 hard reads "50% hard, 50% soft" even
          // though 14 of the other 15 were DNS failures, not classic soft bounces.
          report: {
            available: c.sent_emails != null || c.bounces != null || c.open_rate != null,
            sent: num(c.sent_emails),
            active: num(c.active_emails),
            opens_unique: num(c.unique_opens), opens_total: num(c.opens),
            clicks_unique: num(c.unique_clicks), clicks_total: num(c.clicks),
            unsubscribes: num(c.unsubscribes), spams: num(c.spams),
            bounces: num(c.bounces),
            bounces_hard: num(c.bounces_hard),
            // Named `_other` rather than `_soft` because that is what it is. The genuine
            // bounces_soft column is carried separately for anyone who wants the real figure.
            bounces_other: (() => {
              const b = Number(c.bounces), hard = Number(c.bounces_hard);
              return Number.isFinite(b) && Number.isFinite(hard) ? Math.max(0, b - hard) : null;
            })(),
            bounces_soft: num(c.bounces_soft),
            bounces_dns_failure: num(c.bounces_dns_failure),
            bounces_full_mailbox: num(c.bounces_full_mailbox),
            bounces_mail_blocked: num(c.bounces_mail_blocked),
            bounces_transient: num(c.bounces_transient),
            bounces_address_changed: num(c.bounces_address_changed),
            bounces_challenge_response: num(c.bounces_challenge_response),
            open_rate: num(c.open_rate), click_rate: num(c.click_rate),
            clickthru_rate: num(c.clickthru_rate), bounce_rate: num(c.bounce_rate),
            unsubscribe_rate: num(c.unsubscribe_rate), spam_rate: num(c.spam_rate),
            delivery_rate: deliveryRate(c),
            baseline: baselineOf.get(String(c.campaign_id)) || null,
          },
        };
      }),
    ];

    // Newest first; rows with no date sort last rather than jumping to the top.
    rows.sort((a, b) => {
      const ta = a.sent_at ? Date.parse(a.sent_at) : -Infinity;
      const tb = b.sent_at ? Date.parse(b.sent_at) : -Infinity;
      return tb - ta;
    });

    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      ok: true, rows,
      counts: { blast_log: blasts.length, salesmsg: broadcasts.length, cakemail: campaigns.length, app: appRows.length },
      // `synced_at` is when the sync last WROTE, which is not the same as when it last ran: a
      // run that finds nothing new writes nothing. The tab labels it as such rather than
      // claiming a check happened at a time nothing recorded.
      synced_at: (lastFetch[0] && lastFetch[0].fetched_at) || null,
      newest_sent_at: rows.length ? rows[0].sent_at : null,
      // TWO DIFFERENT FAULTS, COUNTED SEPARATELY. A single "unmapped" total read 76 and hid
      // that it was 35 lists nobody has bridged plus 41 campaigns carrying no list name at all.
      // The first is fixed by adding market_bridge_list rows; the second cannot be, because
      // there is nothing to bridge ON. Reporting them as one number invites someone to add 76
      // bridge rows and wonder why the count barely moves.
      //
      // `unbridged` counts what the RESOLVER could not place (migration 109), not what lacks an
      // exact bridge row — a list auto-resolved from its state code or state name is mapped and
      // must not be reported as a gap, or this number would nag about lists that need nothing.
      //
      // Both still cost the decider the same way: v_blast_scored inner-joins the bridge, so
      // either kind contributes nothing to v_market_performance and the market reads no_history.
      unbridged: campaigns.reduce((n, c) => n + (c.list_name && !marketOf.get(c.list_name) ? 1 : 0), 0),
      no_list_name: campaigns.reduce((n, c) => n + (c.list_name ? 0 : 1), 0),
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e), rows: [] });
  }
}
