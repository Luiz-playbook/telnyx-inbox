// AI-1097: Kernel hosted browser as a fetch step, for the pages the HTTP ladder cannot reach.
//
// WHY A REAL BROWSER AT ALL. lib/scrape-price.js gets section-level listings from exactly one
// site (Gametime) because that is the only marketplace that serves them to a plain request.
// Everything else that publishes a section sits behind a bot wall. Measured 2026-10-07, plain
// HTTP with a desktop UA, straight at the event pages:
//
//   TickPick  event page  Cloudflare managed challenge ("Just a moment...")
//   SeatGeek  event page  403, DataDome  (geo.captcha-delivery.com)
//   StubHub   event page  403, DataDome  (geo.captcha-delivery.com)
//   Vivid     event page  200 + Imperva proof-of-work interstitial ("Challenge Validation")
//
// The team pages of those same sites are open — they are SEO surfaces and carry a JSON-LD
// lowPrice per game, which is why the ladder uses them and why it can only ever report a
// get-in with no section. The event pages are the ones with the seats, and they are walled.
// A 200 is not a result here: Vivid answers the wall with 200 and 1.9KB, and the Imperva and
// Cloudflare pages are both 200. Wall detection is therefore explicit, below.
//
// WHAT KERNEL ACTUALLY BUYS US (measured, free tier, no proxy):
//   Vivid     Imperva cleared in ~9s, full listings reachable
//   TickPick  Cloudflare "Verification successful" — clears the challenge
//   SeatGeek  DataDome does NOT clear; still walled after 45s
//   StubHub   DataDome does NOT clear; still walled after 45s
//
// The two DataDome sites almost certainly need a residential egress IP — Kernel's own IP is a
// datacenter one, which DataDome scores on reputation before it ever looks at the browser.
// Kernel sells residential proxies but gates them behind a PAID PLAN: POST /browsers with a
// proxy on the free tier answers 403 insufficient_plan. So SeatGeek and StubHub stay out of
// reach until someone upgrades, and this module is written so that flipping KERNEL_PROXY_ID on
// is the only change needed to retest them.
//
// COST SHAPE. This is a per-session hosted browser, ~9-12s a page against ~1.2-2.7s for plain
// HTTP. It is never the cheap step and must never be the first one — it sits at the BOTTOM of
// the ladder, after Firecrawl, and only for hosts that have already refused everything above.
//
// NO DEPENDENCIES. This repo has no package.json; it runs on Node's globals on Vercel. CDP is
// therefore driven over the built-in WebSocket (stable since Node 22) rather than Playwright.

const API = 'https://api.onkernel.com';

const KEY = () => (process.env.KERNEL_API_KEY || '').trim();
const PROXY_ID = () => (process.env.KERNEL_PROXY_ID || '').trim();
// Read by the probe scripts, which pass the result in explicitly. Deliberately NOT a default
// for either session factory — see profileId in kernelPage.
export const PROFILE_ID = () => (process.env.KERNEL_PROFILE_ID || '').trim();

