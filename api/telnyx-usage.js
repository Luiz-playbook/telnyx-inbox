// Telnyx 10DLC volume against the carrier cap — what the Market History strip reads.
//
// Answers the question the review call asked: how much of today's allowance have we used, and
// how close have we been over the last fortnight. Telnyx will not answer that directly, so the
// figure is computed here — cached volume from api/telnyx-usage-sync.js, minus nothing, then
// compared to the cap the same sync read back from the brand's vetting score.
//
// THE CAP COUNTS T-MOBILE ONLY. T-Mobile is the carrier that imposes a daily volume limit, and
// it counts only messages bound for its own subscribers. Comparing total outbound to 40,000
// overstates cap usage several times over — measured across 30 days on 2026-09-10, total
// outbound was 89,552 against 14,225 actually T-Mobile-bound. Both are returned, clearly
// separated, because the total is the interesting business number and the T-Mobile figure is
// the one that can get us throttled.
//
// Read-only. Reads through the service role because the underlying tables carry no anon
// policy — same reason api/market-history.js exists rather than the browser reading directly.

import { supabaseKey, supabaseHeaders } from '../lib/supabase.js';
import { gate } from '../lib/auth.js';

export const config = { maxDuration: 30 };

// usage_reports spells it "T-Mobile USA", and has also returned plain "T-Mobile". Matching on
// the prefix rather than an exact string keeps a carrier rename from silently zeroing the one
// number this endpoint exists to report.
const isTmobile = c => /^t-?mobile/i.test(String(c || ''));
// Matched the same loose way and for the same reason: usage_reports returns display names
// ("Verizon Wireless", "AT&T"), and a rename would otherwise silently zero a column.
const isAtt = c => /^at\s*&?\s*t/i.test(String(c || ''));
const isVerizon = c => /^verizon/i.test(String(c || ''));

