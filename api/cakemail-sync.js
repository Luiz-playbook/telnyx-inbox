// Sync CakeMail send history into Supabase (blast_templates) — the decider's memory of what
// worked in which market.
//
// WHY THIS EXISTS. Cole decides what to blast by scrolling his CakeMail sent list: which
// markets went out this week, which have not been touched in a while, what the open rates
// looked like. The app already holds a snapshot of exactly that — `blast_templates` is a
// CakeMail campaign-report dump feeding v_blast_scored -> v_market_performance ->
// rpc_event_recommendations. But nothing had refreshed it since 2026-06-01: as of 2026-08-01
// the account held 283 delivered campaigns against our 140 rows, so 143 sends were invisible
// to the decider — including the season-opener run Cole walks through in the loom (Iowa
// Hawkeyes, Utah Utes, USC, Pirates suite, Orioles). Markets came back `no_history` because
// the history stopped, not because it did not exist. See migration 047.
//
// Default account is 1679383 (cole@) — the account whose sent list is the real decision input.
// Pass ?account_id= to sync another sub-account; each has its OWN PAT (lib/cakemail.js).
//
// COST SHAPE. The campaign list is 6 calls for the whole account, but list name, subject and
// stats each need a per-campaign call (2 per campaign). A full backfill of 283 campaigns is
// ~570 calls, well past maxDuration. So this endpoint is incremental by default: it fetches
// detail only for campaigns Supabase has never fetched, newest first, capped by ?limit. The
// response reports `remaining` — call again until it hits 0. ?refresh=1 re-fetches rows that
// already have a fetched_at (for restating stats on recent sends, which keep accruing opens).
//
// Verified against the live API on 2026-08-01: status is `delivered` (not `sent`), timestamps
// are epoch seconds, list name only exists on the per-campaign detail call.
//
// Runs on-demand from the UI (x-inbox-secret: REPLY_SECRET) and/or a cron
// (Authorization: Bearer CRON_SECRET). Upserts on campaign_id — safe to call repeatedly.
//
// Env: PBSPORTS_COLE_CAKEMAIL_AUTHORIZATION (+ _ACCOUNT_ID), SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY, optional CRON_SECRET / REPLY_SECRET.

import { listCampaigns, campaignDetail, campaignReport, campaignBody, cakemailTime, cakemailKey, cakemailKeyEnvName } from '../lib/cakemail.js';

export const config = { maxDuration: 60 };

// cole@ — the account Cole actually works out of. Env override so a moved sub-account is a
// deployment change, matching how lib/cakemail.js resolves accounts.
const COLE_ACCOUNT = (process.env.PBSPORTS_COLE_CAKEMAIL_ACCOUNT_ID || '1679383').trim();

// One invocation's work. 60 campaigns ≈ 120 API calls, comfortably inside maxDuration with
// room for slow reports. Raise via ?limit= when running a backfill from a machine that can wait.
const DEFAULT_LIMIT = 60;

const int = v => (v == null || v === '' ? null : Math.trunc(Number(v)));
const dec = v => (v == null || v === '' ? null : Number(v));