// A Kernel session name the dashboard can be read at a glance, from parts a caller already has.
//
//   sessionName(['ai1097', 'stubhub', 'headful+isp'])  ->  ai1097-stubhub-headful-isp-1009-1432
//
// The API refuses anything outside ^[a-zA-Z0-9._-]+$ and refuses a name that is already live in
// the project, so this slugifies and then appends a minute-resolution stamp. The stamp is not
// decoration: without it, two runs of the same script five minutes apart collide on 409, and
// that failure would surface as "could not open a browser" rather than as a naming problem.
export function sessionName(parts) {
  const base = (Array.isArray(parts) ? parts : [parts])
    .filter(Boolean)
    .map(s => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'))
    .join('-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  const d = new Date();
  const two = n => String(n).padStart(2, '0');
  const stamp = `${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  // Kernel's ceiling is not documented; 64 is comfortably inside it and still readable.
  return `${base}`.slice(0, 64 - stamp.length - 1) + '-' + stamp;
}

// Ceiling on one CDP command. Generous — a navigation can legitimately take a while — but finite,
// because a wedged browser otherwise hangs the caller indefinitely (see `send` below).
const CMD_TIMEOUT_MS = Number(process.env.KERNEL_CMD_TIMEOUT_MS || 25000);

// A wall answers 200 as often as it answers 403, so the body is what decides. Each entry is
// [label, marker] and the marker is matched lowercased against the whole document.
const WALLS = [
  ['datadome', 'captcha-delivery'],
  ['imperva', 'challenge validation'],
  ['cloudflare', '_cf_chl_opt'],
  ['cloudflare', 'just a moment'],
  ['denied', 'access denied'],
  ['denied', 'pardon our interruption'],
];

export function detectWall(html) {
  const low = String(html || '').toLowerCase();
  for (const [label, marker] of WALLS) if (low.includes(marker)) return label;
  return '';
}

async function api(path, opt = {}) {
  const key = KEY();
  if (!key) throw new Error('KERNEL_API_KEY not set');
  const r = await fetch(API + path, {
    ...opt,
    headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json', ...(opt.headers || {}) },
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`kernel ${path} -> ${r.status} ${String(json.message || text).slice(0, 200)}`);
    err.status = r.status;
    err.code = json.code;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------------------------
//
// Only what this module needs: request/response correlation by id, event subscription, and
// session-scoped sends (flattened sessions, so one socket carries both browser and page scope).

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const subs = [];

  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) {
      for (const s of subs) if (s.method === m.method) { try { s.cb(m.params); } catch { /* listener must not kill the socket */ } }
    }
  });

  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('kernel cdp socket error')));
    ws.addEventListener('close', () => { for (const p of pending.values()) p.reject(new Error('cdp socket closed')); pending.clear(); });
  });

  return {
    open,
    on: (method, cb) => subs.push({ method, cb }),
    // EVERY COMMAND IS TIMED, and this is not belt-and-braces.
    //
    // A Kernel browser can stop answering while its socket stays open — the session hit its own
    // idle timeout, or the page wedged. CDP then neither resolves nor rejects, and a caller that
    // awaits it waits forever. Measured the hard way: a 5-game run sat on one Runtime.evaluate
    // for 17 minutes with no output and no error, because the poll loop in goto() only checks
    // its deadline AFTER the await returns.
    //
    // The rest of this repo already works this way — fetchLadder wraps every step in timed().
    send(method, params = {}, sessionId, ms = CMD_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`cdp ${method} timed out after ${ms}ms`));
        }, ms);
        const done = fn => v => { clearTimeout(timer); fn(v); };
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
      });
    },
    close: () => { try { ws.close(); } catch { /* already gone */ } },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// kernelPage
// ---------------------------------------------------------------------------------------------
//
// Opens one hosted browser, navigates, and polls the LIVE DOM until the page is worth reading.
// Polling rather than waiting on Page.loadEventFired because every wall here fires load on the
// interstitial: Cloudflare then swaps the document in place once its challenge passes, so the
// only reliable signal is the document itself.
//
// `ready(html)` decides when to stop. Pass the same extractor the parser uses and the loop ends
// the moment real data is present; without one it waits for any non-wall document. The timeout
// returns whatever the last poll saw, with `wall` set, so the caller can log WHY it failed
// rather than recording an empty success.
//
// `captureJson` additionally records XHR/fetch JSON bodies. Vivid needs this: its event page
// holds no listings at all, they arrive from hermes/api/v1/listings after the shell renders.

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------
//
// ONE SESSION, MANY PAGES. A Kernel browser bills for the wall-clock it is alive, and the free
// tier is a small allowance, so opening a session per page is the expensive way to do everything.
// A session handle instead navigates repeatedly: a 5-game run over two sites is one browser that
// visits ten pages, not ten browsers. It also keeps the cleared challenge cookies, so the second
// page on a host that walled the first usually loads straight away.
//
// `fetchInPage` is the other reason this exists. Vivid's event page carries NO listings — they
// arrive from hermes/api/v1/listings afterwards — and that endpoint is behind the same Imperva
// wall as the page, so it cannot be called from Node. Issuing the fetch from INSIDE the page
// sends it with the browser's own cookies, origin and TLS fingerprint, which is the only way to
// read it. It also lets us pin currency=USD: Kernel's egress came out of Canada on first run and
// the endpoint localises to CAD, and a price in the wrong currency is worse than no price.

export async function openKernelSession(opts = {}) {
  // timeout_seconds is Kernel's own idle reaper. One session now spans a whole run, so it has to
  // outlive the run or the browser is reaped mid-game — which is exactly how the hang above
  // presented. 30 minutes, and close() still runs on every path.
  const { stealth = true, proxyId = PROXY_ID(), profileId = '', timeoutSeconds = 1800,
    replay = false, headless = true, name = '', tags = null } = opts;
  // THE FIELD IS `stealth`, NOT `stealth_mode`.
  //
  // The API accepts stealth_mode silently, ignores it, and answers with stealth:false — so an
  // entire POC can run believing it tested stealth when it tested plain Chromium. Verified by
  // reading back GET /browsers/{id}: `{"stealth":true}` only ever appears with this spelling.
  // Always confirm against the create response rather than trusting the request.
  //
  // Stealth is not only a fingerprint change: per Kernel's docs it also attaches an ISP proxy
  // and an automatic CAPTCHA solver by default. That matters because those are exactly what the
  // DataDome and Cloudflare walls key on, and they are NOT the separately paid residential
  // proxy — so stealth is worth testing on its own before concluding a plan upgrade is required.
  //
  // Replays need headful: a headless session answers POST /replays with "headless browsers
  // don't support replays at this time". So asking for a recording forces headless off.
  const body = { stealth: !!stealth, headless: replay ? false : !!headless, timeout_seconds: timeoutSeconds };
  if (proxyId) body.proxy = { id: proxyId };
  // A saved profile carries cookies and local storage between sessions, so the second visit is
  // a RETURNING browser rather than another brand-new device. On a reputation system that is a
  // different signal entirely from a fresh fingerprint, and it is the one thing AI-1097 asked
  // for by name that had never been tried.
  if (profileId) body.profile = { id: profileId, save_changes: true };
  // A READABLE NAME IN THE DASHBOARD. Without one, every session is a 24-character id and
  // finding "the headful StubHub run with the ISP proxy" means opening them one at a time.
  //
  // Two rules the API enforces, both learned by being refused:
  //   * ^[a-zA-Z0-9._-]+$ — a space is a 400, so the name has to be a slug.
  //   * unique per project while the session is live — reusing one is a 409 conflict.
  // sessionName() below does both, which is why callers pass parts rather than a string.
  if (name) body.name = sessionName(name);
  // tags are a separate map the API also stores, and unlike the name they can repeat. Good for
  // the things you would want to group by later — the ticket, the site, the configuration.
  if (tags && typeof tags === 'object') body.tags = tags;

  let session;
  try {
    session = await api('/browsers', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (e.code === 'insufficient_plan') throw new Error('kernel: proxies need a paid plan (KERNEL_PROXY_ID set); unset it or upgrade');
    throw e;
  }
  const id = session.session_id || session.id;
  // Read back what the server GRANTED, not what we asked for.
  const granted = { stealth: session.stealth === true, headless: session.headless !== false,
    proxy: (session.proxy && (session.proxy.mode || session.proxy.id)) || null,
    profile: (session.profile && session.profile.id) || null,
    name: session.name || null, tags: session.tags || null };

  // COST. Kernel bills GB-seconds — $0.0000166667 per GB-second, with stealth, the captcha
  // solver and proxies included and no charge for idle time (kernel.sh/pricing, Oct 2026).
  // So the only two variables are how much memory the session was given and how long it lived.
  //
  // MEMORY IS NOT A CONSTANT, and it is the whole cost story: a headless session came back with
  // 1GiB and a headful one with 8GiB. Headful therefore costs 8x per second — which is why
  // recording a replay (headful-only) is a deliberate choice for a demo rather than something
  // to leave on in production.
  const memGb = Number(String(session.memory || '1').replace(/[^0-9.]/g, '')) || 1;
  const startedAt = Date.now();
  const GB_SECOND_USD = 0.0000166667;

  const c = cdp(session.cdp_ws_url);
  await c.open;
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  await c.send('Page.enable', {}, sid);

  let pages = 0;

  // A replay is a RECORDING, not the live view. The dashboard shows "live view not available in
  // headless mode", which is about watching in real time; a replay still records headless and is
  // what gets shared after the run. It has to be started before the navigating and stopped
  // afterwards, or there is nothing to persist.
  let replayId = null;
  let replayViewUrl = null;
  if (replay) {
    const r = await api(`/browsers/${id}/replays`, { method: 'POST', body: '{}' }).catch(() => null);
    replayId = r && (r.replay_id || r.id || r.replayId);
    replayViewUrl = (r && r.replay_view_url) || null;
  }

  return {
    id,
    granted,
    live_view_url: session.browser_live_view_url || null,
    get replay_id() { return replayId; },
    get pages() { return pages; },

    // What this session has cost so far, measured rather than guessed.
    cost() {
      const seconds = (Date.now() - startedAt) / 1000;
      return {
        memory_gb: memGb,
        seconds: Math.round(seconds),
        gb_seconds: Math.round(memGb * seconds),
        usd: Number((memGb * seconds * GB_SECOND_USD).toFixed(4)),
        rate: '$0.0000166667 per GB-second (stealth + proxies included)',
      };
    },

    // Navigate and poll the live DOM until `ready(html)` is happy, or until any non-wall
    // document is up. Returns {status, html, wall, ms}.
    async goto(url, o = {}) {
      const { ready = null, timeoutMs = 60000, pollMs = 2500 } = o;
      const t0 = Date.now();
      pages++;
      await c.send('Page.navigate', { url }, sid).catch(e => { throw new Error('navigate: ' + e.message); });
      let html = '', wall = '', misses = 0;
      while (Date.now() - t0 < timeoutMs) {
        await sleep(pollMs);
        const got = await c.send('Runtime.evaluate',
          { expression: 'document.documentElement.outerHTML', returnByValue: true }, sid).catch(() => null);
        // Three dead commands in a row means the browser is gone, not slow — Kernel reaped the
        // session, or the page wedged. Polling a corpse for the rest of the window just burns
        // the run's clock and reports a timeout instead of the real cause.
        if (!got) { if (++misses >= 3) return { status: 0, html, wall: 'session lost', ms: Date.now() - t0 }; continue; }
        misses = 0;
        html = (got.result && got.result.value) || html;
        wall = detectWall(html);
        if (wall) continue;
        if (ready) { if (ready(html)) break; } else if (html.length > 20000) break;
      }
      return { status: wall ? 403 : 200, html, wall, ms: Date.now() - t0 };
    },

    // NAVIGATE THE BROWSER TO A JSON ENDPOINT AND READ WHAT IT RENDERS.
    //
    // This is the honest "through Kernel" path and it is what fetchInPage is not: no XHR, no
    // cross-origin anything, just the browser loading a URL with its own cookies, TLS
    // fingerprint and challenge state, exactly as it loads a page.
    //
    // It exists because fetchInPage ran into CORS. Gametime's listings live on
    // mobile.gametime.co while the event page is gametime.co, so a fetch from inside the page is
    // cross-origin and dies with "TypeError: Failed to fetch" — and worse, the failure left the
    // page context unusable, so every later evaluate on that session returned nothing. One bad
    // call poisoned the whole run. Navigation has neither problem, and works for same-origin
    // endpoints (Vivid) just as well.
    //
    // Chrome renders a JSON response as text, so body.innerText is the payload.
    async gotoJson(url, o = {}) {
      const { timeoutMs = 45000 } = o;
      const t0 = Date.now();
      pages++;
      await c.send('Page.navigate', { url }, sid).catch(e => { throw new Error('navigate: ' + e.message); });
      let text = '', wall = '';
      while (Date.now() - t0 < timeoutMs) {
        await sleep(1500);
        const got = await c.send('Runtime.evaluate',
          { expression: '(document.body && (document.body.innerText || document.body.textContent)) || ""', returnByValue: true }, sid).catch(() => null);
        if (!got) continue;
        text = (got.result && got.result.value) || '';
        wall = detectWall(text);
        if (wall) continue;
        // JSON starts with a brace or a bracket. Anything else is still the shell, an error page
        // or a challenge, and is not worth handing to a parser.
        const t = text.trim();
        if (t.startsWith('{') || t.startsWith('[')) break;
      }
      const t = text.trim();
      const ok = !wall && (t.startsWith('{') || t.startsWith('['));
      return { ok, body: t, wall, ms: Date.now() - t0, status: ok ? 200 : (wall ? 403 : 0) };
    },

    // Run an expression in the current page and return its value. Used to scroll, to read
    // performance entries when hunting for a site's own API, and to count rendered rows.
    async eval(expression, o = {}) {
      const got = await c.send('Runtime.evaluate',
        { expression, awaitPromise: !!o.await, returnByValue: true }, sid).catch(() => null);
      return got && got.result ? got.result.value : null;
    },

    // Same-origin fetch from inside the current page. Must be called AFTER goto on that origin.
    // Prefer gotoJson unless you specifically need the request issued as an XHR.
    async fetchInPage(url) {
      const expr = `(async () => { try {
        const r = await fetch(${JSON.stringify(url)}, { headers: { accept: 'application/json' }, credentials: 'include' });
        const t = await r.text();
        return JSON.stringify({ ok: r.ok, status: r.status, body: t });
      } catch (e) { return JSON.stringify({ ok: false, status: 0, body: '', error: String(e) }); } })()`;
      const got = await c.send('Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true }, sid).catch(e => ({ error: e }));
      const raw = got && got.result && got.result.value;
      if (!raw) return { ok: false, status: 0, body: '', error: 'no result from page' };
      try { return JSON.parse(raw); } catch { return { ok: false, status: 0, body: '', error: 'unparseable' }; }
    },

    // Stop the recording and hand back where it lives. Must happen BEFORE the session is
    // deleted — stopping is what persists the video.
    async stopReplay() {
      if (!replayId) return null;
      await api(`/browsers/${id}/replays/${replayId}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
      return {
        replay_id: replayId,
        session_id: id,
        // Watch in the browser (no auth needed, the jwt is in the link), or download the file.
        view_url: replayViewUrl,
        download_url: `${API}/browsers/${id}/replays/${replayId}`,
      };
    },

    async close() {
      const r = await this.stopReplay().catch(() => null);
      c.close();
      await api('/browsers/' + id, { method: 'DELETE' }).catch(() => {});
      return r;
    },
  };
}

