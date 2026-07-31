// Fills a queued blast's Email/SMS copy from Cole's templates.
//
// Queueing a market and writing its copy were separate steps, and only the first one
// happened: the OpenClaw cron leaves email_copy / sms_copy NULL, and Trigger Blast wrote
// the decider's note (diagnostics, not outreach) into them. This endpoint closes that gap
// so a queued row arrives with sendable copy a human can review and edit.
//
// TWO STAGES, AND THE ORDER MATTERS.
//
//   1. TOKEN FILL (deterministic, always runs). The template body from message_templates
//      is the source of truth; [GAME] / [DATE] / [SPORT] are substituted from the queue
//      row. This alone produces valid, sendable copy.
//   2. TAILOR (model, optional). One pass to fit the copy to this market, anchored to the
//      filled template. If it is unavailable, refuses, returns junk, or breaks any rule in
//      the validator below, stage 1's output is used instead. The model can only ever
//      improve on a result that is already correct — it is never the only thing standing
//      between a template and a send.
//
// WHY NO TOKENS MAY SURVIVE. One queue row is one blast to an entire market, and
// api/queue-tick.js sends email_copy verbatim (nl2br only, no substitution). A [NAME] or
// [GAME] left in the body goes out literally to every recipient. So the validator rejects
// any output still containing a [TOKEN], and stage 1 asserts the same before writing.
//
// Auth: cron bearer (CRON_SECRET) OR UI inbox-secret (REPLY_SECRET) — same as decide.js
// and trigger-decide.js, so both the browser and the VPS OpenClaw skill can call it.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, optional OPENAI_API_KEY (+ OPENAI_MODEL) or
//      ANTHROPIC_API_KEY, optional DRAFT_MODEL.

export const config = { maxDuration: 60 };

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// event_date is a PLAIN date and already local to the venue (see the note in
// docs/events-pipeline.md). Parsing it through Date() would shift it a day for half of
// every UTC day, so it is formatted from its own digits and never becomes a Date.
function prettyDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

// "<opponent> at <team>" — team is the HOME side, so the visitor is named first. Same
// convention as blastTitle() in ui/index.html; a row that has neither falls back to its
// stored title with the [TEST] marker stripped, because that marker is queue bookkeeping
// and must not appear in outreach.
function gameLabel(r) {
  if (r.team) return r.opponent ? `${r.opponent} at ${r.team}` : r.team;
  return String(r.title || '').replace(/^\s*\[TEST\]\s*/i, '').trim();
}

// Which pitch this game deserves. Cole wrote separate copy for a season opener, a playoff
// game and a club-seat offer, so a generic body on any of them is a worse blast.
//
// Detection is TEXT-BASED and therefore best-effort: the queue row carries no "this is a
// playoff game" flag, so the only evidence is how the fixture is named. Unrecognised =
// 'initial', which is always safe. `followup` wins over the event-type variants because a
// second touch to the same market has to acknowledge the first one.
function pickVariant(r, isFollowup) {
  if (isFollowup) return 'followup';
  const hay = `${r.title || ''} ${r.team || ''} ${r.opponent || ''}`.toLowerCase();
  if (/\b(playoff|play-in|wild ?card|round [1-4]|conference final|semi-final|finals?)\b/.test(hay)) return 'playoffs';
  if (/\b(season opener|home opener|opening (day|night))\b/.test(hay)) return 'season-opener';
  if (/\b(club seat|all-inclusive|suite)\b/.test(hay)) return 'club-seats';
  return 'initial';
}

function fillTokens(body, r) {
  return String(body || '')
    .replace(/\[GAME\]/g, gameLabel(r))
    .replace(/\[DATE\]/g, prettyDate(r.event_date))
    .replace(/\[SPORT\]/g, r.sport || 'sports');
}

const LEFTOVER = /\[[A-Z][A-Z_ ]{1,20}\]/;
const SMS_MAX = 480;

// A tailored body is only accepted if it is at least as safe as the fill it replaces.
// Anything that fails here is discarded silently in favour of stage 1 — a rejected tailor
// is not an error, it is the fallback working.
function tailorIsSafe(out, base) {
  if (!out || typeof out.email !== 'string' || typeof out.sms !== 'string') return false;
  if (!out.email.trim() || !out.sms.trim()) return false;
  if (LEFTOVER.test(out.email) || LEFTOVER.test(out.sms)) return false;   // rule: no tokens survive
  if (out.sms.length > SMS_MAX) return false;
  // A wholesale rewrite is not what was asked for. If either channel came back under half
  // the length of the filled template, the model dropped content rather than tailoring it.
  if (out.email.length < base.email.length * 0.5) return false;
  if (out.sms.length < base.sms.length * 0.5) return false;
  return true;
}

