// SeatGeek's full seat-level inventory, through an Apify actor.
//
// WHY APIFY FOR THIS ONE SITE. SeatGeek is the only source that no method of ours reaches:
// DataDome refused Kernel on headless, headful, residential proxy, mobile egress, ISP egress and
// a warmed persistent profile — seven configurations, seven refusals. The ladder gets its TEAM
// page, which carries a get-in and no section. Apify's actor returns the whole event.
//
// THE LISTINGS ARE NOT IN THE DATASET. This is the part that is easy to get wrong, and I got it
// wrong first time round: the dataset row the run produces is a SUMMARY —
//
//   { listingCount: 5548, lowestPrice: 72, listings: { total: 5548, … }, inventoryStorage: {…} }
//
// Reading `listingCount` off that and calling it "5,548 listings returned" is reporting a number
// the actor told us about inventory it had not handed over. The listings live in the run's
// key-value store as a gzipped record, named in `inventoryStorage.recordKeys`, with the actor's
// own instructions: "Concatenate record bytes in order, gzip-decompress, then parse JSON." That
// unpacks to ~24 MB holding `inventoryListings` — 5,548 rows with section, row, price,
// priceWithFees, quantity and splitQuantities. Verified against a live store before this was
// written.
//
// Env: APIFY_API_KEY. Optional APIFY_SEATGEEK_ACTOR to point at a different actor.

import { gunzipSync } from 'node:zlib';
// Both normalisers live in section-zones.js, beside the normSection they exist to feed — see
// the note there on why "Section 311" matching nothing is the failure they prevent.
import { stripSectionWord, stripRowWord } from './section-zones.js';

const API = 'https://api.apify.com/v2';
const TOKEN = () => (process.env.APIFY_API_KEY || '').trim();
// Apify writes an actor as user/name but addresses it as user~name.
const ACTOR = () => (process.env.APIFY_SEATGEEK_ACTOR || 'lentic_clockss/seatgeek-scraper').trim().replace('/', '~');

// The actor is OOM-killed (exit 137) at the default memory on a full NBA event. 4096 is what the
// 5,548-listing run needed; lowering it does not fail cleanly, it fails at the end.
const MEMORY_MB = Number(process.env.APIFY_SEATGEEK_MEMORY || 4096);

// A full event is a big scrape. The poll ceiling is generous because the alternative — giving up
// at 60s — bills for the run and throws the result away.
const RUN_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS || 240000);
const POLL_MS = 5000;

export const apifyEnabled = () => !!TOKEN();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

