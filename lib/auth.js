// Who is calling an api/ route.
//
// WHAT THIS REPLACES. Every user-facing route used to accept `x-inbox-secret: REPLY_SECRET`.
// scripts/gen-config.js writes REPLY_SECRET into ui/config.js, which Vercel serves as a static
// file — so the credential was published at telnyx-inbox.vercel.app/config.js and the check
// amounted to "did you read our homepage". Anyone could queue rows, overwrite drafted copy and
// spend our OpenAI/Gemini budget from a terminal.
//
// It got worse, not better, when the routes moved to the service-role key (lib/supabase.js):
// an unauthenticated caller now reaches data that bypasses RLS entirely. And once migration
// 052 revokes the anon key, these endpoints are the only soft way in that is left.
//
// So the header check is gone. There are exactly two kinds of legitimate caller:
//
//   'cron'  — Authorization: Bearer <CRON_SECRET>. Vercel Cron, the OpenClaw VPS, anything
//             else server-side. A real secret, never shipped to a browser.
//   'user'  — Authorization: Bearer <supabase access token>, from a signed-in browser. The
//             token is handed to Supabase for verification, so a forged one fails on
//             signature and there is nothing to guess.
//
// Both arrive as `Bearer`, which is why the cron secret is compared first: it is an exact
// string, and anything that is not it gets treated as a token.
//
// BREAKING FOR THE VPS. OPENCLAW.md §6 has the agent calling /api/queue-draft and
// /api/queue-tick with REPLY_SECRET. That stops working here — the VPS holds real secrets, so
// it should send Bearer CRON_SECRET instead. Same trip as swapping ~/.openclaw/supabase.env to
// the service-role key for 052; do both at once.
//
// REPLY_SECRET itself is NOT dead and has to stay in ui/config.js: the Compose tab posts
// straight to the n8n bulk-send webhooks, and that header is the gate those workflows expect.
// It is finished only as an INBOUND credential for our own routes. Publishing it stays
// acceptable for exactly as long as it opens nothing here — which is what this file enforces.

const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'callplaybook.com').trim().toLowerCase();

// null = reject. The caller decides the status code, because a browser route wants 401 while a
// cron-only route may prefer 404.
export async function requireCaller(req) {
  const raw = String(req.headers.authorization || '');
  const bearer = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  if (!bearer) return null;

  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (cronSecret && bearer === cronSecret) return { kind: 'cron', email: null };

  const supaUrl = process.env.SUPABASE_URL;
  // The anon key is the right one here and is not a weakness: /auth/v1/user tells you only who
  // the presented token belongs to. Verification is the token's signature, not this key.
  const anon = (process.env.SUPABASE_ANON_KEY || '').trim();
  if (!supaUrl || !anon) return null;

  let user = null;
  try {
    const r = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) return null;
    user = await r.json();
  } catch { return null; }

  // auth.users is SHARED with another project on this Supabase instance, so a valid token is
  // not by itself proof of a caller who belongs here. The domain is what this app gates on —
  // the same rule ui/index.html applies, enforced where a browser cannot skip it.
  const email = String((user && user.email) || '').toLowerCase();
  if (!email.endsWith('@' + DOMAIN)) return null;
  return { kind: 'user', email };
}

// The common case: reject with 401 and stop the handler. Returns the caller, or null when it
// has already answered the request.
export async function gate(req, res) {
  const caller = await requireCaller(req);
  if (!caller) {
    res.status(401).json({ error: 'unauthorized — sign in with a Playbook account' });
    return null;
  }
  return caller;
}
