// scripts/bulk-sms.test.mjs — run: node --test scripts/bulk-sms.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.BULK_SMS_API_URL = 'https://bulk.test';
process.env.BULK_SMS_API_SECRET = 's';
process.env.BULK_SMS_ALLOW_NONPROD = '1';

const m = await import('../lib/bulk-sms.js');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const answer = (status, body) => { const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status }); };
  return calls; };

test('the key is the title, folded to ASCII, then # and the first 6 of the row id', () => {
  assert.equal(m.campaignKeyFor({ id: '3f9a1c2e-41b8-4d09-9a1c-5e7b3f2a6d4e', title: 'Red Sox at Yankees' }), 'Red Sox at Yankees #3f9a1c');
  assert.equal(m.campaignKeyFor({ id: '3f9a1c2e', title: 'Fan’s Night · Café 🎟' }), "Fan's Night - Cafe #3f9a1c");
});

test('the key is at most 80 characters and the same on every retry of a row', () => {
  const row = { id: 'abcdef12-0000', title: 'x'.repeat(200) };
  assert.equal(m.campaignKeyFor(row).length, 80);
  assert.equal(m.campaignKeyFor(row), m.campaignKeyFor(row));
  assert.match(m.campaignKeyFor(row), / #abcdef$/);
});

test('a row with no title still gets a typeable key', () => {
  assert.equal(m.campaignKeyFor({ id: 'abcdef12', title: '' }), 'SendBlaster blast #abcdef');
});

test('<, > and backtick are removed from the title (the key is posted into a chat)', () => {
  const k = m.campaignKeyFor({ id: 'abcdef12', title: 'Hey <!channel> `rm` Night' });
  assert.doesNotMatch(k, /[<>`]/);
  assert.equal(k, 'Hey !channel rm Night #abcdef');
});

test('an uppercase hex id gives a lowercase suffix', () => {
  assert.match(m.campaignKeyFor({ id: 'ABCDEF12-3456', title: 'T' }), / #abcdef$/);
});

test('every produced key matches the server contract', () => {
  const rows = [
    { id: '3f9a1c2e-41b8', title: 'Red Sox at Yankees' },
    { id: 'ABCDEF12', title: 'Fan’s Night · Café 🎟 <!channel> `x`' },
    { id: 'abcdef12', title: 'y'.repeat(300) },
    { id: 'abcdef12', title: '' },
    { id: 'abcdef12', title: '<>`' },
  ];
  for (const row of rows) {
    const k = m.campaignKeyFor(row);
    assert.match(k, / #[0-9a-f]{6}$/);
    assert.match(k, /^[\x20-\x7e]+$/);
    assert.doesNotMatch(k, /[<>`]/);
    assert.ok(k.length <= 80);
  }
});

test('an id with fewer than 6 hex characters throws rather than build a key the server refuses', () => {
  assert.throws(() => m.campaignKeyFor({ id: 'xyz-12', title: 'T' }), /campaignKeyFor: row id has fewer than 6 hex characters/);
  assert.throws(() => m.campaignKeyFor({ id: '', title: 'T' }), /fewer than 6 hex/);
});

test('a 409 is a duplicate — carry on and look the campaign up', async () => {
  answer(409, { error: "duplicate campaign key 'k' already exists" });
  assert.equal((await m.stageCampaign({ key: 'k', name: 'n', body: 'b', fromNumber: '+1', phones: ['+16175550100'] })).duplicate, true);
});

test('a 422 is nobody eligible, with the census', async () => {
  answer(422, { error: 'nobody eligible', considered: 2, eligible: 0, blocked: 2, byReason: { not_in_hubspot: 2 } });
  const r = await m.stageCampaign({ key: 'k', name: 'n', body: 'b', fromNumber: '+1', phones: ['+16175550100'] });
  assert.equal(r.nobodyEligible, true);
  assert.deepEqual(r.census.byReason, { not_in_hubspot: 2 });
});

test('a 400 still throws', async () => {
  answer(400, { error: 'no route for +1' });
  await assert.rejects(m.stageCampaign({ key: 'k', name: 'n', body: 'b', fromNumber: '+1', phones: ['+16175550100'] }), /no route/);
});

test('stageCampaign sends phones only, de-duplicated', async () => {
  const calls = answer(200, { campaign: { id: 'c1', status: 'draft' } });
  await m.stageCampaign({ key: 'k', name: 'n', body: 'b', fromNumber: '+1', phones: ['+16175550100', '+16175550100', ''] });
  assert.deepEqual(JSON.parse(calls[0].init.body).recipients, [{ phone: '+16175550100' }]);
});

test('findCampaignByKey asks for the one key', async () => {
  const calls = answer(200, { campaigns: [{ id: 'c1', key: 'A #1' }] });
  assert.equal((await m.findCampaignByKey('A #1')).id, 'c1');
  assert.equal(calls[0].url, 'https://bulk.test/api/campaigns?key=A%20%231');
});

test('findCampaignByKey with an empty key does not call', async () => {
  const calls = answer(200, { campaigns: [{ id: 'c1', key: '' }] });
  assert.equal(await m.findCampaignByKey(''), null);
  assert.equal(await m.findCampaignByKey(undefined), null);
  assert.equal(calls.length, 0);
});

test('a duplicate key that is not ours is not adopted (Review Focus 5)', async () => {
  // The pipeline's SendBlaster view lists external campaigns only, so a stamped campaign with
  // the same key is invisible here — and must stay a loud failure, not a match.
  answer(200, { campaigns: [] });
  assert.equal(await m.findCampaignByKey('A #1'), null);
});

test('there is no arm call any more', () => {
  assert.equal(m.armCampaign, undefined);
});

test('the market cools once the campaign is approved and sending, never at a draft', () => {
  for (const status of ['running', 'paused', 'done']) assert.equal(m.startsCooldown({ status, sent: 0 }), true, status);
  assert.equal(m.startsCooldown({ status: 'draft', sent: 0 }), false);
  assert.equal(m.startsCooldown({ status: 'cancelled', sent: 0 }), false, 'discarded before approval');
  assert.equal(m.startsCooldown({ status: 'cancelled', sent: 5 }), true, 'stopped mid-send still reached people');
});