const SYSTEM = [
  "You tailor pre-approved outreach copy for Playbook Sports' ticket blasts. You are given a template that has already been filled in for one specific game and market. You return the same message, adjusted to that market.",
  'RULES',
  '1. This is a light edit, not a rewrite. Preserve the voice, structure, paragraph order, and sign-off exactly. Someone who knows the template must still recognise it.',
  '2. Never invent facts. Use only what you are given. No discounts, deadlines, seat counts, prices, stats, links, phone numbers, or calendar URLs that are not already in the copy.',
  '3. The game name and date are already substituted in. Do not change them, and never introduce a bracketed placeholder such as [NAME] or [GAME] — this copy is sent verbatim to every recipient, so a placeholder would be delivered literally.',
  '4. The sender is Josh Marcus, CEO of Playbook Sports. Do not change who is writing or their title.',
  '5. SMS is a single message: no subject line, no signature block, under 480 characters. Email keeps its greeting, paragraphs, and sign-off.',
  '6. No fabricated urgency ("last chance", "expires tonight"), no all-caps, no emoji.',
  'Return the tailored copy and nothing else.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    email: { type: 'string', description: 'The tailored email body, greeting through sign-off.' },
    sms: { type: 'string', description: 'The tailored SMS body. Single message, no subject, no signature block.' },
  },
  required: ['email', 'sms'],
  additionalProperties: false,
};

async function callOpenAI(key, model, user) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'blast_copy', strict: true, schema: SCHEMA } },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || `OpenAI HTTP ${r.status}`);
  const c = (d.choices || [])[0] || {};
  if (c.finish_reason === 'content_filter') throw new Error('model declined');
  return JSON.parse((c.message && c.message.content) || '{}');
}

