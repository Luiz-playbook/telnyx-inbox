// Post-apply check for migration 120a, over PostgREST. No database connector needed.
//
//   node scripts/check-120a.mjs
//
// WHY THIS EXISTS SEPARATELY FROM THE .sql VERIFY. The SQL file checks the catalog from inside
// the database. This checks the same facts from OUTSIDE, through the exact two keys the app
// uses — which is the only way to see the failure that actually matters here.
//
// A drop takes the function's ACL with it. If the grant to `anon` is missed, the catalog still
// looks fine and the SQL editor still returns rows, because the editor is not anon. The Queue
// tab, which reads everything through this function with the anon key, silently goes EMPTY.
// So the anon call below is the real test, and it is deliberately made with the anon key rather
// than the service key that would mask it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
  if (!m) continue;
  let v = m[2].trim();
  // Strip trailing inline comments on UNQUOTED values, exactly as scripts/dev-server.mjs does.
  // Several keys in .env are annotated, and without this the comment is part of the value.
  if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
  process.env[m[1]] = v.replace(/^["']|["']$/g, '');
}

const URL_ = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NEW = ['email_html', 'cakemail_template_id', 'cakemail_template_name'];

const rpc = (fn, key, body = {}) =>
  fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

let failures = 0;
const say = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
};

// 1. THE ONE THAT MATTERS. Anon must still be able to read the queue, and the three new
//    columns must come back on it.
const r = await rpc('get_campaign_queue', ANON);
if (!r.ok) {
  say(false, 'get_campaign_queue via ANON key', `HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  console.log('\n        ^ this is the empty-Queue-tab failure. Re-run the grant:');
  console.log('        grant execute on function public.get_campaign_queue() to anon, authenticated, service_role, readonly_preview;');
} else {
  const rows = await r.json();
  say(true, 'get_campaign_queue via ANON key', `${rows.length} rows`);
  const cols = Object.keys(rows[0] || {});
  for (const c of NEW) say(cols.includes(c), `returns ${c}`);
  if (rows.length) {
    // Position matters: PostgREST builds its name->column mapping from the function signature,
    // and the three must be LAST or every column after the insertion point shifts.
    const tail = cols.slice(-3);
    say(NEW.every((c, i) => tail[i] === c), 'the three are the LAST three columns', tail.join(', '));
    say(cols.indexOf('strategy') === cols.length - 4, 'strategy still immediately precedes them');
    const attached = rows.filter(x => x.email_html).length;
    console.log(`        ${rows.length} queued, ${attached} with a design attached`);
  }
}

// 2. The writer must exist for the service key and be INVISIBLE to anon. It writes live campaign
//    HTML; the browser must never be able to call it. A 404 from PostgREST is what "not granted"
//    looks like from outside, so 404 and 403 both pass and only a 2xx fails.
const svc = await rpc('queue_set_email_html', SVC, { p_id: '00000000-0000-0000-0000-000000000000', p_html: null, p_template_id: null, p_template_name: null });
say(svc.ok, 'queue_set_email_html callable by SERVICE key', `HTTP ${svc.status}`);
if (!svc.ok) console.log(`        ${(await svc.text()).slice(0, 200)}`);

const anon = await rpc('queue_set_email_html', ANON, { p_id: '00000000-0000-0000-0000-000000000000', p_html: null, p_template_id: null, p_template_name: null });
say(!anon.ok, 'queue_set_email_html NOT callable by ANON key', `HTTP ${anon.status}`);
if (anon.ok) console.log('        ^ anon can write campaign HTML. Revoke it before using the picker.');

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed — 120a is applied correctly.');
process.exit(failures ? 1 : 0);