async function apify(path, init) {
  const r = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN())}`, init);
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.type)) || msg; } catch {}
    const e = new Error(`apify ${r.status}: ${msg}`);
    e.status = r.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

// Pulls the full-event blob the summary points at. Records are concatenated IN ORDER before
// decompressing — a multi-record event is one gzip stream split across keys, so decompressing
// each separately fails on everything after the first.
async function readFullEvent(storage) {
  const keys = (storage && storage.recordKeys) || [];
  const store = storage && storage.keyValueStoreId;
  if (!store || !keys.length) return null;
  const parts = [];
  for (const k of keys) {
    const r = await fetch(`${API}/key-value-stores/${store}/records/${encodeURIComponent(k)}?token=${encodeURIComponent(TOKEN())}`);
    if (!r.ok) throw new Error(`apify kv ${r.status} on ${k}`);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  const buf = Buffer.concat(parts);
  let text;
  if (String(storage.encoding || '').toLowerCase() === 'gzip') {
    text = gunzipSync(buf).toString('utf8');
  } else {
    // Sniff the magic number rather than trusting the field — a wrong guess here is a JSON
    // parse error on binary, which reads like a corrupt download.
    text = (buf[0] === 0x1f && buf[1] === 0x8b) ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  }
  return JSON.parse(text);
}

// One SeatGeek event, seat by seat.
//
// Returns { ok, listings, total, cost_usd, lowest } in the same shape the other section-level
// methods use, or { ok:false, error } — never throws for an expected failure, because this sits
// in a fallback chain that has to be able to move on.
export async function fetchApifySeatgeek(eventUrl, opts = {}) {
  if (!TOKEN()) return { ok: false, error: 'APIFY_API_KEY not set' };
  if (!eventUrl) return { ok: false, error: 'no SeatGeek event URL' };
  const t0 = Date.now();
  try {
    // Async start, then poll. The sync endpoint (run-sync-get-dataset-items) would be simpler but
    // returns only the dataset — and the dataset is the summary, not the listings.
    const started = await apify(`/acts/${ACTOR()}/runs?memory=${MEMORY_MB}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url: eventUrl }],
        // The actor's own switch for seat-level rather than event aggregates. Without it the
        // run is cheaper and useless for our purpose.
        detailLevel: 'seat-level',
        maxItems: Number(opts.maxItems || 0) || undefined,
      }),
    });
    const runId = started && started.data && started.data.id;
    if (!runId) return { ok: false, error: 'apify did not return a run id' };

    let run = started.data;
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (['READY', 'RUNNING'].includes(run.status)) {
      if (Date.now() > deadline) {
        // Abort rather than leave it billing after we have stopped waiting.
        await apify(`/actor-runs/${runId}/abort`, { method: 'POST' }).catch(() => {});
        return { ok: false, error: `apify run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s`, run_id: runId };
      }
      await sleep(POLL_MS);
      const got = await apify(`/actor-runs/${runId}`);
      run = (got && got.data) || run;
    }
    const usd = round2(((run.usageTotalUsd != null ? run.usageTotalUsd : (run.usage && run.usage.ACTOR_COMPUTE_UNITS)) || 0));
    if (run.status !== 'SUCCEEDED') {
      // exit 137 is the OOM kill, and it is the failure this actor actually has. Saying so beats
      // "status FAILED" for whoever reads the trail six weeks from now.
      const oom = run.exitCode === 137 ? ' (exit 137 — out of memory; raise APIFY_SEATGEEK_MEMORY)' : '';
      return { ok: false, error: `apify run ${run.status}${oom}`, run_id: runId, cost_usd: usd };
    }

    const items = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true&limit=5`);
    const row = Array.isArray(items) ? items[0] : null;
    if (!row) return { ok: false, error: 'apify run produced no dataset rows', run_id: runId, cost_usd: usd };

    const full = await readFullEvent(row.inventoryStorage);
    const raw = (full && full.inventoryListings) || [];
    if (!Array.isArray(raw) || !raw.length) {
      // The summary says how many there should be, so a mismatch is reportable rather than a
      // silent zero. This is exactly the case that was misread as success the first time.
      return {
        ok: false, run_id: runId, cost_usd: usd,
        error: `apify returned a summary but no listings (summary said ${row.listingCount ?? '?'})`,
      };
    }

    const listings = raw.map(l => ({
      price: round2(l.price),
      // priceWithFees is SeatGeek's real all-in. displayPrice follows the user's fee setting and
      // is not comparable between runs.
      all_in: round2(l.priceWithFees != null ? l.priceWithFees : l.price),
      section: stripSectionWord(l.section),
      row: stripRowWord(l.row),
      quantities: Array.isArray(l.splitQuantities) && l.splitQuantities.length
        ? l.splitQuantities.map(Number).filter(Boolean)
        : (l.quantity ? [Number(l.quantity)] : null),
      seat_count: l.quantity != null ? Number(l.quantity) : null,
      deal_score: l.dealScore != null ? Number(l.dealScore) : null,
    })).filter(l => l.price > 0 && l.section);

    return {
      ok: listings.length > 0,
      listings,
      total: raw.length,
      dropped: raw.length - listings.length,
      // SeatGeek's own lowestPrice is NOT our cheapest and must not be used as one: on the
      // verified run it said 72 while the cheapest listing in the inventory was $57 pre-fee
      // ($70.26 all-in). Whatever basis it uses, it is not "the cheapest row below". Kept only
      // so a trail can show what the site claimed alongside what we measured.
      site_claimed_lowest: row.lowestPrice != null ? round2(row.lowestPrice) : null,
      cheapest_all_in: round2(Math.min(...listings.map(l => l.all_in).filter(n => n > 0))),
      summary_count: row.listingCount ?? null,
      run_id: runId,
      cost_usd: usd,
      ms: Date.now() - t0,
      error: listings.length ? null : 'every listing was missing a price or a section',
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
}