async function callAnthropic(key, model, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 4096, system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: user }],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || `Anthropic HTTP ${r.status}`);
  if (d.stop_reason === 'refusal') throw new Error('model declined');
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text || '{}');
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET, replySecret = process.env.REPLY_SECRET;
  const bearerOk = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const inboxOk = replySecret && req.headers['x-inbox-secret'] === replySecret;
  if ((cronSecret || replySecret) && !bearerOk && !inboxOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) { res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not set' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : (body.id ? [String(body.id)] : null);
  const tailor = body.tailor !== false;                 // default on; {tailor:false} = fill only
  const overwrite = body.overwrite === true;            // default: never clobber existing copy

  const sh = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'content-type': 'application/json' };
  const rpc = (fn, b) => fetch(`${supaUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sh, body: JSON.stringify(b || {}) });

  try {
    const queue = await (await rpc('get_campaign_queue')).json();
    if (!Array.isArray(queue)) { res.status(502).json({ error: 'queue fetch failed', detail: queue }); return; }

    // Templates. Only non-placeholder rows are usable — a placeholder body is an
    // instruction to go paste the real copy, not outreach.
    const tRes = await fetch(
      `${supaUrl}/rest/v1/message_templates?select=slug,play,variant,channel,subject,body,is_placeholder&is_placeholder=eq.false`,
      { headers: sh });
    const templates = await tRes.json();
    if (!tRes.ok || !Array.isArray(templates)) { res.status(502).json({ error: 'template fetch failed', detail: templates }); return; }

    const pick = (variant, channel) =>
      templates.find(t => t.play === 'Ticketblast' && t.variant === variant && t.channel === channel) ||
      templates.find(t => t.play === 'Ticketblast' && t.variant === 'initial' && t.channel === channel) || null;

    // Targets: the named rows, or every live row that has no copy yet.
    const live = queue.filter(r => r.status !== 'sent' && r.status !== 'sending');
    const targets = ids
      ? live.filter(r => ids.includes(String(r.id)))
      : live.filter(r => !String(r.email_copy || '').trim() && !String(r.sms_copy || '').trim());

    // A market blasted before gets the followup pitch, not the opener.
    const blasted = new Set(
      queue.filter(r => r.status === 'sent').map(r => String(r.state_code || '').toUpperCase()).filter(Boolean));

    const key = (process.env.OPENAI_API_KEY || '').trim();
    const anthKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    const model = (process.env.DRAFT_MODEL || '').trim();

    const written = [], skipped = [], errors = [];

    for (const r of targets) {
      if (!overwrite && (String(r.email_copy || '').trim() || String(r.sms_copy || '').trim())) {
        skipped.push({ id: r.id, title: r.title, reason: 'already has copy — pass overwrite:true to replace' });
        continue;
      }
      const variant = pickVariant(r, blasted.has(String(r.state_code || '').toUpperCase()));
      const tEmail = pick(variant, 'email'), tSms = pick(variant, 'sms');
      if (!tEmail && !tSms) { errors.push({ id: r.id, title: r.title, error: `no template for variant ${variant}` }); continue; }

      // Stage 1 — the deterministic fill. This is what gets written unless stage 2 beats it.
      const base = {
        email: fillTokens(tEmail ? tEmail.body : (tSms ? tSms.body : ''), r),
        sms: fillTokens(tSms ? tSms.body : (tEmail ? tEmail.body : ''), r),
      };
      // The template itself is the only thing that can leave a token behind here, so this
      // catches a bad template row rather than a bad model — worth failing loudly on.
      if (LEFTOVER.test(base.email) || LEFTOVER.test(base.sms)) {
        errors.push({ id: r.id, title: r.title, error: `template ${variant} left an unresolved token — fix the template row` });
        continue;
      }

      // The templates sit 6-40 characters under SMS_MAX before substitution, and [GAME]
      // (6 chars) becomes a fixture name that can run past 30 — "Nationals at Philadelphia
      // Phillies" alone puts the playoffs body at 474/480. So the FILL needs the same length
      // check the tailor gets, or the one path that is supposed to always be safe is the one
      // that ships an over-length message.
      //
      // It is reported rather than refused: an over-long SMS is a copy edit, while writing
      // nothing would leave the row empty and look finished. The count surfaces in the run
      // summary so it gets shortened before anyone confirms. The flag is set on the row that
      // is actually written, below, since the tailor may replace `base`.

      // Stage 2 — tailor. Every failure path lands on `base`, never on an error.
      let copy = base, tailored = false;
      if (tailor && (key || anthKey)) {
        const user = [
          `## This blast`, `- Market: ${r.state_name || r.state_code || 'unspecified'}`,
          `- Game: ${gameLabel(r)}`, `- Date: ${prettyDate(r.event_date) || 'unspecified'}`,
          r.sport ? `- Sport: ${r.sport}` : '', r.league ? `- League: ${r.league}` : '',
          r.ticket_price ? `- Get-in price: $${r.ticket_price}` : '',
          ``, `## Email copy (template "${variant}", already filled in)`, base.email,
          ``, `## SMS copy (template "${variant}", already filled in)`, base.sms,
          ``, `Tailor both to this market, following every rule in your instructions.`,
        ].filter(Boolean).join('\n');
        try {
          const out = key
            ? await callOpenAI(key, model || (process.env.OPENAI_MODEL || 'gpt-4o').trim(), user)
            : await callAnthropic(anthKey, model || 'claude-opus-4-8', user);
          if (tailorIsSafe(out, base)) { copy = { email: out.email, sms: out.sms }; tailored = true; }
        } catch { /* keep the filled template */ }
      }

      const w = await rpc('queue_set_copy', { p_id: r.id, p_email: copy.email, p_sms: copy.sms });
      if (!w.ok) { errors.push({ id: r.id, title: r.title, error: `queue_set_copy HTTP ${w.status}` }); continue; }
      written.push({
        id: r.id, title: r.title, market: r.state_name || r.state_code, variant, tailored,
        sms_len: copy.sms.length,
        // Only ever true on the fill path — a tailored body over SMS_MAX is rejected outright.
        sms_over_limit: copy.sms.length > SMS_MAX || undefined,
      });
    }

    res.status(200).json({
      ok: true, considered: targets.length,
      written, skipped, errors,
      sms_over_limit: written.filter(w => w.sms_over_limit).length,
      tailoring: tailor ? (key ? 'openai' : anthKey ? 'anthropic' : 'no key — fill only') : 'disabled',
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
