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

  // PostgREST caps a response at its configured max-rows (1,000 here) no matter what `limit=`
  // asks for, and it truncates the END of an ordered result. Reading usage that way silently
  // dropped the newest days — 2026-09-16 and 09-17 read as zero while the table held 4,948 and
  // 173, and 09-15 came back 6,066 against a true 6,145. A usage report that quietly undercounts
  // is worse than one that errors, so every range read is paged to exhaustion.
  const PAGE = 1000;
  async function getAll(path) {
    const out = [];
    for (let offset = 0; offset < 200000; offset += PAGE) {
      const r = await get(`${path}&limit=${PAGE}&offset=${offset}`);
      if (!r.ok) return { ok: false, res: r };
      const batch = await r.json();
      if (!Array.isArray(batch)) return { ok: false, res: r };
      out.push(...batch);
      if (batch.length < PAGE) break;
    }
    return { ok: true, rows: out };
  }

  // PERIOD SELECTION (AI-1004). ?period=day|month with ?offset=0 for the current one, 1 for the
  // one before it, and so on. ?days=N is kept for the rolling window the compliance strip has
  // always drawn, and stays the default so nothing that already calls this changes shape.
  //
  // ET, like the rest of Playbook (AI-1004). Days are counted Eastern; only the allowance, which
  // the carrier resets at midnight UTC, is still grouped by UTC day — both come from the same
  // hourly rows, and the response says which is which.
  const ET = 'America/New_York';
  const etYmd = d => d.toLocaleDateString('en-CA', { timeZone: ET });
  // The UTC instant of ET midnight for a given ET date. The offset is -4 or -5 depending on DST,
  // so rather than hardcode either, try both and keep the one that really is that day's first hour.
  const etMidnightUtc = dstr => {
    for (const off of [4, 5]) {
      const t = new Date(Date.parse(dstr + 'T00:00:00Z') + off * 3600000);
      if (etYmd(t) === dstr && etYmd(new Date(t.getTime() - 1)) !== dstr) return t;
    }
    return new Date(Date.parse(dstr + 'T05:00:00Z'));
  };
  const etShift = (dstr, deltaDays) => etYmd(new Date(etMidnightUtc(dstr).getTime() + deltaDays * 86400000 + 43200000));
  const ymd = d => d.toISOString().slice(0, 10);
  const period = String(req.query.period || '').toLowerCase();
  const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 24);
  const nowUtc = new Date();
  const todayUtc = etYmd(nowUtc);      // "today" means today in ET, as everywhere else in the app

  let since, until, periodMeta;
  if (period === 'day' || period === 'month') {
    if (period === 'day') {
      since = until = etShift(todayUtc, -offset);
    } else {
      const [y, m] = todayUtc.split('-').map(Number);
      const firstOfMonth = new Date(Date.UTC(y, m - 1 - offset, 1));
      const lastOfMonth = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth() + 1, 0));
      since = ymd(firstOfMonth);
      // A month in progress ends today: quoting a month-end date for a period still running
      // invites reading a part-month total as the whole month.
      until = ymd(lastOfMonth) > todayUtc ? todayUtc : ymd(lastOfMonth);
    }
    periodMeta = { kind: period, offset, start: since, end: until, current: offset === 0, days: Math.round((Date.parse(until) - Date.parse(since)) / 86400000) + 1 };
  } else {
    const d = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
    since = etShift(todayUtc, -(d - 1));
    until = todayUtc;
    periodMeta = { kind: 'rolling', offset: 0, start: since, end: until, current: true, days: d };
  }
  const days = periodMeta.days;

  try {
    const [uR, sR, bR, fR, oR] = await Promise.all([
      // Hourly (migration 078) is what makes ET days possible: whole UTC days cannot be re-cut.
      // The ET window is converted to the UTC instants that bound it.
      getAll(`telnyx_usage_hourly?select=usage_hour,sending_number,carrier,direction,msg_count,segments,cost`
        + `&direction=eq.outbound&usage_hour=gte.${etMidnightUtc(since).toISOString()}`
        + `&usage_hour=lt.${new Date(etMidnightUtc(until).getTime() + 86400000).toISOString()}`
        + `&order=usage_hour.asc`),
      get(`telnyx_senders?select=phone_number,label,active,sort_order,notes,brand_id,tcr_campaign_id,assignment_status&order=sort_order.asc`),
      get(`telnyx_brands?select=brand_id,tcr_brand_id,brand_name,vetting_score,tmo_daily_cap,att_tpm,identity_status,checked_at`),
      // How current the cache is, regardless of which period is being viewed. Without it a quiet
      // period and a sync that stopped running look identical — which is exactly how the nightly
      // sync sat dead for a week before AI-1004.
      get(`telnyx_usage_hourly?select=usage_hour&order=usage_hour.desc&limit=1`),
      // The OLDEST hour held. The sync keeps a rolling window (30 days by default), so a period
      // reaching further back is not quiet — it is unsynced, and would otherwise render as a real
      // but much smaller total. Measured: August read 34,764 against the 53,670 the daily table had.
      get(`telnyx_usage_hourly?select=usage_hour&order=usage_hour.asc&limit=1`),
    ]);
    for (const r of [sR, bR]) {
      if (!r.ok) { res.status(502).json({ error: 'supabase read failed', detail: (await r.text()).slice(0, 400) }); return; }
    }
    const senders = await sR.json(), brands = await bR.json();
    // Null when migration 078 has not run, which the UI reads as "no hourly data yet".
    const usageThrough = fR.ok ? ((await fR.json())[0] || {}).usage_hour || null : null;
    const usageFrom = oR.ok ? ((await oR.json())[0] || {}).usage_hour || null : null;

    // Hourly is preferred; the daily table is the fallback for a database where migration 078 has
    // not run yet. Falling back silently would be worse than the UTC days it returns, so the basis
    // is reported and the UI says which one it is looking at.
    let usage = [], dayBasis = 'et';
    if (uR.ok) {
      usage = uR.rows.map(r => ({
        ...r,
        // The ET day this hour belongs to, and the UTC day the carrier counts it against.
        usage_date: etYmd(new Date(r.usage_hour)),
        cap_date: String(r.usage_hour).slice(0, 10),
      }));
    }
    if (!uR.ok || !usage.length) {
      const dR = await getAll(`telnyx_usage_daily?select=usage_date,sending_number,carrier,direction,msg_count,segments,cost`
        + `&direction=eq.outbound&usage_date=gte.${since}&usage_date=lte.${until}&order=usage_date.asc`);
      if (!dR.ok) { res.status(502).json({ error: 'supabase read failed', detail: (await dR.res.text()).slice(0, 400) }); return; }
      const daily = dR.rows;
      // Only call it a fallback when there was really nothing hourly to use — an hourly window that
      // is legitimately empty (a quiet day) must not relabel the whole panel as UTC.
      if (!uR.ok) dayBasis = 'utc';
      usage = daily.map(r => ({ ...r, cap_date: String(r.usage_date).slice(0, 10) }));
    }

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
    // Grouped by the UTC day the carrier resets on, for the allowance arithmetic only.
    const capMap = new Map();
    for (const r of usage) {
      const d = String(r.cap_date || r.usage_date).slice(0, 10);
      const cur = capMap.get(d) || { date: d, perBrand: {} };
      if (isTmobile(r.carrier)) {
        const bid = brandFor[r.sending_number] || UNASSIGNED;
        cur.perBrand[bid] = (cur.perBrand[bid] || 0) + (Number(r.msg_count) || 0);
      }
      capMap.set(d, cur);
    }

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
    // Across the SELECTED period. This used to count back from today regardless, so choosing a past
    // day drew today's (empty) bar and took the brand's "busiest day" from it.
    const byDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = etShift(until, -i);
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
      // The busiest CAP day — grouped by UTC, because that is the day the allowance resets on.
      const peakDay = [...capMap.values()].reduce((m, d) => {
        const n = d.perBrand[b.brand_id] || 0;
        return n > (m ? m.n : -1) ? { date: d.date, n } : m;
      }, null);
      // ALLOWANCE IS A DAILY THING. T-Mobile's cap resets every midnight UTC, so "remaining" only
      // means something for a single day. Over a longer period the honest equivalent is the
      // BUSIEST day — how close the brand came to the ceiling at its worst — and that is what is
      // reported, labelled so nobody reads a month of volume against one day's allowance.
      const cap = Number(b.tmo_daily_cap) || 0;
      // For a single ET day, the allowance figure is that day's UTC cap-day — ~20 of the ET day's 24
      // hours fall inside it, and it is the reset the carrier actually enforces.
      const capDayForPeriod = periodMeta.kind === 'day'
        ? ((capMap.get(since) || { perBrand: {} }).perBrand[b.brand_id] || 0)
        : (peakDay ? peakDay.n : 0);
      const usedAgainstCap = capDayForPeriod;
      const basis = periodMeta.kind === 'day' ? 'day' : 'peak-day';
      return {
        brand_id: b.brand_id, brand: b.brand_name,
        vetting_score: b.vetting_score, tmobile_daily_cap: b.tmo_daily_cap, att_tpm: b.att_tpm,
        numbers: nums.length, total, tmobile: tmo,
        peak_day: peakDay ? peakDay.date : null,
        peak_tmobile: peakDay ? peakDay.n : 0,
        peak_pct_of_cap: peakDay && b.tmo_daily_cap ? +(peakDay.n / b.tmo_daily_cap * 100).toFixed(2) : 0,
        // What the Reports tab quotes as allowance / used / left for the chosen period.
        allowance: cap,
        allowance_basis: basis,
        used_against_allowance: usedAgainstCap,
        remaining: cap ? Math.max(0, cap - usedAgainstCap) : null,
        pct_of_allowance: cap ? +(usedAgainstCap / cap * 100).toFixed(2) : 0,
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
    // T-Mobile volume per number per DAY. Needed because the allowance is a daily one: over a
    // month, a number's honest figure against the cap is its own busiest day, not its month total.
    const inboxByDay = new Map();
    for (const r of usage) {
      const tn = r.sending_number;
      if (isTmobile(r.carrier)) {
        const k = tn + '|' + String(r.usage_date).slice(0, 10);
        inboxByDay.set(k, (inboxByDay.get(k) || 0) + (Number(r.msg_count) || 0));
      }
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
    // A NUMBER HAS NO ALLOWANCE OF ITS OWN. Telnyx caps a BRAND, and every number on that brand
    // draws from the same pot — ~88% of all volume is one number sharing Playbook's with the
    // rest. So each number reports its brand's allowance, what the brand has left, and the share
    // of that pot this number accounted for. A per-number bar would otherwise read "nearly empty"
    // while the pot it draws from filled up.
    const brandByIdForInbox = {};
    for (const b of brandRows) brandByIdForInbox[b.brand_id] = b;
    for (const x of inboxMap.values()) {
      const s = senders.find(y => y.phone_number === x.number);
      const b = s && s.brand_id ? brandByIdForInbox[s.brand_id] : null;
      x.brand_allowance = b ? b.allowance : null;
      x.brand_used = b ? b.used_against_allowance : null;
      x.brand_remaining = b ? b.remaining : null;
      x.brand_pct_of_allowance = b ? b.pct_of_allowance : null;
      // Measured on the SAME basis as the brand, or the two numbers cannot be read together: for a
      // single day, the day's volume; for a longer period, this number's own busiest day. Comparing
      // a month total to a daily cap produced "603% of brand use" before this.
      let ownPeak = x.tmobile;
      if (periodMeta.kind !== 'day') {
        ownPeak = 0;
        for (const d of byDay) ownPeak = Math.max(ownPeak, inboxByDay.get(x.number + '|' + d.date) || 0);
      }
      x.tmobile_peak_day = ownPeak;
      x.pct_of_allowance = b && b.allowance ? +(ownPeak / b.allowance * 100).toFixed(2) : null;
      // Share of the brand's traffic across the whole period — a proportion, so both sides are
      // period totals and it is the one figure here that is not about the cap.
      x.share_of_brand = b && b.tmobile ? +(x.tmobile / b.tmobile * 100).toFixed(1) : 0;
      // What the UI colours. Thresholds are on the BRAND's fill, because that is what actually
      // throttles: a number sending 5% of a pot that is 95% full is the one in danger.
      // Only numbers that actually sent are flagged. Tinting every idle number on a filling brand
      // turned a 16-row table into a wall of pink and buried the two rows that were doing it.
      const fill = b ? b.pct_of_allowance : 0;
      const contributed = x.tmobile > 0;
      x.alert = !x.registered ? 'unregistered'
        : !contributed ? ''
        : fill >= 90 ? 'red' : fill >= 70 ? 'amber' : '';
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
      period: { ...periodMeta, day_basis: dayBasis, cap_basis: 'utc' },
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
      // Latest hour held, so the panel can say how fresh it is and offer a sync when it is not.
      usage_through: usageThrough,
      usage_from: usageFrom,
      // True when the period starts before anything we hold, so the totals below are a floor and
      // not the period's real volume. The UI says so rather than letting a short month read as a
      // quiet one.
      partial: !!(usageFrom && Date.parse(since + 'T00:00:00Z') < Date.parse(String(usageFrom).slice(0, 10) + 'T00:00:00Z')),
      excludes: 'Salesmsg — sent through Salesmsg’s own 10DLC brand, not visible to Telnyx.',
    });
  } catch (e) {
    res.status(502).json({ error: 'telnyx usage read failed', detail: String((e && e.message) || e) });
  }
}
