// Build the demo knowledge base: create a Telnyx Cloud Storage bucket, upload the fake
// company's docs, then ask Telnyx to embed it. Signing follows lib/telnyx-kb.ts in the
// telnyx-ai-voice-management repo, which is the pattern already in production use.
const crypto = require('crypto');
const fs = require('fs');

const KEY = (() => {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('TELNYX_API_KEY=')) return t.slice('TELNYX_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('TELNYX_API_KEY not found in .env');
})();

const S3_HOST = 'us-central-1.telnyxcloudstorage.com';
const S3_REGION = 'us-central-1';
const S3_SERVICE = 's3';
const BUCKET = process.argv[2] || 'fernway-demo-kb';

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
const sha256Hex = (d) => crypto.createHash('sha256').update(d, 'utf8').digest('hex');
function signingKey(dateStamp) {
  return hmac(hmac(hmac(hmac('AWS4' + KEY, dateStamp), S3_REGION), S3_SERVICE), 'aws4_request');
}

async function s3(method, path, body) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonUri = path.split('/').map(encodeURIComponent).join('/');
  const payloadHash = body === undefined ? sha256Hex('') : sha256Hex(body);
  const canonHeaders = `host:${S3_HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonReq = [method, canonUri, '', canonHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${S3_REGION}/${S3_SERVICE}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonReq)].join('\n');
  const sig = crypto.createHmac('sha256', signingKey(dateStamp)).update(sts, 'utf8').digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  const res = await fetch(`https://${S3_HOST}${canonUri}`, {
    method,
    headers: {
      Authorization: auth,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...(body !== undefined ? { 'Content-Type': 'text/markdown' } : {}),
    },
    body,
  });
  return { ok: res.ok, status: res.status, text: await res.text().catch(() => '') };
}

// ── The fake company ────────────────────────────────────────────────────────────────────────
// Invented outright. The name, addresses, phone numbers and prices below belong to no real
// business - this exists to give the agent something concrete to retrieve, and it is labelled
// DEMO in the assistant's own name and description so nobody mistakes it for a live account.
const DOCS = {
  'hours-and-locations.md': `# Fernway Bicycle Co. — hours and locations

FICTIONAL COMPANY. Demo data for testing only.

## Riverside shop (main)
412 Fernway Avenue, Riverside
Mon–Fri 9am–6pm, Sat 9am–5pm, Sun closed.
Repairs counter closes 30 minutes before the shop.

## Eastgate shop
88 Eastgate Row, unit 4
Tue–Sat 10am–6pm. Closed Sunday and Monday.
No repairs at Eastgate — repair drop-offs go to Riverside.

## Holiday closures
Closed New Year's Day, Thanksgiving, and December 24–26.
`,

  'repairs.md': `# Repairs and servicing

FICTIONAL COMPANY. Demo data for testing only.

## Turnaround
Standard service: 3–5 working days.
Express service: next working day, +$40. Express is not available on Saturdays.
Wheel builds: 7–10 working days, always.

## Prices
Flat tyre repair: $25 per wheel, tube included.
Basic tune-up: $89. Gears, brakes, bolt check, lube.
Full service: $189. Strip, clean, rebuild bearings, new cables.
Brake bleed: $55 per end.
Bike fit: $120, one hour, by appointment only.

## What we do not do
No electric bike motor or battery work.
No carbon frame repairs.
No suspension internals — we send those out, add two weeks.

## Collection
We hold completed repairs for 30 days, then charge $5 per week storage.
We text you when a repair is ready. We do not phone.
`,

  'rentals.md': `# Rentals

FICTIONAL COMPANY. Demo data for testing only.

## Rates
Hybrid or city bike: $35 a day, $120 a week.
Road bike: $65 a day, $240 a week.
Kids' bike: $20 a day.
Helmet included free with every rental. Lock is $5 a day.

## Rules
18 or over to rent. Photo ID and a card held on file.
Riverside shop only. Eastgate does not do rentals.
Last pickup is 90 minutes before closing.
Late return is charged a full extra day after a 30-minute grace period.
Damage beyond normal wear is charged at repair price plus parts.
`,

  'stock-and-policies.md': `# Stock, returns and policies

FICTIONAL COMPANY. Demo data for testing only.

## Stock
We stock Fernway house-brand bikes, plus Corvid and Ashgrove.
We do not stock electric bikes.
Special orders take 2–3 weeks and need a 25% deposit.

## Returns
Unused accessories: 30 days with a receipt, full refund.
Bikes: 14 days, unridden, original packaging. 10% restocking fee.
Helmets and safety equipment cannot be returned once the tags are off.
Sale items are final.

## Warranty
Fernway house-brand frames: 5 years, original owner.
Parts and wheels: 1 year.
Labour on our own repairs: 90 days.

## Payment
Card and cash in shop. We do not take payment by text message, ever.
Deposits are non-refundable once an order is placed with the supplier.
`,
};

(async () => {
  console.log('bucket:', BUCKET);
  const mk = await s3('PUT', `/${BUCKET}`);
  console.log('  create bucket ->', mk.status, mk.ok ? 'ok' : mk.text.slice(0, 200));

  for (const [name, body] of Object.entries(DOCS)) {
    const r = await s3('PUT', `/${BUCKET}/${name}`, body);
    console.log(`  upload ${name} -> ${r.status} ${r.ok ? 'ok' : r.text.slice(0, 160)}`);
  }

  const emb = await fetch('https://api.telnyx.com/v2/ai/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket_name: BUCKET }),
  });
  console.log('  embed ->', emb.status, (await emb.text()).slice(0, 300));
})();
