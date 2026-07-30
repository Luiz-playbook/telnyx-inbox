// Local dev server: serves ui/ AND runs the api/ serverless functions, so /api/draft
// and /api/lookup work without the Vercel CLI. Zero dependencies.
//
//   node --env-file=.env scripts/dev-server.js
//
// Vercel is still the real runtime; this just mimics enough of it (req.query, req.body,
// res.status().json()) to exercise the handlers locally with the same env vars.
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
const LIB = path.join(path.dirname(API), 'lib');
function changedLibFiles() {
  if (!fs.existsSync(LIB)) return [];
  return fs.readdirSync(LIB)
    .filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
    .filter(f => fs.statSync(path.join(LIB, f)).mtimeMs > STARTED_AT)
    .map(f => `lib/${f}`);
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
    const staleLib = changedLibFiles();
    if (staleLib.length) {
      console.error(`\n  ${staleLib.join(', ')} changed after this server started — Node still has the old copy.`);
      console.error('  Restart the dev server (Ctrl-C, then run it again).\n');
      res.status(503).json({ error: `dev server is running stale code: ${staleLib.join(', ')} changed after start. Restart the dev server.` });
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
  console.log(`  env           ANTHROPIC_API_KEY=${has('ANTHROPIC_API_KEY')}  OPENAI_API_KEY=${has('OPENAI_API_KEY')}  REPLY_SECRET=${has('REPLY_SECRET')}  TELNYX_API_KEY=${has('TELNYX_API_KEY')}`);
});
