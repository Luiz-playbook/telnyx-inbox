/* Level-1 auth gate — Google sign-in, restricted to @callplaybook.com.
   Shared by index.html and lookup.html. Self-contained: injects its own styles,
   a full-screen login overlay, and a small signed-in bar. This is a UI gate
   (it hides the app until an allowed Google account signs in); the underlying
   Supabase anon endpoints are unchanged.

   Auth runs against THIS app's Supabase project only (from INBOX_CONFIG /
   config.js). It never touches any other project.

   Anti-flash: the page <head> adds `html.pb-gated body{visibility:hidden}` and
   sets the `pb-gated` class immediately, so the app never paints before auth
   resolves. We remove the class once an allowed account is confirmed. */
(function () {
  'use strict';
  var ALLOWED_DOMAIN = 'callplaybook.com';
  var cfg = window.INBOX_CONFIG || {};

  function reveal() {
    document.documentElement.classList.remove('pb-gated');
    var g = document.getElementById('pb-auth-gate');
    if (g) g.remove();
  }
  function emailOk(email) {
    return !!email && ('@' + ALLOWED_DOMAIN) === email.toLowerCase().slice(-(ALLOWED_DOMAIN.length + 1));
  }

  // If Supabase isn't configured we can't authenticate — stay gated with a message.
  var configured = window.supabase && cfg.SUPABASE_URL && String(cfg.SUPABASE_URL).indexOf('<<') !== 0;
  var client = configured
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY,
        { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;
  if (client) window.__pbAuth = client;

  function signIn() {
    if (!client) return;
    client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { hd: ALLOWED_DOMAIN, prompt: 'select_account' },
      },
    });
  }
  function signOut() {
    if (!client) { location.reload(); return; }
    client.auth.signOut().then(function () { location.reload(); });
  }

  function googleSvg() {
    return '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">' +
      '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
      '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
      '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
      '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
      '</svg>';
  }

  function injectStyles() {
    if (document.getElementById('pb-auth-style')) return;
    var s = document.createElement('style');
    s.id = 'pb-auth-style';
    s.textContent =
      '#pb-auth-gate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:#0f2b36;background:radial-gradient(1200px 600px at 50% -10%,#1c4a5b 0,#0f2b36 60%);font-family:Nunito,system-ui,sans-serif;padding:24px}' +
      '.pb-auth-card{width:100%;max-width:380px;background:#fff;border-radius:16px;padding:32px 28px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.35)}' +
      '.pb-auth-brand{display:flex;align-items:center;justify-content:center;gap:8px;font-weight:800;letter-spacing:.08em;color:#133b49;font-size:14px}' +
      '.pb-auth-logo{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:#e55608;color:#fff;font-weight:800;font-size:14px}' +
      '.pb-auth-title{margin:16px 0 4px;font-size:22px;font-weight:800;color:#133b49}' +
      '.pb-auth-sub{margin:0 0 20px;font-size:14px;color:#64748b}' +
      '.pb-auth-google{display:inline-flex;align-items:center;justify-content:center;gap:10px;width:100%;border:1px solid #dbe3ea;border-radius:10px;' +
      'background:#fff;color:#1f2937;font-weight:700;font-size:14px;padding:11px 14px;cursor:pointer;transition:background .15s,box-shadow .15s}' +
      '.pb-auth-google:hover{background:#f6f9fc;box-shadow:0 2px 8px rgba(0,0,0,.08)}' +
      '.pb-auth-err{min-height:18px;margin:14px 0 0;font-size:13px;color:#c0392b;line-height:1.4}' +
      '.pb-auth-link{margin-top:8px;background:none;border:none;color:#e55608;font-weight:700;font-size:13px;cursor:pointer;text-decoration:underline}' +
      '#pb-auth-user{position:fixed;top:8px;right:10px;z-index:9998;display:flex;align-items:center;gap:8px;' +
      'background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);border-radius:9999px;padding:3px 4px 3px 12px;font-family:Nunito,system-ui,sans-serif}' +
      '.pb-auth-user-email{font-size:12px;font-weight:600;color:#fff;opacity:.9;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.pb-auth-user-out{font-size:12px;font-weight:700;color:#133b49;background:#fff;border:none;border-radius:9999px;padding:4px 12px;cursor:pointer}' +
      '.pb-auth-user-out:hover{background:#ffe9db;color:#c0392b}';
    document.head.appendChild(s);
  }

  function injectGate() {
    if (document.getElementById('pb-auth-gate')) return;
    var g = document.createElement('div');
    g.id = 'pb-auth-gate';
    g.innerHTML =
      '<div class="pb-auth-card">' +
        '<div class="pb-auth-brand"><span class="pb-auth-logo">P</span> PLAYBOOK</div>' +
        '<div class="pb-auth-title">Marketing Blaster</div>' +
        '<p class="pb-auth-sub">Sign in with your Playbook Google account to continue.</p>' +
        '<button id="pb-auth-btn" class="pb-auth-google">' + googleSvg() + '<span>Sign in with Google</span></button>' +
        '<p id="pb-auth-msg" class="pb-auth-err"></p>' +
        '<button id="pb-auth-signout" class="pb-auth-link" style="display:none">Use a different account</button>' +
      '</div>';
    document.body.appendChild(g);
    g.querySelector('#pb-auth-btn').addEventListener('click', signIn);
    g.querySelector('#pb-auth-signout').addEventListener('click', signOut);
    if (!configured) showGate('Sign-in is unavailable: this deployment has no Supabase configured.', false);
  }

  function showGate(msg, showButton) {
    var g = document.getElementById('pb-auth-gate'); if (!g) return;
    var m = g.querySelector('#pb-auth-msg'); if (m) m.textContent = msg || '';
    var btn = g.querySelector('#pb-auth-btn'); if (btn) btn.style.display = showButton === false ? 'none' : '';
    var out = g.querySelector('#pb-auth-signout');
    if (out) out.style.display = (msg && showButton !== false) ? '' : 'none';
  }

  function injectSignedInBar(email) {
    if (document.getElementById('pb-auth-user')) return;
    var b = document.createElement('div');
    b.id = 'pb-auth-user';
    b.innerHTML = '<span class="pb-auth-user-email"></span><button class="pb-auth-user-out">Sign out</button>';
    b.querySelector('.pb-auth-user-email').textContent = email;
    document.body.appendChild(b);
    b.querySelector('.pb-auth-user-out').addEventListener('click', signOut);
  }

  function resolve(session) {
    var email = session && session.user && session.user.email;
    if (session && emailOk(email)) {
      injectSignedInBar(email);
      reveal();
    } else if (session && !emailOk(email)) {
      showGate('That account (' + (email || 'unknown') + ') is not allowed. Sign in with your @' + ALLOWED_DOMAIN + ' account.', true);
    } else {
      showGate('', true);
    }
  }

  function start() {
    injectStyles();
    injectGate();
    if (!client) return; // stays gated with the "unavailable" message
    client.auth.getSession().then(function (res) { resolve(res.data.session); });
    client.auth.onAuthStateChange(function (_evt, session) { resolve(session); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