// campaign + detail + report -> one blast_templates row.
//
// The report's field names match blast_templates column-for-column because that table was
// originally built from this endpoint — so this is a direct mapping, not a guess. Rates are
// taken as given rather than recomputed: CakeMail's open_rate is against active_emails and
// clickthru_rate is clicks-over-opens, and v_market_performance weights on those exact
// definitions. Deriving our own would silently change what "18% open" means mid-history.
function mapCampaign(c, detail, rep, body, accountId) {
  const d = detail || {};
  const a = d.audience || c.audience || {};
  const content = d.content || {};
  const r = rep || {};

  return {
    campaign_id: String(c.id ?? d.id ?? ''),
    account_id: String(accountId),
    name: d.name ?? c.name ?? null,
    list_id: a.list_id != null ? String(a.list_id) : null,
    // The market handle. Only present on the detail call; market_bridge_list joins on it.
    list_name: a.name ?? null,
    segment_id: a.segment_id != null ? String(a.segment_id) : null,

    // email_template holds the sent BODY — the 140 seeded rows carry Cole's plain-text copy, and
    // Market History renders it as "the copy that was sent". Every 2026 campaign checked was
    // built in CakeMail's editor and has content.text/html null (body lives in a content.json
    // builder blob), so `body` is the rendered-and-stripped fallback from campaignBody(). Never
    // the subject line — that would quietly redefine the column for every existing consumer.
    email_template: content.text || content.html || body || null,

    // The envelope around the copy, so Market History can render a blast the way the Queue
    // does (From / Subject / body) instead of a bare block of text. Sender is formatted for
    // display — "Josh Marcus <josh.marcus@callplaybook.com>", or whichever half exists.
    subject: content.subject || null,
    sender: (() => {
      const s = d.sender || {};
      if (s.name && s.email) return `${s.name} <${s.email}>`;
      return s.name || s.email || null;
    })(),

    show_email_link_url: d.web_email_link ?? c.web_email_link ?? null,

    created_on: cakemailTime(d.created_on ?? c.created_on),
    updated_on: cakemailTime(d.updated_on ?? c.updated_on),
    scheduled_on: cakemailTime(d.scheduled_on ?? c.scheduled_on),
    // What v_market_performance reports as `last_sent`, i.e. the "when did we last hit this
    // market" answer. delivery_finished_on is the truest send instant; scheduled_for is what
    // the existing 140 rows use, so it stays the primary for consistency across the history.
    scheduled_for: cakemailTime(d.scheduled_for ?? c.scheduled_for ?? d.delivery_finished_on ?? c.created_on),

    active_emails: int(r.active_emails),
    sent_emails: int(r.sent_emails),
    opens: int(r.opens),
    unique_opens: int(r.unique_opens),
    unopens: int(r.unopens),
    implied_opens: int(r.implied_opens),
    forwards: int(r.forwards),
    clicks: int(r.clicks),
    unique_clicks: int(r.unique_clicks),
    spams: int(r.spams),
    unsubscribes: int(r.unsubscribes),
    bounces: int(r.bounces),
    bounces_hard: int(r.bounces_hard),
    bounces_soft: int(r.bounces_soft),

    open_rate: dec(r.open_rate),
    click_rate: dec(r.click_rate),
    clickthru_rate: dec(r.clickthru_rate),
    unopen_rate: dec(r.unopen_rate),
    bounce_rate: dec(r.bounce_rate),
    unsubscribe_rate: dec(r.unsubscribe_rate),
    spam_rate: dec(r.spam_rate),
    sent_rate: dec(r.sent_rate),
  };
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET, replySecret = process.env.REPLY_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const inboxOk = replySecret && req.headers['x-inbox-secret'] === replySecret;
  if ((cronSecret || replySecret) && !bearerOk && !inboxOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const accountId = String(req.query?.account_id || COLE_ACCOUNT).trim();
  const dry = req.query?.dry === '1' || req.query?.dry === 'true' || (req.body && req.body.dry === true);
  const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
  const limit = Math.max(1, Math.min(300, Number(req.query?.limit) || DEFAULT_LIMIT));

  const key = cakemailKey(accountId);
  if (!key) { res.status(500).json({ error: `no CakeMail key for account ${accountId} — set ${cakemailKeyEnvName(accountId)} on the server` }); return; }

  const supaUrl = process.env.SUPABASE_URL;
  // upsert_blast_templates is granted to service_role only — blast history is not anon-writable,
  // for the same reason ticketblaster_market_blasts_log is not.
  const supaKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };

  try {
    const campaigns = await listCampaigns({ accountId, key });   // delivered only, newest first

    // What Supabase already has. Rows seeded before the sync existed have fetched_at null and
    // are re-fetched once, because their stats came from a one-off import of unknown vintage.
    const haveRes = await fetch(`${supaUrl}/rest/v1/blast_templates?select=campaign_id,fetched_at&limit=5000`, { headers: sh });
    const have = haveRes.ok ? await haveRes.json().catch(() => []) : [];
    const fetchedAt = new Map((Array.isArray(have) ? have : []).map(r => [String(r.campaign_id), r.fetched_at]));

    const todo = campaigns.filter(c => refresh || !fetchedAt.get(String(c.id)));
    const batch = todo.slice(0, limit);

    // Three calls per campaign (detail, report, rendered body), in small waves — a 283-campaign
    // account must not open 850 sockets at once. Any of the three failing yields null and the
    // upsert's coalesce keeps whatever was already stored.
    const rows = [];
    const WAVE = 6;
    for (let i = 0; i < batch.length; i += WAVE) {
      const slice = batch.slice(i, i + WAVE);
      const got = await Promise.all(slice.map(async c => {
        const id = String(c.id);
        const [detail, rep, body] = await Promise.all([
          campaignDetail(id, { accountId, key }),
          campaignReport(id, { accountId, key }),
          campaignBody(id, { accountId, key }),
        ]);
        return mapCampaign(c, detail, rep, body, accountId);
      }));
      rows.push(...got.filter(x => x.campaign_id));
    }

    if (dry) {
      res.status(200).json({
        ok: true, dry: true, account_id: accountId,
        delivered_in_cakemail: campaigns.length, already_stored: fetchedAt.size,
        would_write: rows.length, remaining: Math.max(0, todo.length - batch.length),
        sample: rows.slice(0, 3),
      });
      return;
    }

    let result = null;
    if (rows.length) {
      const up = await fetch(`${supaUrl}/rest/v1/rpc/upsert_blast_templates`, {
        method: 'POST', headers: sh, body: JSON.stringify({ p_rows: rows }),
      });
      const body = await up.json().catch(() => null);
      if (!up.ok) { res.status(502).json({ error: 'supabase upsert failed', detail: body }); return; }
      result = Array.isArray(body) ? body[0] : body;
    }

    // A campaign whose list has no market_bridge_list row contributes NOTHING to
    // v_market_performance (v_blast_scored inner-joins the bridge), so the market reads as
    // `no_history` while having plenty. Reported, never hidden.
    let unmapped = [];
    const un = await fetch(`${supaUrl}/rest/v1/rpc/blast_templates_unmapped_lists`, { method: 'POST', headers: sh, body: '{}' });
    if (un.ok) unmapped = await un.json().catch(() => []);

    res.status(200).json({
      ok: true, account_id: accountId,
      delivered_in_cakemail: campaigns.length,
      processed: rows.length,
      inserted: result?.inserted ?? 0,
      updated: result?.updated ?? 0,
      remaining: Math.max(0, todo.length - batch.length),
      unmapped_lists: unmapped,
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
