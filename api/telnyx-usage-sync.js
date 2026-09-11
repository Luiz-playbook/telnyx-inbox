// Pull Telnyx messaging volume and the current carrier caps into Supabase.
//
// Telnyx exposes what a brand is ALLOWED to send and never what it has sent against that
// allowance — there is no consumption endpoint and no "remaining" figure anywhere in the API.
// So this route does the subtraction's first half: it counts what went out, per day, per
// sending number, per carrier, and caches it. api/telnyx-usage.js does the comparing.
//
// It also refreshes the caps themselves. The cap is not a number Telnyx returns: it returns a
// vetting score, and the carriers publish a band table that turns that score into a
// messages-per-day and a segments-per-minute limit. Re-reading the score every night is what
// stops the strip quoting a figure from memory — ours already moved once (16 -> 63 on
// 2026-06-09, taking the daily cap from 2,000 to 40,000) and nothing in the app noticed.
//
// Runs from Vercel Cron (Authorization: Bearer CRON_SECRET) or on demand from a signed-in
// Playbook account. Upserts on the natural key, so calling it repeatedly is safe and
// backfilling is just a bigger ?days=.
//
// Env: TELNYX_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional CRON_SECRET.

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';

export const config = { maxDuration: 60 };

const TELNYX = 'https://api.telnyx.com/v2';

// Carrier band table — Telnyx, "Improve 10DLC Rate Limits With Better Trust Scores".
// The score is the only thing the API gives us; these two numbers are looked up from it.
// An unvetted brand (no vetting records at all) sits at the bottom band, not at zero.
export function limitsForScore(score) {
  if (score == null || !Number.isFinite(score)) return { tmo: 2000, att: 240 };
  if (score >= 75) return { tmo: 200000, att: 4500 };
  if (score >= 50) return { tmo: 40000, att: 2400 };
  if (score >= 25) return { tmo: 10000, att: 240 };
  return { tmo: 2000, att: 240 };
}

