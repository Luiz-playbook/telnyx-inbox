// Local dev server — no Vercel needed. Serves ui/ statically and routes
// /api/<name> to the matching api/<name>.js default export, adapting the
// request/response to the Vercel handler shape (req.method/body/query/headers,
// res.status().json()). Run:  node scripts/dev-server.mjs  [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2]) || 3000;

// --- load .env into process.env (KEY=VALUE, # comments, no export) ---
try {
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim();
    // Strip trailing inline comments on UNQUOTED values, matching dotenv. Several keys in
    // .env are annotated (`ck_pat_… #Cole's`), and without this the comment is part of the
    // value — which is exactly why the CakeMail PATs answered `401 Invalid token` locally
    // while the same tokens worked in n8n. Quoted values are left alone: a '#' inside quotes
    // is data, not a comment.
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
    v = v.replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
} catch { console.warn('no .env found — API keys may be missing'); }

// regen ui/config.js so the browser has fresh Supabase/webhook config
try { await import(pathToFileURL(path.join(root, 'scripts', 'gen-config.js')).href); }
catch (e) { console.warn('gen-config failed:', e.message); }

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.map':'application/json' };

function makeRes(res) {
  const api = {
    statusCode: 200,
    status(c) { res.statusCode = c; return api; },
    setHeader(k, v) { res.setHeader(k, v); return api; },
    json(obj) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return api; },
    send(body) { res.end(typeof body === 'string' ? body : JSON.stringify(body)); return api; },
    end(body) { res.end(body); return api; },
  };
  return api;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}

// Anything under lib/ that was touched after this process booted is already cached by Node
// and cannot be reloaded in place.
const STARTED_AT = Date.now();
function changedLibFiles() {
  const dir = path.join(root, 'lib');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
    .filter(f => fs.statSync(path.join(dir, f)).mtimeMs > STARTED_AT)
    .map(f => `lib/${f}`);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(u.pathname);

  // ---- API routes ----
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length).replace(/\/$/, '');
    const file = path.join(root, 'api', `${name}.js`);
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('no such api route'); }
    // An api/ file is re-imported on every edit via the ?t= cache-buster, but the modules it
    // imports statically (lib/*.js) keep resolving to their plain, already-cached URL — so a
    // lib edit is invisible until the process restarts, and the symptom is a baffling
    // "does not provide an export named X" from code that plainly exports it. A specifier
    // inside a module can't be rewritten from here, so say so instead of serving stale code.
    const staleLib = changedLibFiles();
    if (staleLib.length) {
      console.error(`\n  lib/ changed since this dev server started: ${staleLib.join(', ')}`);
      console.error('  Node has the old copy cached — restart the dev server (Ctrl-C, then run it again).\n');
      res.statusCode = 503;
      return res.end(JSON.stringify({
        error: `dev server is running stale code: ${staleLib.join(', ')} changed after start. Restart the dev server.`,
      }));
    }
    try {
      const mod = await import(pathToFileURL(file).href + `?t=${fs.statSync(file).mtimeMs}`);
      const handler = mod.default;
      const query = Object.fromEntries(u.searchParams.entries());
      const body = ['POST','PUT','PATCH'].includes(req.method) ? await readBody(req) : undefined;
      const vreq = { method: req.method, headers: req.headers, query, body, url: req.url };
      await handler(vreq, makeRes(res));
    } catch (e) {
      console.error(`api/${name} error:`, e);
      if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
    }
    return;
  }

  // ---- static files from ui/ ----
  let rel = pathname === '/' ? '/index.html' : pathname;
  let fp = path.join(root, 'ui', rel);
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  // cleanUrls: /foo -> /foo.html
  if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  if (!fs.existsSync(fp)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n  local dev  ->  http://localhost:${PORT}`);
  console.log(`  static: ui/   api: /api/{chat,decide,draft,lookup}\n`);
});
