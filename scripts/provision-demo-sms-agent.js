// Finish provisioning the Fernway demo SMS agent: buy a number, attach it to the assistant's
// messaging profile, and register it on a 10DLC campaign.
//
// WHAT IS ALREADY DONE, and is NOT repeated here (all of it live on Telnyx as of 2026-10-06):
//   • assistant-81df6551-e27d-48ac-99b4-eaa398ed1afb — "Fernway Bicycle Co. (DEMO) - SMS Agent"
//     enabled_features: ["messaging"] only. It has no telephony, so it cannot take a call.
//   • bucket fernway-demo-kb — four markdown docs for the fictional shop, embedded, and attached
//     to the assistant as a retrieval tool. Verified: it answers hours, prices and both of the
//     "we don't do that" cases out of the knowledge base.
//
// WHY THIS IS A SCRIPT AND NOT SOMETHING ALREADY RUN. Buying a number spends money, and the
// 10DLC step puts a number onto a REGISTERED CAMPAIGN under the Playbook brand — that is a
// shared reputation and a shared throughput allowance, not a sandbox. Both deserve a person
// deciding, so they are here rather than done quietly.
//
// Usage:
//   node scripts/provision-demo-sms-agent.js --dry-run          # show what it would do
//   node scripts/provision-demo-sms-agent.js --area 617         # actually buy and assign
//   node scripts/provision-demo-sms-agent.js --area 617 --campaign 4b30019f-...
//
// Env: TELNYX_API_KEY (read from .env in the repo root).

const fs = require('fs');

const ASSISTANT_ID = 'assistant-81df6551-e27d-48ac-99b4-eaa398ed1afb';
// The messaging profile Telnyx created for the assistant when it was made. A number must sit on
// THIS profile for the assistant to see its inbound texts.
const MESSAGING_PROFILE_ID = '4001a111-13d4-4dd4-8814-f522c552b67a';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DRY = has('--dry-run');
const AREA = val('--area', '617');
const CAMPAIGN = val('--campaign', null);

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

(async () => {
  // 1. Find a number. SMS is the only feature that matters — this agent never takes a call.
  const q = `/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=${AREA}&filter[features][]=sms&filter[limit]=1`;
  const avail = await api(q.replace(/\[/g, '%5B').replace(/\]/g, '%5D'));
  const pick = avail.ok && avail.body && avail.body.data && avail.body.data[0];
  if (!pick) { console.error('no SMS-capable number available in area', AREA, avail.text.slice(0, 200)); process.exit(1); }
  const cost = pick.cost_information || {};
  console.log(`number      : ${pick.phone_number}`);
  console.log(`cost        : ${cost.upfront_cost} ${cost.currency} upfront, ${cost.monthly_cost}/month`);

  // 2. Which campaign. Listed rather than guessed: putting a demo number on the wrong registered
  //    campaign borrows the reputation of a campaign that carries real traffic.
  if (!CAMPAIGN) {
    const brands = await api('/10dlc/brand?page=1&recordsPerPage=10');
    console.log('\nno --campaign given. Campaigns available:');
    for (const b of (brands.body && brands.body.records) || []) {
      const cs = await api(`/10dlc/campaign?brandId=${b.brandId}&page=1&recordsPerPage=20`);
      for (const c of (cs.body && cs.body.records) || []) {
        console.log(`  ${c.campaignId}  tcr=${c.tcrCampaignId || '-'}  brand=${b.displayName}  status=${c.status}`);
      }
    }
    console.log('\nre-run with --campaign <campaignId>.');
    if (!DRY) process.exit(1);
  }

  if (DRY) {
    console.log('\n--dry-run: nothing bought, nothing assigned.');
    console.log('would order the number onto messaging profile', MESSAGING_PROFILE_ID);
    if (CAMPAIGN) console.log('would register it on campaign', CAMPAIGN);
    return;
  }

  // 3. Buy it, straight onto the assistant's messaging profile. Doing both in the order means
  //    the number is never briefly live with no profile, which is a window where an inbound text
  //    reaches nothing and is not retried.
  const order = await api('/number_orders', {
    method: 'POST',
    body: JSON.stringify({
      phone_numbers: [{ phone_number: pick.phone_number }],
      messaging_profile_id: MESSAGING_PROFILE_ID,
      customer_reference: 'fernway-demo-sms-agent',
    }),
  });
  if (!order.ok) { console.error('order failed:', order.status, order.text.slice(0, 400)); process.exit(1); }
  console.log('\nordered     :', order.body.data.id, order.body.data.status);

  // 4. Register on the campaign. Separate call, and it can fail on its own — a number works for
  //    plain SMS without it, it just will not carry 10DLC throughput or survive carrier filtering.
  if (CAMPAIGN) {
    const assign = await api('/phone_number_campaigns', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: pick.phone_number, campaignId: CAMPAIGN }),
    });
    console.log('10DLC       :', assign.status, assign.ok ? 'assigned' : assign.text.slice(0, 300));
  }

  console.log('\nassistant   :', ASSISTANT_ID);
  console.log('Text the number above. It answers from the fernway-demo-kb knowledge base.');
})();