// Retried, because one run makes dozens of calls — a usage window per 30 days, then one per
// distinct sending number — and a single transient `fetch failed` on any of them would
// otherwise lose the whole night. Seen live on 2026-09-11: the same request 502'd twice and
// then succeeded unchanged.
//
// Only connection failures and 5xx are retried. A 4xx is the API telling us the request is
// wrong, and repeating it just delays the error by three seconds.
const telnyxGet = async (path, key, attempt = 0) => {
  let r, body;
  try {
    r = await fetch(`${TELNYX}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    body = await r.text();
  } catch (e) {
    if (attempt >= 2) throw new Error(`Telnyx ${path} -> ${String((e && e.message) || e)}`);
    await new Promise(s => setTimeout(s, 400 * (attempt + 1)));
    return telnyxGet(path, key, attempt + 1);
  }
  if (r.status >= 500 && attempt < 2) {
    await new Promise(s => setTimeout(s, 400 * (attempt + 1)));
    return telnyxGet(path, key, attempt + 1);
  }
  if (!r.ok) throw new Error(`Telnyx ${path} -> ${r.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
};

// Telnyx refuses ANY usage_reports interval longer than 31 days, whichever way it is
// expressed — `date_range=last_31_days` answers 400 `10006 Invalid date_range interval`, and
// an explicit start/end more than 31 days apart answers 400 `10004 Invalid date/time
// interval`. Verified against the live API on 2026-09-11. So a backfill is not one big call:
// it is a series of windows, walked backwards from today.
const MAX_WINDOW_DAYS = 30;   // one under the limit, so an off-by-one at a month boundary cannot trip it
const DAY_MS = 86400000;

// usage_reports also pages at 20 by default. A sync that ignores meta.total_pages does not
// fail — it silently reports a fraction of the volume, which is the worst possible failure
// for a number someone is about to trust. Follow every page of every window.
async function usageReport(key, dimensions, metrics, days) {
  const rows = [];
  const now = Date.now();

  for (let offset = 0; offset < days; offset += MAX_WINDOW_DAYS) {
    const span = Math.min(MAX_WINDOW_DAYS, days - offset);
    const start = new Date(now - (offset + span - 1) * DAY_MS).toISOString().slice(0, 10);
    // END IS EXCLUSIVE, per Telnyx's own docs ("Start date inclusive; end date exclusive").
    // Passing the last day at 23:59:59 therefore drops anything sent in that final second, so
    // the bound is midnight on the NEXT day instead. That still leaves a 30-day span for a
    // 30-day window, safely inside the 31-day maximum.
    const endExclusive = new Date(now - (offset - 1) * DAY_MS).toISOString().slice(0, 10);

    let page = 1, totalPages = 1;
    do {
      const qs = new URLSearchParams({
        product: 'messaging',
        dimensions: dimensions.join(','),
        metrics: metrics.join(','),
        start_date: `${start}T00:00:00Z`,
        end_date: `${endExclusive}T00:00:00Z`,
        'page[number]': String(page),
        'page[size]': '500',
      });
      // NOTE: filter[x] is rejected unless x is one of the dimensions already selected —
      // `filter[direction]` with dimensions=date answers 400 `10007 Invalid dimensions_filter
      // value`. Direction is therefore a dimension here and the filtering happens below.
      const j = await telnyxGet(`/usage_reports?${qs}`, key);
      if (j && Array.isArray(j.data)) rows.push(...j.data);
      totalPages = (j && j.meta && j.meta.total_pages) || 1;
      page += 1;
    } while (page <= totalPages && page <= 40);
  }
  return rows;
}

// Every brand on the account, with its vetting score resolved to carrier limits.
async function readBrands(key) {
  const list = await telnyxGet('/10dlc/brand?page=1&recordsPerPage=100', key);
  const records = (list && list.records) || [];
  const out = [];
  for (const b of records) {
    // A mock brand is a registration that never completed — it holds no campaigns and no
    // allowance. Storing it would put a phantom 2,000/day cap in the UI.
    if (b.mock) continue;
    let score = null;
    try {
      const vets = await telnyxGet(`/10dlc/brand/${b.brandId}/externalVetting`, key);
      const rows = Array.isArray(vets) ? vets : (vets && vets.records) || [];
      // Highest ACTIVE score wins — a brand can carry several vettings from different
      // vendors, and ours does: WMC scored 63 while Aegis scored 16 twice.
      const scores = rows
        .filter(v => !v.vettingStatus || String(v.vettingStatus).toUpperCase() === 'ACTIVE')
        .map(v => Number(v.vettingScore))
        .filter(Number.isFinite);
      if (scores.length) score = Math.max(...scores);
    } catch { /* an unvettable brand is unvetted, which is a real answer */ }
    const lim = limitsForScore(score);
    out.push({
      brand_id: b.brandId,
      tcr_brand_id: b.tcrBrandId || null,
      brand_name: b.displayName || b.companyName || null,
      vetting_score: score,
      tmo_daily_cap: lim.tmo,
      att_tpm: lim.att,
      identity_status: b.identityStatus || null,
      checked_at: new Date().toISOString(),
    });
  }
  return out;
}

// Which brand each sending number draws its allowance from.
//
// usage_reports knows nothing about brands, so this is the join that makes per-brand
// reporting possible at all. Numbers that answer 404 are recorded with a null brand rather
// than skipped: an unregistered long code sending traffic is the finding, not a gap.
async function readSenderBrands(key, numbers) {
  const out = [];
  for (const tn of numbers) {
    let row = {
      phone_number: tn,
      brand_id: null, tcr_brand_id: null, tcr_campaign_id: null, assignment_status: null,
      brand_checked_at: new Date().toISOString(),
    };
    try {
      const a = await telnyxGet(`/10dlc/phone_number_campaigns/${encodeURIComponent(tn)}`, key);
      if (a) {
        row.brand_id = a.brandId || null;
        row.tcr_brand_id = a.tcrBrandId || null;
        row.tcr_campaign_id = a.tcrCampaignId || null;
        row.assignment_status = a.assignmentStatus || null;
      }
    } catch { /* 404 = on no campaign, which the nulls already say */ }
    out.push(row);
  }
  return out;
}

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  const key = (process.env.TELNYX_API_KEY || '').trim();
  if (!key) { res.status(500).json({ error: 'TELNYX_API_KEY is not set on the server' }); return; }

  const supaUrl = process.env.SUPABASE_URL, supaK = supabaseKey();
  if (!supaUrl || !supaK) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const sh = supabaseHeaders(supaK);

  // 30 days by default — one Telnyx window, and the last month is what the strip reports on.
  // Because every run re-fetches the whole window and upserts, a missed night repairs itself
  // on the next run with no catch-up job. Longer ranges are chunked (see usageReport), so
  // ?days=90 works for a one-off backfill.
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);

  try {
    const raw = await usageReport(
      key,
      ['date', 'tn', 'direction', 'normalized_carrier'],
      ['count', 'parts', 'cost'],
      days,
    );

    // Collapse to the primary key. Telnyx can return the same tuple more than once across
    // pages when a day is still settling, and a plain map would keep only the last of them.
    const byKey = new Map();
    for (const r of raw) {
      const date = String(r.date || '').slice(0, 10);
      const tn = String(r.tn || '').trim();
      const dir = String(r.direction || '').trim();
      if (!date || !tn || (dir !== 'inbound' && dir !== 'outbound')) continue;
      const carrier = String(r.normalized_carrier == null ? '' : r.normalized_carrier);
      const k = `${date}|${tn}|${carrier}|${dir}`;
      const prev = byKey.get(k);
      const row = prev || {
        usage_date: date, sending_number: tn, carrier, direction: dir,
        msg_count: 0, segments: 0, cost: 0,
      };
      row.msg_count += Number(r.count) || 0;
      row.segments += Number(r.parts) || 0;
      row.cost += Number(r.cost) || 0;
      byKey.set(k, row);
    }
    const rows = [...byKey.values()].map(r => ({ ...r, cost: Number(r.cost.toFixed(4)) }));

    // Chunked so one oversized request cannot fail the whole night's sync.
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const up = await fetch(`${supaUrl}/rest/v1/telnyx_usage_daily`, {
        method: 'POST',
        headers: { ...sh, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk),
      });
      if (!up.ok) {
        const detail = await up.text();
        res.status(502).json({ error: 'supabase upsert failed (usage)', detail: detail.slice(0, 500) });
        return;
      }
      written += chunk.length;
    }

    // Every number that actually sent, mapped to its brand. Discovering them from the traffic
    // rather than from telnyx_senders means a number nobody has labelled still gets attributed
    // to the right allowance — and shows up in the strip as unlabelled, which is the point.
    let senderError = null;
    try {
      const seen = [...new Set(rows.filter(r => r.direction === 'outbound').map(r => r.sending_number))];
      const senderRows = await readSenderBrands(key, seen);
      if (senderRows.length) {
        // A number seen in traffic may have no telnyx_senders row yet, so this has to insert
        // as well as update. label is NOT NULL, so a discovered number gets its own digits as
        // a placeholder — visibly unnamed rather than silently absent.
        const withLabel = senderRows.map(r => ({ ...r, label: r.phone_number }));
        const ins = await fetch(`${supaUrl}/rest/v1/telnyx_senders?on_conflict=phone_number`, {
          method: 'POST',
          headers: { ...sh, Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(withLabel),
        });
        if (!ins.ok) senderError = (await ins.text()).slice(0, 300);

        // Then refresh the brand columns on every one of them, leaving any human-set label
        // alone — an insert that ignored duplicates cannot have updated an existing row.
        for (const r of senderRows) {
          const q = `phone_number=eq.${encodeURIComponent(r.phone_number)}`;
          const up = await fetch(`${supaUrl}/rest/v1/telnyx_senders?${q}`, {
            method: 'PATCH',
            headers: { ...sh, Prefer: 'return=minimal' },
            body: JSON.stringify({
              brand_id: r.brand_id, tcr_brand_id: r.tcr_brand_id,
              tcr_campaign_id: r.tcr_campaign_id, assignment_status: r.assignment_status,
              brand_checked_at: r.brand_checked_at,
            }),
          });
          if (!up.ok && !senderError) senderError = (await up.text()).slice(0, 300);
        }
      }
    } catch (e) { senderError = String((e && e.message) || e); }

    // Caps last: a failure here must not lose the volume already written above.
    let brands = [];
    let brandError = null;
    try {
      brands = await readBrands(key);
      if (brands.length) {
        const up = await fetch(`${supaUrl}/rest/v1/telnyx_brands`, {
          method: 'POST',
          headers: { ...sh, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(brands),
        });
        if (!up.ok) brandError = (await up.text()).slice(0, 300);
      }
    } catch (e) { brandError = String((e && e.message) || e); }

    res.status(200).json({
      ok: true,
      days,
      usage_rows: written,
      brands: brands.map(b => ({
        name: b.brand_name, score: b.vetting_score, tmo_daily_cap: b.tmo_daily_cap,
      })),
      // Reported rather than thrown: the volume is in, and a stale cap is a smaller problem
      // than a sync that looks like it never ran.
      brand_error: brandError,
      sender_error: senderError,
    });
  } catch (e) {
    res.status(502).json({ error: 'telnyx usage sync failed', detail: String((e && e.message) || e) });
  }
}
