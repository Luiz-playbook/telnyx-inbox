// Local dev server: serves ui/ AND runs the api/ serverless functions, so /api/draft
// and /api/lookup work without the Vercel CLI. Zero dependencies.
//
//   node --env-file=.env scripts/dev-server.js
//
// Vercel is still the real runtime; this just mimics enough of it (req.query, req.body,
// res.status().json()) to exercise the handlers locally with the same env vars.
//
// THERE ARE TWO OF THESE AND IT IS A TRAP. scripts/dev-server.mjs does the same job and is the
// one actually run in practice (`node scripts/dev-server.mjs 3000`) because it loads .env itself
// and takes the port positionally — while README.md documents this file. See the longer note at
// the top of that file, including the stale-lib fix that was written here, where nothing was
// executing it. Any change to the request path must be made in both until one is deleted.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const UI = path.join(__dirname, '..', 'ui');
const API = path.join(__dirname, '..', 'api');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

// Minimal Vercel-style response helpers on top of node's ServerResponse.
function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

// Anything under lib/ touched after boot is already cached by Node and cannot be reloaded
// in place — editing a handler is fine, editing a lib it imports is not.
const STARTED_AT = Date.now();
const ROOT = path.dirname(API);
const LIB = path.join(ROOT, 'lib');

// PER HANDLER, NOT PER SERVER. This check used to refuse a request when ANY file under lib/ had
// changed, which made it wildly over-broad: touching lib/scrape-price.js blocked /api/cakemail-sync,
// which does not import it and never did. In practice that meant a price-pipeline edit took the
// whole local app down with "restart the dev server" on endpoints that were perfectly fine, and
// the error named seven files none of which the failing endpoint uses.
//
// So the import graph is walked instead, from the handler outward, and only the libs it actually
// reaches can stale it. Static imports only — nothing in api/ or lib/ uses import(), so a regex
// over the source is exact here rather than an approximation. If a dynamic import is ever added,
// this under-reports and the symptom is the old "does not provide an export named X"; the fix is
// to list it here, not to widen the check back out.
const importsOf = (file) => {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  // `import … from './x.js'` and bare `import './x.js'`, single or double quoted.
  const re = /\bimport\s*(?:[\s\S]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g;
  for (let m; (m = re.exec(src));) out.push(path.resolve(path.dirname(file), m[1]));
  return out;
};

// Memoised: the graph only changes when a file changes, and a changed file is exactly the case
// this reports rather than needs to re-walk. Cheap enough either way — four files deep at most.
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
  const libs = libsReachedBy(entry);
  const stale = [];
  for (const f of libs) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs > STARTED_AT) stale.push(path.relative(ROOT, f).replace(/\\/g, '/'));
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
  decorate(res);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---- API routes ----
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length).replace(/[^a-zA-Z0-9_-]/g, '');
    const file = path.join(API, name + '.js');
    if (!name || !fs.existsSync(file)) { res.status(404).json({ error: `no such function: /api/${name}` }); return; }

    req.query = Object.fromEntries(url.searchParams);
    const raw = await readBody(req);
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }

    // The cache-buster below only reloads the HANDLER. Modules it imports statically
    // (lib/*.js) resolve to their plain URL, which Node has cached since first use, so a lib
    // edit stays invisible until this process restarts. The symptom is a baffling
    // "does not provide an export named X" from a file that plainly exports it. A specifier
    // inside a module can't be rewritten from out here, so refuse rather than run stale code.
    const staleLib = changedLibFiles(file);
    if (staleLib.length) {
      console.error(`\n  /api/${name} imports ${staleLib.join(', ')}, which changed after this server started — Node still has the old copy.`);
      console.error('  Restart the dev server (Ctrl-C, then run it again).\n');
      // Names the endpoint as well as the files, because the old message listed everything under
      // lib/ and left the reader to work out which of seven files the failing call even used.
      res.status(503).json({ error: `dev server is running stale code: /api/${name} imports ${staleLib.join(', ')} — changed after start. Restart the dev server.` });
      console.log(`${req.method} ${pathname} -> ${res.statusCode}`);
      return;
    }
    try {
      // cache-bust so editing a handler doesn't need a restart
      const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
      await (mod.default || mod.handler)(req, res);
      if (!res.writableEnded) res.status(500).json({ error: 'handler returned without responding' });
    } catch (err) {
      console.error(`[api/${name}]`, err);
      if (!res.writableEnded) res.status(500).json({ error: String((err && err.message) || err) });
    }
    console.log(`${req.method} ${pathname} -> ${res.statusCode}`);
    return;
  }

  // ---- static files from ui/ ----
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(rel)) rel += '.html';               // cleanUrls, matching vercel.json
  const file = path.join(UI, rel);
  if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.status(404).end('Not found: ' + pathname);
    console.log(`${req.method} ${pathname} -> 404`);
    return;
  }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