export default async function handler(req, res) {
  if (!await gate(req, res)) return;

  const supaUrl = process.env.SUPABASE_URL, supaK = supabaseKey();
  if (!supaUrl || !supaK) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }); return; }
  const sh = supabaseHeaders(supaK);
  const get = p => fetch(`${supaUrl}/rest/v1/${p}`, { headers: sh });

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const [uR, sR, bR] = await Promise.all([
      get(`telnyx_usage_daily?select=usage_date,sending_number,carrier,direction,msg_count,segments,cost`
        + `&direction=eq.outbound&usage_date=gte.${since}&order=usage_date.asc&limit=20000`),
      get(`telnyx_senders?select=phone_number,label,active,sort_order,notes,brand_id,tcr_campaign_id,assignment_status&order=sort_order.asc`),
      get(`telnyx_brands?select=brand_id,tcr_brand_id,brand_name,vetting_score,tmo_daily_cap,att_tpm,identity_status,checked_at`),
    ]);
    for (const r of [uR, sR, bR]) {
      if (!r.ok) { res.status(502).json({ error: 'supabase read failed', detail: (await r.text()).slice(0, 400) }); return; }
    }
    const usage = await uR.json(), senders = await sR.json(), brands = await bR.json();

    // THE CAP IS PER BRAND, so the comparison has to be too. An earlier cut compared all
    // volume to the lowest cap on the account and read Playbook's 1,416 T-Mobile messages
    // against NYC Basketball's 2,000 — 70.8% of allowance, when the real figure against
    // Playbook's own 40,000 was 3.5%. Volume is attributed through the sending number's brand
    // and each brand is measured against its own allowance.
    const brandById = {};
    brands.forEach(b => { brandById[b.brand_id] = b; });

    const labelFor = {}, brandFor = {};
    senders.forEach(s => {
      labelFor[s.phone_number] = s.label;
      brandFor[s.phone_number] = s.brand_id || null;
    });

    // A number on no campaign has no allowance to draw on — it is an unregistered long code,
    // filtered by carriers and capped at 0.1 MPS by the number itself. Its traffic is still
    // counted and shown; it just cannot be charged against a brand.
    const UNASSIGNED = '__unassigned__';

    // ── Per day, per brand ────────────────────────────────────────────────────
    // Day totals stay account-wide (that is the business number), but cap pressure is tracked
    // per brand and the day's headline percentage is the WORST brand on that day — the one
    // closest to being throttled.
    const dayMap = new Map();
    for (const r of usage) {
      const d = String(r.usage_date).slice(0, 10);
      const cur = dayMap.get(d) || { date: d, total: 0, tmobile: 0, segments: 0, cost: 0, perBrand: {} };
      const n = Number(r.msg_count) || 0;
      cur.total += n;
      cur.segments += Number(r.segments) || 0;
      cur.cost += Number(r.cost) || 0;
      if (isTmobile(r.carrier)) {
        cur.tmobile += n;
        const bid = brandFor[r.sending_number] || UNASSIGNED;
        cur.perBrand[bid] = (cur.perBrand[bid] || 0) + n;
      }
      dayMap.set(d, cur);
    }

    // Worst utilisation across the brands that sent that day, and which brand it was.
    const worstOn = pb => {
      let pct = 0, who = null;
      for (const [bid, n] of Object.entries(pb || {})) {
        const b = brandById[bid];
        if (!b) continue;                       // unassigned traffic draws on no allowance
        const c = Number(b.tmo_daily_cap) || 0;
        if (!c) continue;
        const p = n / c * 100;
        if (p > pct) { pct = p; who = b; }
      }
      return { pct: +pct.toFixed(2), brand: who };
    };

    // Gap-fill. A day with no sends must render as a zero bar, not vanish and let the strip
    // imply the days either side were adjacent.
    const byDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const v = dayMap.get(d) || { date: d, total: 0, tmobile: 0, segments: 0, cost: 0, perBrand: {} };
      const w = worstOn(v.perBrand);
      byDay.push({
        date: v.date, total: v.total, tmobile: v.tmobile, segments: v.segments,
        cost: Number(v.cost.toFixed(4)),
        pct_of_cap: w.pct,
        worst_brand: w.brand ? w.brand.brand_name : null,
      });
    }

    // ── Per brand, over the window ────────────────────────────────────────────
    const brandRows = brands.map(b => {
      const nums = senders.filter(s => s.brand_id === b.brand_id).map(s => s.phone_number);
      const set = new Set(nums);
      let tmo = 0, total = 0;
      for (const r of usage) {
        if (!set.has(r.sending_number)) continue;
        const n = Number(r.msg_count) || 0;
        total += n;
        if (isTmobile(r.carrier)) tmo += n;
      }
      const peakDay = byDay.reduce((m, d) => {
        const n = (dayMap.get(d.date) || { perBrand: {} }).perBrand[b.brand_id] || 0;
        return n > (m ? m.n : -1) ? { date: d.date, n } : m;
      }, null);
      return {
        brand_id: b.brand_id, brand: b.brand_name,
        vetting_score: b.vetting_score, tmobile_daily_cap: b.tmo_daily_cap, att_tpm: b.att_tpm,
        numbers: nums.length, total, tmobile: tmo,
        peak_day: peakDay ? peakDay.date : null,
        peak_tmobile: peakDay ? peakDay.n : 0,
        peak_pct_of_cap: peakDay && b.tmo_daily_cap ? +(peakDay.n / b.tmo_daily_cap * 100).toFixed(2) : 0,
        checked_at: b.checked_at,
      };
    }).sort((a, b) => b.peak_pct_of_cap - a.peak_pct_of_cap);

    // Brands that sent nothing in the window are dropped. A registered brand with no traffic
    // is a fact about the Telnyx account, not about our sending, and listing it invites the
    // reader to compare a live brand's volume against an idle brand's cap. The moment
    // anything sends on it, it reappears — which is the warning that matters, because the
    // second brand's ceiling is 2,000/day against Playbook's 40,000.
    const activeBrands = brandRows.filter(b => b.total > 0);

    // The strip's headline brand is whichever is closest to its own ceiling.
    const capBrand = activeBrands[0] || brandRows.find(b => b.numbers > 0) || brandRows[0] || null;
    const cap = capBrand ? Number(capBrand.tmobile_daily_cap) || 0 : 0;

    // ── Per carrier, over the window ──────────────────────────────────────────
    // Only T-Mobile has a daily cap to spend, so only T-Mobile drives the headline. This
    // breakdown exists so the gap between "sent" and "T-Mobile" is legible rather than
    // looking like messages went missing: everything not in the T-Mobile row went to a
    // carrier that imposes no daily ceiling.
    // `today` is tracked alongside the window total so the uncapped carriers can still answer
    // "how many have we sent already" — they have no allowance to measure against, but the
    // running count is a real question and the data is per-day anyway.
    const todayKey = byDay.length ? byDay[byDay.length - 1].date : null;
    const carrierMap = new Map();
    for (const r of usage) {
      const name = String(r.carrier || '').trim() || 'unidentified';
      const cur = carrierMap.get(name) || { carrier: name, total: 0, today: 0, segments: 0, capped: false };
      const n = Number(r.msg_count) || 0;
      cur.total += n;
      if (todayKey && String(r.usage_date).slice(0, 10) === todayKey) cur.today += n;
      cur.segments += Number(r.segments) || 0;
      cur.capped = isTmobile(name);
      carrierMap.set(name, cur);
    }
    const byCarrier = [...carrierMap.values()].sort((a, b) => b.total - a.total);
    const carrierTotal = byCarrier.reduce((s, c) => s + c.total, 0);
    byCarrier.forEach(c => { c.share = carrierTotal ? +(c.total / carrierTotal * 100).toFixed(1) : 0; });

    // ── Per inbox ─────────────────────────────────────────────────────────────
    const inboxMap = new Map();
    for (const r of usage) {
      const tn = r.sending_number;
      const s = senders.find(x => x.phone_number === tn);
      const cur = inboxMap.get(tn) || {
        number: tn,
        // A label equal to the number itself is the sync's placeholder for a number nobody
        // has named — treat it as unlabelled so the UI can flag it.
        label: (labelFor[tn] && labelFor[tn] !== tn) ? labelFor[tn] : null,
        brand: s && s.brand_id && brandById[s.brand_id] ? brandById[s.brand_id].brand_name : null,
        campaign: (s && s.tcr_campaign_id) || null,
        registered: !!(s && s.brand_id),
        total: 0, tmobile: 0, att: 0, verizon: 0, other: 0, segments: 0,
      };
      const n = Number(r.msg_count) || 0;
      cur.total += n;
      cur.segments += Number(r.segments) || 0;
      // Split by carrier so an inbox can be read on its own terms. The big three get their own
      // buckets because they are ~70% of traffic and are the ones anyone asks about; the
      // remaining dozen-plus carriers are summed into `other` rather than given columns nobody
      // would read. Only the T-Mobile bucket has a cap behind it.
      if (isTmobile(r.carrier)) cur.tmobile += n;
      else if (isAtt(r.carrier)) cur.att += n;
      else if (isVerizon(r.carrier)) cur.verizon += n;
      else cur.other += n;
      inboxMap.set(tn, cur);
    }
    // A number that sent nothing still belongs in the list — "Marketing sent 0" is a fact
    // someone may be checking for, and omitting it looks like the inbox does not exist.
    for (const s of senders) {
      if (s.active && !inboxMap.has(s.phone_number)) {
        inboxMap.set(s.phone_number, {
          number: s.phone_number,
          label: s.label !== s.phone_number ? s.label : null,
          brand: s.brand_id && brandById[s.brand_id] ? brandById[s.brand_id].brand_name : null,
          campaign: s.tcr_campaign_id || null,
          registered: !!s.brand_id,
          total: 0, tmobile: 0, segments: 0,
        });
      }
    }
    const byInbox = [...inboxMap.values()].sort((a, b) => b.total - a.total);

    const today = byDay[byDay.length - 1] || null;
    // Peak by CAP PRESSURE, not by raw volume — a heavy day on a well-vetted brand matters
    // less than a light one on a brand capped at 2,000.
    const peak = byDay.reduce((m, d) => (d.pct_of_cap > (m ? m.pct_of_cap : -1) ? d : m), null);

    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      ok: true,
      days,
      // The cap and where it came from — so the strip can say "40,000, from a vetting score of
      // 63 checked on <date>" rather than presenting a bare number nobody can audit.
      cap: {
        tmobile_daily: cap,
        brand: capBrand ? capBrand.brand : null,
        vetting_score: capBrand ? capBrand.vetting_score : null,
        att_tpm: capBrand ? capBrand.att_tpm : null,
        checked_at: capBrand ? capBrand.checked_at : null,
      },
      today,
      peak,
      by_day: byDay,
      by_brand: activeBrands,
      // Registered brands with no traffic in the window — reported so the UI can say how many
      // were left out, rather than silently shortening the table.
      idle_brands: brandRows.filter(b => b.total === 0).map(b => b.brand),
      by_carrier: byCarrier,
      by_inbox: byInbox,
      // Named so nobody reads this strip as total SMS reach: the Salesmsg route in
      // api/queue-tick.js never touches Telnyx and cannot appear here at any date range.
      excludes: 'Salesmsg — sent through Salesmsg’s own 10DLC brand, not visible to Telnyx.',
    });
  } catch (e) {
    res.status(502).json({ error: 'telnyx usage read failed', detail: String((e && e.message) || e) });
  }
}
