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
// COVERS EVERY REAL SENDING ACCOUNT, not just one. Cole's (1679383) is where the history lives
// today; production (1761047) is where sends moved on 2026-07-31, so reading only Cole's would
// start losing blasts as the team finishes moving across. Each account has its OWN PAT
// (lib/cakemail.js) and its id is stored per row, so they merge into one history.
//
// ?account_id= takes one id or a comma-separated list to override that. The pbtest sub-account
// is excluded by default — see HISTORY_ACCOUNTS.
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
import { gate } from '../lib/auth.js';

export const config = { maxDuration: 60 };

// cole@ — the account Cole actually works out of. Env override so a moved sub-account is a
// deployment change, matching how lib/cakemail.js resolves accounts.
const COLE_ACCOUNT = (process.env.PBSPORTS_COLE_CAKEMAIL_ACCOUNT_ID || '1679383').trim();

// josh.marcus@ — the production sender. Sends moved here on 2026-07-31 (see lib/cakemail.js),
// so a history that only ever read cole@ would start losing real blasts the moment the team
// finishes moving across. It holds one campaign today; that is a reason to wire it now, while
// the gap is nothing, rather than to notice later.
const PROD_ACCOUNT = (process.env.PBSPORTS_CAKEMAIL_ACCOUNT_ID || '1761047').trim();

// Which accounts a plain call covers. AI-970 asks for EVERY CakeMail blast, and "every" spans
// sub-accounts — the account id is stored per row, so they merge into one history cleanly.
//
// PBTESTACCOUNT is deliberately NOT here. Its six sends are QA — "[QA] send-path test",
// "[TEST] nationals — Test Market ZZ" — and this table is the decider's memory of what worked
// in which market. Test traffic in it would weight v_market_performance with sends to nobody.
// Pass ?account_id=1679456 to pull it deliberately.
const HISTORY_ACCOUNTS = [...new Set([COLE_ACCOUNT, PROD_ACCOUNT].filter(Boolean))];

// One invocation's work.
//
// MEASURED, not estimated (2026-09-08, live account, 302 delivered): 40 campaigns complete in
// ~10s, and a 5-campaign run also takes ~11s — so the cost is almost entirely FIXED, not
// per-campaign. listCampaigns pages the whole account before anything else happens, and the
// per-campaign detail/report/body calls run six wide. A bigger batch is therefore cheaper per
// campaign, not dearer: the original 60 fits in ~12s against a 60s ceiling with room to spare.
//
// (An earlier revision of this comment cut the limit to 20 on the strength of the 5-campaign
// run alone, reading its fixed overhead as a 2.3s-per-campaign rate. It is not; the numbers
// above are what the loop actually does.)
//
// The deadline guard below is what really protects the invocation, so a slow CakeMail day costs
// a smaller batch rather than a killed run. `remaining` says how much is left — call again
// until it reads 0.
const DEFAULT_LIMIT = 60;