// ---------------------------------------------------------------------------------------------
// ui/config.js IS GENERATED, so regenerate it on boot.
//
// scripts/gen-config.js writes the browser's Supabase URL, anon key and webhook URLs out of the
// environment. Vercel runs it as the build step; locally nothing did — in THIS file. The .mjs
// twin has always regenerated on boot, which is the drift its own header warns about: change a
// client-side value in .env, start the server you happen to run, and the browser quietly keeps
// the config from whenever the file was last written by hand.
//
// A CHILD PROCESS, not require(). gen-config.js runs its work at import time and writes on load,
// so require()ing it here would work exactly once per process and be invisible as a dependency.
// Spawning it is honest about what it is — a build step — and inherits process.env, which
// --env-file has already populated, so the child sees the same values without being told.
//
// SYNCHRONOUS, so the file is on disk before the first request can ask for it.
function regenConfig(why) {
  try {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-config.js')], { stdio: 'pipe' });
    console.log(`  ui/config.js   regenerated${why ? ' (' + why + ')' : ''}`);
  } catch (e) {
    // Never fatal. A stale config.js still serves the app; a dev server that refuses to start
    // because of its build step does not.
    console.warn('  gen-config failed:', (e.stderr ? String(e.stderr).trim() : e.message).slice(0, 200));
  }
}
regenConfig();

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
// api/ IS NOT WATCHED. Handlers are re-imported per request with a cache-buster, so they are
// already live; restarting on those would throw away a working process for no reason.
function watchLibsAndRestart() {
  const WATCHED = path.join(ROOT, 'lib');
  if (!fs.existsSync(WATCHED)) return;

  // .env TOO. Its server-side half needs a restart to be re-read, and its client-side half needs
  // config.js rewritten — so one edit needs both, which is exactly the pair a person forgets.
  const ENV = path.join(ROOT, '.env');
  if (fs.existsSync(ENV)) {
    let envTimer = null;
    fs.watch(ENV, () => {
      clearTimeout(envTimer);
      // firstSeen is what caps the in-flight wait. Without setting it the cap is measured from
      // 0, the wait is skipped, and an .env edit would drop a request a lib/ edit would not.
      envTimer = setTimeout(() => {
        regenConfig('.env changed');
        if (!firstSeen) firstSeen = Date.now();
        changed.add('.env');
        restart();
      }, 250);
    });
  }
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
      const { spawn } = require('child_process');
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
  const has = (k) => (process.env[k] ? 'set' : '—');
  console.log(`dev server  http://localhost:${PORT}`);
  console.log(`  ui/           ${UI}`);
  console.log(`  functions     ${fs.readdirSync(API).filter(f => f.endsWith('.js')).map(f => '/api/' + f.replace(/\.js$/, '')).join(', ')}`);
  // Which way the OpenAI-shaped endpoints are routing. Getting this wrong is invisible
  // otherwise — both paths answer identically until the bill or a refusal shows up.
  const route = process.env.OPENROUTER_OPENAI ? 'OpenRouter (openai/*)' : (process.env.OPENAI_API_KEY ? 'OpenAI direct' : 'none -> Anthropic fallback');
  console.log(`  llm route     ${route}`);
  console.log(`  env           OPENROUTER_OPENAI=${has('OPENROUTER_OPENAI')}  OPENAI_API_KEY=${has('OPENAI_API_KEY')}  ANTHROPIC_API_KEY=${has('ANTHROPIC_API_KEY')}  GEMINI_API_KEY=${has('GEMINI_API_KEY')}  REPLY_SECRET=${has('REPLY_SECRET')}  TELNYX_API_KEY=${has('TELNYX_API_KEY')}`);
});
