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

export const config = { maxDuration: 30 };

const num = v => (v == null || v === '' ? null : Number(v));

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  const url = process.env.SUPABASE_URL;
  const key = supabaseKey();
  if (!url || !key) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const h = { apikey: key, Authorization: `Bearer ${key}` };

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
    const [blasts, broadcasts, campaigns, bridge] = await Promise.all([
      get('ticketblaster_market_blasts_log?select=id,market_key,state_code,channel,template_name,recipient_count,source,blasted_at,message,notes&order=blasted_at.desc&limit=1000'),
      get('salesmsg_broadcasts?select=broadcast_id,name,channel,status,recipients,sent_count,delivered_count,message,sent_at&order=sent_at.desc&limit=1000'),
      // CakeMail sends. This is the history Cole actually reads when deciding what to blast,
      // and it is the decider's performance source (v_blast_scored -> v_market_performance) —
      // it belonged in the tab named Market History from the start. Kept fresh by
      // api/cakemail-sync.js.
      getOrFallback(
        'blast_templates?select=campaign_id,name,list_name,scheduled_for,sent_emails,open_rate,clickthru_rate,email_template,subject,sender&order=scheduled_for.desc&limit=1000',
        'blast_templates?select=campaign_id,name,list_name,scheduled_for,sent_emails,open_rate,clickthru_rate,email_template&order=scheduled_for.desc&limit=1000'),
      get('market_bridge_list?select=list_name,market_key&limit=1000'),
    ]);

    // list_name -> market_key, the same mapping v_blast_scored joins on. A list with no bridge
    // row shows with market null rather than being dropped: an unmapped list is a gap to fix,
    // not a campaign that did not happen.
    const marketOf = new Map(bridge.map(b => [b.list_name, b.market_key]));

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
          notes: [
            c.open_rate != null ? `${Number(c.open_rate).toFixed(1)}% open` : null,
            c.clickthru_rate != null ? `${Number(c.clickthru_rate).toFixed(1)}% CTR` : null,
            mk ? null : `list "${c.list_name || '?'}" not bridged to a market`,
          ].filter(Boolean).join(' · ') || null,
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
    res.status(200).json({ ok: true, rows, counts: { blast_log: blasts.length, salesmsg: broadcasts.length, cakemail: campaigns.length } });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e), rows: [] });
  }
}
