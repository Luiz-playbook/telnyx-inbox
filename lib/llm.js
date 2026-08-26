// One place that decides WHERE the OpenAI-shaped chat calls go.
//
// Five endpoints (chat, draft, queue-draft, decide, trigger-decide) all POST the same
// /chat/completions body. They used to each hardcode api.openai.com. This routes them,
// so the provider swap is one file instead of five drifting copies.
//
// ROUTING — decided per request, from env only:
//   OPENROUTER_OPENAI set  -> OpenRouter, model namespaced as "openai/<model>"
//   else OPENAI_API_KEY    -> OpenAI direct, model verbatim (the pre-migration path)
//   neither                -> ok:false, and the caller falls back to Anthropic or errors
//
// The fallback is the rollback: unset OPENROUTER_OPENAI and traffic goes straight back to
// OpenAI with no code change. On Vercel that still needs a redeploy for the functions to
// pick it up — faster than reverting a commit, but not instant.
//
// NOT ROUTED: the Gemini price path (lib/price.js). It calls Google's native endpoint with
// tools:[{google_search:{}}] for search grounding, which does not exist on OpenRouter's
// OpenAI-compatible surface. Routing it there would silently drop grounding — and the whole
// reason that file exists is that ungrounded models invent prices. It also feeds the cost
// figures in events_master_price_runs, which are grounding-per-request dominated, not token
// dominated, so an OpenRouter token-only cost would under-report the run by roughly the whole
// bill. Leave it on GEMINI_API_KEY.

const OPENAI_URL     = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// PROVIDER PINNING. OpenRouter load-balances "openai/gpt-4o" across upstreams — a smoke test
// on 2026-08-26 got Azure for two calls and OpenAI for the third, same model id. Azure applies
// its own content filter, and api/draft.js + api/queue-draft.js both branch on
// finish_reason === 'content_filter' — so an unpinned route can start refusing marketing
// rewrites that OpenAI has always accepted, intermittently, with no code change to blame.
//
// This migration is about billing, not resilience, so the default pins the same upstream the app
// already used and keeps behaviour identical. Set OPENROUTER_PROVIDER_ORDER to a comma-separated
// list to change it, or to the literal "any" to let OpenRouter route freely (which buys failover
// at the cost of the guarantee above).
function providerPref() {
  const raw = (process.env.OPENROUTER_PROVIDER_ORDER || 'OpenAI').trim();
  if (raw.toLowerCase() === 'any') return null;
  const order = raw.split(',').map(s => s.trim()).filter(Boolean);
  return order.length ? { order, allow_fallbacks: false } : null;
}

// OpenRouter needs a namespaced id: bare "gpt-4o" is a 400. An id that already carries a
// slash is passed through, so OPENAI_MODEL/DRAFT_MODEL can be set to "openai/gpt-4o" — or to
// another provider's model entirely — without this doubling the prefix.
function nsModel(model) {
  const m = String(model || '').trim();
  return m.includes('/') ? m : `openai/${m}`;
}

// Labels the traffic in OpenRouter's activity view. Cost attribution per app is the point of
// the migration, and without these every request shows up unattributed.
const ATTRIBUTION = {
  'HTTP-Referer': 'https://telnyx-inbox.vercel.app',
  'X-Title': 'Playbook Marketing Blaster',
};

// Resolve the target for one call. `model` is the bare id the endpoint already computed
// (e.g. process.env.OPENAI_MODEL || 'gpt-4o'); namespacing is applied here, not by callers.
export function openaiTarget(model) {
  const orKey = (process.env.OPENROUTER_OPENAI || '').trim();
  const oaKey = (process.env.OPENAI_API_KEY || '').trim();
  const key = orKey || oaKey;
  const via = orKey ? 'openrouter' : 'openai';
  return {
    ok: !!key,
    via,
    key,
    url: orKey ? OPENROUTER_URL : OPENAI_URL,
    model: orKey ? nsModel(model) : String(model || '').trim(),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...(orKey ? ATTRIBUTION : {}),
    },
    // Spread into the request body by callers. Empty on the direct-OpenAI path, so the
    // pre-migration request is byte-for-byte what it always was.
    body: orKey && providerPref() ? { provider: providerPref() } : {},
    // For error strings, so "OpenRouter HTTP 402" doesn't read as an OpenAI outage.
    label: orKey ? 'OpenRouter' : 'OpenAI',
  };
}
