// Register an already-purchased number on a 10DLC campaign.
//
// WHY THIS IS SEPARATE from provision-demo-sms-agent.js. That script ordered the number and then
// registered it in the next breath, and the registration silently did not take: a number is not
// immediately assignable in the moment after it is ordered, so the call went out against a
// number Telnyx did not yet consider ready. The order succeeded, the campaign assignment left no
// record at all, and the only visible symptom was messaging_campaign_id staying null.
//
// So this waits for the number to actually be active before trying, and says what it sees at
// each step rather than assuming. Safe to re-run: if the number is already on the campaign it
// reports that and changes nothing.
//
// Usage:
//   node scripts/assign-10dlc.js --number +16176160446 --campaign 4b30019f-a56f-c552-f3db-06a6d8f3da74
//   node scripts/assign-10dlc.js --number +16176160446            # just report current state

const fs = require('fs');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const NUMBER = val('--number', null);
const CAMPAIGN = val('--campaign', null);

if (!NUMBER) { console.error('--number is required, e.g. --number +16176160446'); process.exit(1); }

const KEY = (() => {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('TELNYX_API_KEY=')) return t.slice(15).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('TELNYX_API_KEY not found in .env');
})();

const api = async (path, init) => {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init && init.headers) },
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* keep text */ }
  return { ok: res.ok, status: res.status, body, text };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. What does Telnyx think of this number right now.
  const look = await api(`/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(NUMBER)}`);
  const n = look.ok && look.body && look.body.data && look.body.data[0];
  if (!n) { console.error('not on this account:', NUMBER); process.exit(1); }
  console.log(`number    : ${n.phone_number}`);
  console.log(`status    : ${n.status}`);
  console.log(`profile   : ${n.messaging_profile_name || '(none)'}`);
  console.log(`campaign  : ${n.messaging_campaign_id || '(none)'}`);

  if (n.messaging_campaign_id) { console.log('\nalready registered - nothing to do.'); return; }
  if (!CAMPAIGN) { console.log('\nno --campaign given, so only reporting.'); return; }

  // 2. Do not try against a number that is not ready yet - that is the bug this script exists to
  //    avoid repeating.
  if (n.status !== 'active') {
    process.stdout.write(`waiting for the number to go active (currently ${n.status}) `);
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const again = await api(`/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(NUMBER)}`);
      const m = again.body && again.body.data && again.body.data[0];
      if (m && m.status === 'active') { console.log('- active'); break; }
      process.stdout.write('.');
      if (i === 11) { console.log('\nstill not active after a minute - stopping rather than guessing.'); process.exit(1); }
    }
  }

  // 3. Register. The failure text matters here, so it is printed in full rather than summarised:
  //    10DLC rejections explain themselves (campaign full, brand mismatch, number not eligible)
  //    and the explanation is the whole value.
  // The path is /10dlc/phone_number_campaigns. /phone_number_campaigns (no 10dlc prefix) returns
  // a 404 that looks exactly like a Telnyx rejection of the number, which cost a round trip to
  // tell apart - the field names were right all along, the path was not.
  const assign = await api('/10dlc/phone_number_campaigns', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: NUMBER, campaignId: CAMPAIGN }),
  });
  console.log(`\nassign    : HTTP ${assign.status}`);
  console.log(assign.ok ? '  accepted' : '  ' + assign.text.slice(0, 600));

  // 4. Read it back. An accepted request is not the same as a registered number - carrier
  //    registration is asynchronous, so this reports what is true a few seconds later, and
  //    "pending" here is a normal answer rather than a failure.
  await sleep(4000);
  const after = await api(`/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(NUMBER)}`);
  const a = after.body && after.body.data && after.body.data[0];
  console.log(`verify    : campaign=${(a && a.messaging_campaign_id) || '(still none - may be pending with the carrier)'}`);
})();
