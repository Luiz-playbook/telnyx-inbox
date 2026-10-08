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

const server = http.createServer(async (req, res) => {
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
