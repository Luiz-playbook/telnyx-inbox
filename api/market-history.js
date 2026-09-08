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
import { cakemailGet, cakemailKey } from '../lib/cakemail.js';

export const config = { maxDuration: 30 };

const num = v => (v == null || v === '' ? null : Number(v));

// CakeMail sub-account id -> a name a person recognises. Built from the environment, like
// lib/cakemail.js does, so moving a sub-account is a deployment change and not a code change.
// An unknown id falls back to the raw number rather than being hidden: an unlabelled account is
// something to notice, not something to swallow.
function accountLabels() {
  const map = {};
  const put = (env, label) => { const id = (process.env[env] || '').trim(); if (id) map[id] = label; };
  put('PBSPORTS_COLE_CAKEMAIL_ACCOUNT_ID', 'Cole');
  put('PBSPORTS_CAKEMAIL_ACCOUNT_ID', 'Production');
  put('PBTESTACCOUNT_CAKEMAIL_ACCOUNT_ID', 'Test');
  return map;
}

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  const url = process.env.SUPABASE_URL;
  const key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const h = { apikey: key, Authorization: `Bearer ${key}` };

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
    if (!cakemailKey(accountId)) { res.status(502).json({ error: `no CakeMail key for account ${accountId}` }); return; }
    try {
      const raw = await cakemailGet(`/campaigns/${wantHtml}/render-html`, { accountId, raw: true });
      const html = typeof raw === 'string' ? raw : (raw && (raw.data || raw.html)) || '';
      if (!html) { res.status(502).json({ error: 'CakeMail returned no rendered HTML for this campaign' }); return; }
      res.status(200).json({ ok: true, campaign_id: wantHtml, name: row.name || null, subject: row.subject || null, html });
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
    const [blasts, broadcasts, campaigns, bridge, lastFetch] = await Promise.all([
      get('ticketblaster_market_blasts_log?select=id,market_key,state_code,channel,template_name,recipient_count,source,blasted_at,message,notes&order=blasted_at.desc&limit=1000'),
      get('salesmsg_broadcasts?select=broadcast_id,name,channel,status,recipients,sent_count,delivered_count,message,sent_at&order=sent_at.desc&limit=1000'),
      // CakeMail sends. This is the history Cole actually reads when deciding what to blast,
      // and it is the decider's performance source (v_blast_scored -> v_market_performance) —
      // it belonged in the tab named Market History from the start. Kept fresh by
      // api/cakemail-sync.js.
      getOrFallback(
        'blast_templates?select=campaign_id,account_id,name,list_name,scheduled_for,sent_emails,active_emails,opens,unique_opens,clicks,unique_clicks,bounces,unsubscribes,spams,open_rate,click_rate,clickthru_rate,bounce_rate,email_template,subject,sender&order=scheduled_for.desc&limit=1000',
        'blast_templates?select=campaign_id,name,list_name,scheduled_for,sent_emails,open_rate,clickthru_rate,email_template&order=scheduled_for.desc&limit=1000'),
      get('market_bridge_list?select=list_name,market_key&limit=1000'),
      // When the CakeMail sync last actually wrote. AI-970 asks the tab to state its own
      // freshness, and until now nothing did — the history could be three months stale and the
      // page looked identical to the day it was current.
      get('blast_templates?select=fetched_at&order=fetched_at.desc.nullslast&limit=1'),
    ]);

    // list_name -> market_key, the same mapping v_blast_scored joins on. A list with no bridge
    // row shows with market null rather than being dropped: an unmapped list is a gap to fix,
    // not a campaign that did not happen.
    const marketOf = new Map(bridge.map(b => [b.list_name, b.market_key]));
    const acctLabel = accountLabels();

    // One shape for both, so the table does not care where a row came from. `source` is the
    // platform, and it is shown — a Textable blast and a CakeMail one are not interchangeable
    // when you are reading history to decide what worked.
    const rows = [
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
      counts: { blast_log: blasts.length, salesmsg: broadcasts.length, cakemail: campaigns.length },
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
      // Both still cost the decider the same way: v_blast_scored inner-joins the bridge, so
      // either kind contributes nothing to v_market_performance and the market reads no_history.
      unbridged: campaigns.reduce((n, c) => n + (c.list_name && !marketOf.get(c.list_name) ? 1 : 0), 0),
      no_list_name: campaigns.reduce((n, c) => n + (c.list_name ? 0 : 1), 0),
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e), rows: [] });
  }
}