// Stop STARTING new work with enough margin left to upsert what is already in hand, ask for the
// unmapped list and answer. A killed invocation writes nothing at all, so finishing small beats
// being cut off — the same shape as the deadline in api/price-refresh.js.
const SOFT_DEADLINE_MS = 45_000;
const WRITE_MARGIN_MS = 10_000;

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
  if (!await gate(req, res)) return;

  // ?account_id= takes one id or a comma-separated list; omitted, it covers HISTORY_ACCOUNTS.
  const asked = String(req.query?.account_id || '').split(',').map(x => x.trim()).filter(Boolean);
  const accountIds = asked.length ? [...new Set(asked)] : HISTORY_ACCOUNTS;
  const dry = req.query?.dry === '1' || req.query?.dry === 'true' || (req.body && req.body.dry === true);
  const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
  const limit = Math.max(1, Math.min(300, Number(req.query?.limit) || DEFAULT_LIMIT));

  // A missing key for ONE account is reported and skipped, not fatal. Failing the whole run
  // because a second sub-account is unconfigured would stop Cole's history — the one that
  // matters most — for a reason unrelated to it.
  const usable = [], keyless = [];
  for (const id of accountIds) {
    if (cakemailKey(id)) usable.push(id);
    else keyless.push({ account_id: id, needs: cakemailKeyEnvName(id) });
  }
  if (!usable.length) {
    res.status(500).json({ error: 'no CakeMail key for any requested account', accounts: keyless });
    return;
  }

  const supaUrl = process.env.SUPABASE_URL;
  // upsert_blast_templates is granted to service_role only — blast history is not anon-writable,
  // for the same reason ticketblaster_market_blasts_log is not.
  const supaKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };

  const startedAt = Date.now();
  const deadline = startedAt + SOFT_DEADLINE_MS - WRITE_MARGIN_MS;

  try {
    // What Supabase already has, across EVERY account — campaign ids are unique per CakeMail
    // instance, so one map serves all of them and the "already fetched" test does not care
    // which sub-account a row came from.
    const haveRes = await fetch(`${supaUrl}/rest/v1/blast_templates?select=campaign_id,fetched_at&limit=5000`, { headers: sh });
    const have = haveRes.ok ? await haveRes.json().catch(() => []) : [];
    const fetchedAt = new Map((Array.isArray(have) ? have : []).map(r => [String(r.campaign_id), r.fetched_at]));

    // Accounts are walked in order and share ONE budget — the limit and the deadline are per
    // invocation, not per account, or two accounts would together take twice the ceiling. The
    // first account therefore gets first call on the batch; `remaining` covers all of them, so
    // repeated calls drain them in turn.
    const rows = [];
    const perAccount = [];
    let deliveredTotal = 0, remainingTotal = 0, ranOutOfTime = false;
    const WAVE = 6;

    for (const accountId of usable) {
      const key = cakemailKey(accountId);
      let campaigns = [];
      try {
        campaigns = await listCampaigns({ accountId, key });      // delivered only, newest first
      } catch (e) {
        // One account's list failing must not lose the others' work; it is reported instead.
        perAccount.push({ account_id: accountId, error: String((e && e.message) || e) });
        continue;
      }
      deliveredTotal += campaigns.length;

      const todo = campaigns.filter(c => refresh || !fetchedAt.get(String(c.id)));
      const room = Math.max(0, limit - rows.length);
      const batch = ranOutOfTime ? [] : todo.slice(0, room);
      remainingTotal += Math.max(0, todo.length - batch.length);

      // Three calls per campaign (detail, report, rendered body), in small waves — a 300-campaign
      // account must not open 900 sockets at once. Any of the three failing yields null and the
      // upsert's coalesce keeps whatever was already stored.
      let took = 0;
      for (let i = 0; i < batch.length; i += WAVE) {
        // Drain rather than start: whatever has been fetched is still worth writing, and the
        // caller is told what was not reached so it can simply call again.
        if (Date.now() > deadline) {
          ranOutOfTime = true;
          remainingTotal += batch.length - i;
          break;
        }
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
        const kept = got.filter(x => x.campaign_id);
        rows.push(...kept);
        took += kept.length;
      }
      perAccount.push({ account_id: accountId, delivered: campaigns.length, fetched: took, outstanding: Math.max(0, todo.length - took) });
    }

    if (dry) {
      res.status(200).json({
        ok: true, dry: true, accounts: perAccount,
        delivered_in_cakemail: deliveredTotal, already_stored: fetchedAt.size,
        would_write: rows.length, remaining: remainingTotal,
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
      ok: true,
      // Per account, so a sub-account quietly returning nothing is visible rather than absorbed
      // into a single total — the failure mode this whole ticket is about.
      accounts: perAccount,
      keyless: keyless.length ? keyless : undefined,
      delivered_in_cakemail: deliveredTotal,
      processed: rows.length,
      inserted: result?.inserted ?? 0,
      updated: result?.updated ?? 0,
      remaining: remainingTotal,
      timed_out: ranOutOfTime || undefined,
      unmapped_lists: unmapped,
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
