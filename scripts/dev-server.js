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
