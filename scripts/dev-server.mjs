// Local dev server — no Vercel needed. Serves ui/ statically and routes
// /api/<name> to the matching api/<name>.js default export, adapting the
// request/response to the Vercel handler shape (req.method/body/query/headers,
// res.status().json()). Run:  node scripts/dev-server.mjs  [port]
//
// THERE ARE TWO OF THESE AND IT IS A TRAP. scripts/dev-server.js does the same job; README.md
// documents THAT one (`node --env-file=.env scripts/dev-server.js`) while this one is what gets
// run in practice, because it loads .env itself and takes the port as a positional argument.
// They have already drifted: this file regenerates ui/config.js on boot and cache-busts handlers
// on mtime, the other does neither and prints an llm-route banner this one lacks.
//
// The cost is not theoretical. A fix to the stale-lib check below was written into dev-server.js
// alone, which looked right — the two files emit the SAME error string, so grepping for it finds
// only the one you happen to land on — and the error went on appearing because the file being
// executed had never been touched (Vhea, 2026-10-08).
//
// Until one is deleted, any change to the request path here must be made in both. Better: pick
// this one, point README.md at it, and delete the other.
import http from 'node:http';
import { spawn } from 'node:child_process';
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
const LIB = path.join(root, 'lib');

// PER HANDLER, NOT PER SERVER. This used to refuse a request when ANY file under lib/ had
// changed, which is wildly over-broad: touching lib/scrape-price.js blocked /api/cakemail-sync,
// which does not import it and never did. A price-pipeline edit therefore took the whole local
// app down with "restart the dev server" on endpoints that were perfectly fine, and the error
// named seven files none of which the failing endpoint uses.
//
// So the import graph is walked from the handler outward, and only the libs it actually reaches
// can stale it. Static imports only — nothing in api/ or lib/ uses import(), so a regex over the
// source is exact here rather than an approximation. If a dynamic import is ever added this
// under-reports, the symptom is the old "does not provide an export named X", and the fix is to
// list it here rather than widen the check back out.
//
// KEEP IN STEP WITH scripts/dev-server.js, which carries the same logic. Two dev servers is one
// too many (see the note at the top of this file) but while both exist they must agree, or a
// restart appears to fix nothing.
const importsOf = (file) => {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  // `import … from './x.js'` and bare `import './x.js'`, single or double quoted.
  const re = /\bimport\s*(?:[\s\S]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g;
  for (let m; (m = re.exec(src));) out.push(path.resolve(path.dirname(file), m[1]));
  return out;
};

// Memoised: the graph only changes when a file changes, and a changed file is exactly what this
// reports rather than needs to re-walk. Four files deep at most either way.
const GRAPH = new Map();
function libsReachedBy(entry) {
  if (GRAPH.has(entry)) return GRAPH.get(entry);
  const seen = new Set(), libs = new Set(), queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.startsWith(LIB + path.sep)) libs.add(f);
    for (const dep of importsOf(f)) queue.push(dep);
  }
  GRAPH.set(entry, libs);
  return libs;
}

function changedLibFiles(entry) {
  const stale = [];
  for (const f of libsReachedBy(entry)) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs > STARTED_AT) stale.push(path.relative(root, f).replace(/\\/g, '/'));
  }
  return stale.sort();
}

