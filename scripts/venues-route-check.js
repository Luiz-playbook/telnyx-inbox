// AI-1086: exercise api/venues.js the way a request would, without a dev server.
//
//   node --env-file=.env scripts/venues-route-check.js
//
// The validation cases never reach the database, so they pass whether or not migration 116 is
// applied. The round trip creates and then deletes one throwaway venue in a state code that is
// not a real state, and checks the table is back to its original count afterwards.
//
// What it is really checking, beyond "does it 200": that the three things the route refuses to
// let a caller do are actually refused. A caller that can set `sports` can produce a basketball
// venue hosting softball, and the seasonal cron filters on that column.

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret-for-local-only';
const handler = (await import('../api/venues.js')).default;

const call = (method, { body = {}, query = {}, auth = true } = {}) => new Promise(res => {
  let code = 0;
  const r = {
    status(c) { code = c; return r; },
    json(p) { res({ code, body: p }); return r; },
    setHeader() { return r; },
  };
  handler({ method, body, query, headers: auth ? { authorization: 'Bearer ' + process.env.CRON_SECRET } : {} }, r);
});

let pass = 0, fail = 0;
// ---- the page's hand copies, which nothing else can catch -------------------------------------
//
// ui/index.html has no build step, so it cannot import lib/youth-venues.js — the sports rule and
// the three dropdowns are hand copies. A hand copy nothing checks is a hand copy that drifts, and
// the drift is silent: the form would offer a venue type the table rejects, or show the wrong
// sports for one it accepts.
//
// Scanned line-by-line between the <select> and its </select> rather than with one regex across
// the file. The first attempt used a regex and reported three false drifts, which is its own
// argument for the duller method.
{
  const { SPORTS_BY_VENUE_TYPE, VENUE_TYPES, LEVELS, CONFIDENCE } = await import('../lib/youth-venues.js');
  const page = (await import('node:fs')).readFileSync('ui/index.html', 'utf8');
  const lines = page.split(/\r?\n/);
  const optionsOf = id => {
    const start = lines.findIndex(l => l.includes('id="vn-' + id + '"'));
    if (start < 0) return null;
    const out = [];
    for (let i = start; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/<option value="([^"]*)"/g)) if (m[1]) out.push(m[1]);
      if (lines[i].includes('</select>')) break;
    }
    return out;
  };
  const sameSet = (x, y) => x && y && x.length === y.length && x.every(v => y.includes(v));

  const vnBlock = page.match(/const VN_SPORTS = \{([\s\S]*?)\};/);
  const ui = vnBlock ? new Function('return {' + vnBlock[1] + '}')() : {};
  for (const k of Object.keys(SPORTS_BY_VENUE_TYPE)) {
    const ok = JSON.stringify(ui[k]) === JSON.stringify(SPORTS_BY_VENUE_TYPE[k]);
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  page's sports for ${k} match the lib`);
  }
  for (const [id, allowed] of [['venue_type', VENUE_TYPES], ['level', LEVELS], ['confidence', CONFIDENCE]]) {
    const got = optionsOf(id);
    const ok = sameSet(got, allowed);
    ok ? pass++ : fail++;
    // Order is a UI choice and deliberately not checked: d1 is listed first because 83 of 89
    // venues are d1, and Medium first because it is the safe default for an unchecked name.
    console.log(`${ok ? 'PASS' : 'FAIL'}  vn-${id} offers exactly the allowed values ${JSON.stringify(got)}`);
  }
}
const t = async (name, want, method, opts) => {
  const got = await call(method, opts);
  const ok = got.code === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(got.code).padEnd(3)} (want ${want})  ${name}`
    + (got.body && got.body.error ? `\n            -> ${got.body.error}` : ''));
  return got;
};

const OK = { state_code: 'ZZ', state_name: 'Test State', venue_city: 'Testville',
  org: 'Test University', venue: 'Test Field', venue_type: 'football', level: 'd1' };

console.log('--- auth and method ---');
await t('no bearer is rejected', 401, 'GET', { auth: false });
await t('an unsupported method is refused', 405, 'OPTIONS', {});

console.log('\n--- validation, nothing reaches the database ---');
await t('state is required', 400, 'POST', { body: { ...OK, state_code: '' } });
await t('state must be two letters', 400, 'POST', { body: { ...OK, state_code: 'ALAB' } });
await t('city is required', 400, 'POST', { body: { ...OK, venue_city: '' } });
await t('organisation is required', 400, 'POST', { body: { ...OK, org: '  ' } });
await t('venue name is required', 400, 'POST', { body: { ...OK, venue: '' } });
await t('venue type must be one of the three', 400, 'POST', { body: { ...OK, venue_type: 'hockey' } });
await t('level must be pro/minor/d1', 400, 'POST', { body: { ...OK, level: 'college' } });
await t('confidence must be High/Medium', 400, 'POST', { body: { ...OK, confidence: 'Maybe' } });
await t('update needs an id', 400, 'PATCH', { body: { venue: 'x' } });
await t('delete needs an id', 400, 'DELETE', {});
await t('editing a venue that is not there is a 404', 404, 'PATCH', { query: { id: '999999999' }, body: { notes: 'x' } });

console.log('\n--- read ---');
const got = await call('GET');
const rows = (got.body && got.body.rows) || [];
console.log(`${got.code === 200 ? 'PASS' : 'FAIL'}  GET returned ${rows.length} venues`);
got.code === 200 ? pass++ : fail++;
const baseline = rows.length;
const hasFlag = rows[0] && 'edited_by_hand' in rows[0];
console.log(`        view exposes edited_by_hand: ${hasFlag ? 'yes' : 'NO — migration 116 not applied'}`);

console.log('\n--- round trip on a throwaway row (ZZ, not a real state) ---');
const made = await t('create', 200, 'POST', { body: OK });
const id = made.body && made.body.row && made.body.row.id;
if (!id) {
  console.log('\n  create failed, so the write-path checks below cannot run.');
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(1);
}
const row = made.body.row;
console.log(`        sports DERIVED from venue_type: ${JSON.stringify(row.sports)}`);
console.log(`        edited_by_hand set by the route: ${row.edited_by_hand}`);
console.log(`        confidence defaulted to: ${JSON.stringify(row.confidence)}`);

// The three refusals that matter.
const inj = await call('POST', { body: { ...OK, venue: 'Injection Field',
  sports: ['softball', 'curling'], edited_by_hand: false, id: 1 } });
if (inj.code === 200) {
  const r2 = inj.body.row;
  const sportsIgnored = JSON.stringify(r2.sports) === JSON.stringify(['football', 'soccer', 'lacrosse', 'field hockey']);
  const flagForced = r2.edited_by_hand === true;
  sportsIgnored ? pass++ : fail++;
  flagForced ? pass++ : fail++;
  console.log(`${sportsIgnored ? 'PASS' : 'FAIL'}  a caller-supplied sports array is IGNORED -> ${JSON.stringify(r2.sports)}`);
  console.log(`${flagForced ? 'PASS' : 'FAIL'}  a caller cannot clear edited_by_hand -> ${r2.edited_by_hand}`);
  await call('DELETE', { query: { id: r2.id } });
} else { fail += 2; console.log('FAIL  the injection probe did not create:', inj.body && inj.body.error); }

const upd = await t('edit', 200, 'PATCH', { query: { id }, body: { venue_type: 'basketball', venue_city: 'Testville Two' } });
if (upd.body && upd.body.row) {
  const r3 = upd.body.row;
  const recomputed = JSON.stringify(r3.sports) === JSON.stringify(['basketball', 'volleyball']);
  recomputed ? pass++ : fail++;
  console.log(`${recomputed ? 'PASS' : 'FAIL'}  changing the venue type RECOMPUTES sports -> ${JSON.stringify(r3.sports)}`);
  console.log(`        untouched field kept: ${JSON.stringify(r3.org)}`);
}

await t('a duplicate org+venue says what to do instead', 409, 'POST', { body: OK });
await t('delete', 200, 'DELETE', { query: { id } });
await t('deleting it twice is a 404, not a silent success', 404, 'DELETE', { query: { id } });

const after = await call('GET');
const n = ((after.body && after.body.rows) || []).length;
console.log(`\n${n === baseline ? 'PASS' : 'FAIL'}  table back to ${n} rows (baseline ${baseline}) — nothing left behind`);
n === baseline ? pass++ : fail++;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