export async function kernelPage(url, opts = {}) {
  const {
    ready = null,
    timeoutMs = 60000,
    pollMs = 2500,
    captureJson = false,
    stealth = true,
    proxyId = PROXY_ID(),
    // Default EMPTY, not PROFILE_ID(), even though the env var exists. A profile set for a
    // probe script would otherwise attach itself to the production ladder the moment the env
    // var was in scope — the same "silently joined the ladder" problem PRICE_SCRAPE_KERNEL
    // exists to prevent. Callers that want a profile pass one.
    profileId = '',
    replay = false,
  } = opts;

  const t0 = Date.now();
  // THE FIELD IS `stealth`, NOT `stealth_mode` — see openKernelSession. This function still had
  // the old spelling, so every ladder call through viaKernel ran non-stealth while reporting
  // that it had asked for stealth.
  const body = { stealth: !!stealth, headless: true, timeout_seconds: Math.ceil(timeoutMs / 1000) + 60 };
  if (proxyId) body.proxy = { id: proxyId };
  // A saved profile carries cookies and local storage between sessions, so the second visit is
  // a RETURNING browser rather than another brand-new device. On a reputation system that is a
  // different signal entirely from a fresh fingerprint, and it is the one thing AI-1097 asked
  // for by name that had never been tried.
  if (profileId) body.profile = { id: profileId, save_changes: true };

  let session;
  try {
    session = await api('/browsers', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    // The free tier refuses proxies outright. Say so plainly — this is the one error that
    // changes what someone should DO, rather than something to retry.
    if (e.code === 'insufficient_plan') throw new Error('kernel: proxies need a paid plan (KERNEL_PROXY_ID set); unset it or upgrade');
    throw e;
  }

  const sessionId = session.session_id || session.id;
  const json = [];
  let replayId = null;

  try {
    const c = cdp(session.cdp_ws_url);
    await c.open;

    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Page.enable', {}, sid);

    if (captureJson) {
      const want = [];
      await c.send('Network.enable', {}, sid);
      c.on('Network.responseReceived', p => {
        const type = p.type;
        const mime = (p.response && p.response.mimeType) || '';
        if (type === 'XHR' || type === 'Fetch' || mime.includes('json')) {
          want.push({ requestId: p.requestId, url: p.response.url, status: p.response.status });
        }
      });
      // Bodies are fetched after settling; Chrome evicts them, so this list is drained below.
      json.pending = want;
    }

    if (replay) {
      const r = await api(`/browsers/${sessionId}/replays`, { method: 'POST', body: '{}' }).catch(() => null);
      replayId = r && (r.replay_id || r.id);
    }

    await c.send('Page.navigate', { url }, sid);

    let html = '';
    let wall = '';
    const deadline = t0 + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const got = await c.send('Runtime.evaluate',
        { expression: 'document.documentElement.outerHTML', returnByValue: true }, sid).catch(() => null);
      html = (got && got.result && got.result.value) || html;
      wall = detectWall(html);
      if (wall) continue;                       // challenge still up; it may swap itself out
      if (ready) { if (ready(html)) { wall = ''; break; } }
      else if (html.length > 20000) break;      // no predicate: any substantial non-wall document
    }

    if (captureJson && json.pending) {
      for (const r of json.pending) {
        const b = await c.send('Network.getResponseBody', { requestId: r.requestId }, sid).catch(() => null);
        if (b && b.body) json.push({ url: r.url, status: r.status, body: b.body });
      }
      delete json.pending;
    }

    let replayUrl = null;
    if (replayId) {
      await api(`/browsers/${sessionId}/replays/${replayId}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
      replayUrl = `${API}/browsers/${sessionId}/replays/${replayId}`;
    }

    c.close();
    return {
      status: wall ? 403 : 200,   // a wall is a refusal whatever HTTP code carried it
      html,
      json,
      wall,
      ms: Date.now() - t0,
      live_view_url: session.browser_live_view_url || null,
      replay_url: replayUrl,
    };
  } finally {
    // Sessions bill for wall-clock, so this must happen on every path.
    await api('/browsers/' + sessionId, { method: 'DELETE' }).catch(() => {});
  }
}

// Ladder-shaped adapter: same {status, html, note} contract as viaPlain / viaCrawl4ai /
// viaFirecrawl in lib/scrape-price.js, so Kernel can be appended as a step without the
// parsers knowing anything changed.
export async function viaKernel(url, extract) {
  const r = await kernelPage(url, {
    ready: extract ? html => { try { return !!extract(html); } catch { return false; } } : null,
  });
  return { status: r.status, html: r.html, note: r.wall ? `kernel: ${r.wall} wall` : '' };
}