let INFLIGHT = 0;   // requests being served right now; a restart waits for these
const server = http.createServer(async (req, res) => {
  // A RESTART MUST NOT DROP A REQUEST. Closing the port under an in-flight call
  // surfaces in the browser as "Failed to fetch" — indistinguishable from the
  // server being down, and genuinely alarming on a Send now, where the honest
  // reading of a dropped connection is "I do not know whether that sent".
  INFLIGHT++;
  res.on('close', () => { INFLIGHT--; });
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
    const staleLib = changedLibFiles(file);
    if (staleLib.length) {
      console.error(`\n  /api/${name} imports ${staleLib.join(', ')}, changed since this dev server started.`);
      console.error('  Node has the old copy cached — restart the dev server (Ctrl-C, then run it again).\n');
      res.statusCode = 503;
      // Names the endpoint as well as the files: the old message listed everything under lib/
      // and left the reader to work out which of seven files the failing call even used.
      return res.end(JSON.stringify({
        error: `dev server is running stale code: /api/${name} imports ${staleLib.join(', ')} — changed after start. Restart the dev server.`,
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

// ---------------------------------------------------------------------------------------------
// AUTO-RESTART ON A lib/ EDIT.
//
// The check above is correct and stays, but it was only ever a refusal: Node has cached the old
// copy of a lib, nothing out here can rewrite a specifier inside a module, so the honest move is
// to stop. The missing half is that a dev server is the one process that can simply start again.
// Without this, every edit to lib/ costs an interrupted test and a manual restart — four in one
// afternoon, which is how a safety net turns into an obstacle.
//
// WHY RE-EXEC AND NOT A MODULE-CACHE TRICK. There isn't one. The handler is already imported with
// a ?t= cache-buster, and that is exactly why it is not enough: the handler reloads, its static
// `import '../lib/x.js'` resolves to the same plain URL, and Node hands back the copy it loaded
// at boot. ESM has no public uncache. A new process is the only way to get a new module graph.
//
// THE PORT IS RELEASED BEFORE THE CHILD STARTS, or the replacement dies on EADDRINUSE while the
// parent is still holding the socket. close() alone waits for keep-alive connections that a
// browser will happily hold open for a minute, so the sockets are dropped first where that is
// supported, and a timeout is the backstop.
//
// Mirrors the same block in scripts/dev-server.js — that file's header explains why there are
// two of these and that a change to one must be made in the other.
//
// api/ IS NOT WATCHED. Handlers are re-imported per request with a cache-buster, so they are
// already live; restarting on those would throw away a working process for no reason.
function watchLibsAndRestart() {
  const WATCHED = path.join(root, 'lib');
  if (!fs.existsSync(WATCHED)) return;
  let timer = null, going = false, firstSeen = 0;
  const changed = new Set();

  const restart = () => {
    if (going) return;
    // WAIT FOR QUIET. A lib edit is never so urgent that it should interrupt a call
    // already being served; the request is finished first and the restart follows.
    // Capped so a hung or streaming request cannot postpone it forever.
    if (INFLIGHT > 0 && Date.now() - firstSeen < 20000) {
      setTimeout(restart, 200);
      return;
    }
    going = true;
    const what = [...changed].sort().join(', ');
    console.log(`
  lib/ changed (${what}) — restarting so Node picks it up…
`);
    const spawnChild = () => {
      // execArgv carries --env-file=.env, so the replacement keeps the same environment.
      // DETACHED AND UNREF'D, or the replacement dies with the process that started it. The
      // child must outlive this one: as its own process-group leader nothing cascades to it when
      // the parent exits, and unref() lets the parent's event loop end without waiting on it.
      // stdio stays inherited so the new server keeps printing to the same terminal.
      const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)],
        { stdio: 'inherit', detached: true });
      child.on('error', (e) => { console.error('  could not restart:', e.message); process.exit(1); });
      child.on('spawn', () => { child.unref(); setTimeout(() => process.exit(0), 150).unref(); });
    };
    // Drop held-open connections so the port is actually free, then hand over.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(spawnChild);
    setTimeout(spawnChild, 1500).unref();   // backstop if close() never calls back
  };

  fs.watch(WATCHED, { recursive: true }, (_evt, file) => {
    if (!file || !String(file).endsWith('.js')) return;
    if (!firstSeen) firstSeen = Date.now();
    changed.add(String(file).replace(/\\/g, '/'));
    // Debounced: editors write a file in several events, and a save should cost one restart.
    clearTimeout(timer);
    timer = setTimeout(restart, 250);
  });
  console.log('  watching       lib/ — a change there restarts this server automatically');
}
watchLibsAndRestart();

server.listen(PORT, () => {
  console.log(`\n  local dev  ->  http://localhost:${PORT}`);
  console.log(`  static: ui/   api: /api/{chat,decide,draft,lookup}\n`);
});
