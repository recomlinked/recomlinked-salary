// api/raise-coach.js
// Salary Negotiation Coach — Paid coaching + free post-paywall chat + nudges
//
// ── THREE MODES ──────────────────────────────────────────
// MODE 1 — PAID (token required): 30-day coaching window. Full history,
// Redis-backed notes, role-play support. Unchanged from prior behaviour.
//
// MODE 2 — FREE (profile + message, no token): User is on the chat page,
// past the paywall, still asking questions. Reply is useful + ends with CTA.
// Called by the frontend after paywall appears.
//
// MODE 3 — NUDGE (mode:'nudge' flag): Lightweight clarification when user's
// free-text answer during Ex1/Ex2/Ex3 is too short/generic. Haiku, not Sonnet.
// Rate-limited per session. Merged into this file to stay under Vercel
// Hobby's 12 Serverless Functions limit — was originally a separate file.
//
// Mode discrimination (in order):
//   body.mode === 'nudge'                  → nudge mode (Haiku)
//   body.token  present                    → paid mode (Sonnet, history)
//   body.profile present, no token         → free mode (Sonnet, inline ctx)
//
// History storage (paid mode, unchanged):
//   raise:user:{email}        — profile (stays stable)
//   raise:user:{email}:plan   — enriched plan from webhook
//   raise:user:{email}:chat   — full chat history (capped to MAX_HISTORY_RAW)
//   raise:user:{email}:notes  — compact Claude-generated summary

const Anthropic = require('@anthropic-ai/sdk');
const { Redis }  = require('@upstash/redis');

const client = new Anthropic();
const redis  = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TTL_30_DAYS     = 60 * 60 * 24 * 30;
const MAX_HISTORY_RAW = 50;
const MAX_CONTEXT     = 10;
const MAX_MESSAGES    = 200;

// Free mode — light bounds to prevent abuse
const FREE_MAX_CHARS = 800;   // max chars in the user's message
const FREE_MAX_TOKENS_OUT = 450; // Claude's reply cap in free mode

const TEST_TOKEN = 'RAISE-TEST-2026';

// ── Price — single source of truth for CTA copy ─────────
// Must match the chat page's PRICE_USD. Changing here changes free-mode CTA text.
const PRICE_USD = 39;

// ── Nudge mode constants ────────────────────────────────
const NUDGE_RATE_LIMIT_MAX = 20;                // max nudge calls per session
const NUDGE_RATE_LIMIT_TTL = 15 * 60;            // 15 minutes
const NUDGE_MODEL_ID       = 'claude-haiku-4-5-20251001';
const NUDGE_MAX_TOKENS_OUT = 80;                 // one short sentence, that's it

// Fallback nudges if the Haiku call fails or rate limit is hit. Indexed by
// exchange + attempt number (0 = first time they've been nudged).
const NUDGE_FALLBACKS = {
  1: [
    "I need a bit more to work with. Your job title and the kind of company you're at, even a short phrase like 'Senior PM at a SaaS startup' works.",
    "Still too thin for me to tell the field. What's your actual role, and what does your company do?",
    "I genuinely can't help without this one. One sentence on your role and your company is enough.",
  ],
  2: [
    "Give me a sentence on your strongest card. A specific win, a market offer, a sense you're underpaid. Whatever's most true.",
    "I can work with rough, but I need something concrete. What's the best piece of evidence in your corner?",
    "This is the one that sets your ceiling. One real answer, any of the chips above, or a sentence of your own.",
  ],
  3: [
    "Pick one above, or tell me in a sentence. Does your manager go to bat for you, or is it more distant?",
    "The relationship piece changes the whole playbook. A chip or a sentence, either works.",
    "This last one matters a lot. Tap a chip or type one line about your manager.",
  ],
};

function pickNudgeFallback(exchange, priorAttempts) {
  const arr = NUDGE_FALLBACKS[exchange] || NUDGE_FALLBACKS[1];
  const idx = Math.min(priorAttempts || 0, arr.length - 1);
  return arr[idx];
}

// System prompt — trains Claude to write ONE short coach-voice nudge.
const NUDGE_SYSTEM = `You are a salary negotiation coach chatting with a user who just gave you an answer that's too short, too vague, or off-topic. Write ONE nudge sentence asking them to clarify.

HARD RULES:
- NEVER repeat the coach's original question verbatim or near-verbatim. You are the coach; you already asked it. Now paraphrase the REQUEST in a shorter, different way that makes the missing piece obvious.
- ONE sentence. Max 28 words.
- Coach's voice, direct, warm, human. Never scripted.
- If the user typed "hi" or similar filler, acknowledge it lightly ("Happy to chat, but") and redirect.
- If the user went off-topic (e.g. talking about trust when asked about evidence), name it briefly ("That's a real concern, but for this question I need...") then redirect.
- Progressive tone based on attempt number:
  * attempt 1: warm, light clarification, assume they just didn't see what you needed
  * attempt 2: slightly more specific, give the requested shape concretely
  * attempt 3+: direct, honest — "I genuinely can't help without this one. One sentence is enough."
- Don't quote their message back in full. Don't say "I see" or "I understand".
- Don't use em-dashes. Use commas or full stops.
- No question mark at the end unless it's a real question you need them to answer.
- Output ONLY the nudge line. No JSON, no quotes around it, no labels.

REMEMBER: your job is to ASK FOR WHAT'S MISSING in fresh words, not to re-announce the original question.`;

// ── System prompt — PAID mode ───────────────────────────
function buildPaidSystemPrompt({ profile, plan, notes }) {
  const a   = profile.assessment || {};
  const fr  = profile.final_range || {};
  const obs = profile.obstacle     || {};
  const p   = plan || {};
  const seniorityFromText = profile.seniority_signal_from_text || a.seniority || 'unknown';
  const priorAsk          = profile.prior_ask                  || 'not_mentioned';

  return `You are the user's personal Salary Negotiation Coach. You have 30 days to prepare them for a successful raise conversation at their current job. You remember every conversation in this window.

USER SNAPSHOT:
- Name: ${profile.first_name || '(not known)'}
- Country: ${a.country || 'unknown'}
- Seniority signal: ${seniorityFromText}
- Company size: ${a.company_size || 'unknown'}
- Company situation: ${a.company_situation || 'unknown'}
- Last raise: ${a.last_raise || 'unknown'}
- Prior ask: ${priorAsk}${priorAsk === 'asked_got_no' ? ' (they were told no before — reopen-the-conversation coaching is central)' : priorAsk === 'asked_got_partial' ? ' (they got less than asked for before — leverage this precedent)' : ''}
- Stated obstacle: ${obs.code || 'unknown'}${obs.label ? ` — "${obs.label}"` : ''}${obs.free_text ? ` (their words: "${obs.free_text}")` : ''}
- Final probability range: ${fr.floor || '?'}–${fr.ceiling || '?'}%

COACHING PLAN (your own earlier output — reference it, don't re-generate):
${p.headline_summary ? `Summary: ${p.headline_summary}` : '(plan pending)'}
${p.amount_range ? `Amount target: ${p.amount_range.low_pct}–${p.amount_range.high_pct}% raise` : ''}
${p.top_3_blockers ? `Top blockers:\n${p.top_3_blockers.map(b => `- ${b.blocker}: ${b.fix}`).join('\n')}` : ''}
${p.timing_recommendation ? `Timing: ${p.timing_recommendation}` : ''}

COACH'S NOTES FROM PRIOR SESSIONS (your running memory of this user):
${notes || '(first session — no prior notes yet)'}

YOUR SCOPE (strict):
You help this specific user prepare for and execute their raise negotiation. You answer questions about:
- Their plan, their range, the blockers and how to overcome them
- Practising the conversation (role-play mode — play the manager if asked)
- Specific scripts, emails, counter-offers, follow-up language
- Their evidence and how to present it
- Timing, manager dynamics, political considerations at their company
- External leverage — how to build it, how to use it, how to reveal it
- How to handle specific pushbacks, silence, delays, or a "no"
- Emotional prep — managing nerves, handling tough reactions

OUT OF SCOPE (redirect politely):
- Job offer negotiation (different product — tell them we're building it, suggest the waitlist)
- Career coaching outside the raise context
- General life or business advice
- Questions about your own nature, training, or Anthropic

TONE:
- Direct, warm, specific. Talks like a coach who's been at this 15 years.
- Reference their actual profile — never generic.
- Every answer ends with something they can DO next.
- 3-6 sentences unless they explicitly ask for detail.
- Uses their name sparingly — once per session, not every message.

ROLE-PLAY MODE:
If they ask to practise, ask who you should play (the manager, HR, themselves), set the scene in one sentence, then stay in character until they say "out" or "end role play". After role-play ends, give 2-3 short notes on what worked and what to adjust.

Never be generic. Every response should feel like it could only be written for this specific person.`;
}

// ── System prompt — FREE mode (post-paywall on the chat page) ────────
// The user has seen the paywall, didn't click, and kept chatting. We give
// them a genuinely useful reply (not a paywall repeat) then append a short
// dynamic CTA tail that references their obstacle. The "answer first, earn
// the CTA" pattern — FA is weak at this, we do better.
function buildFreeSystemPrompt({ profile, obstacle, final_range, accumulated_exchanges }) {
  const a   = profile || {};
  const ex1 = accumulated_exchanges?.ex1?.extracted || {};
  const ex2 = accumulated_exchanges?.ex2?.extracted || {};
  const ex3 = accumulated_exchanges?.ex3?.extracted || {};
  const obs = obstacle || {};
  const fr  = final_range || {};

  const roleLabel = ex1.job_title_normalised || '(role unknown)';
  const priorAsk  = ex3.prior_ask || 'not_mentioned';

  return `You are a salary negotiation coach chatting with someone who has just completed a 3-exchange assessment but has NOT YET paid for the full coaching plan. They're on the free chat page, saw the paywall ($${PRICE_USD} coaching plan), and are asking you another question instead of clicking.

YOUR JOB — in this exact order:
1. Answer their question usefully and specifically. Reference what they told you in the exchanges (role, evidence, manager, obstacle). This is NOT a sales pitch — give them a genuinely helpful answer a coach would give. 3-5 sentences max.
2. End with a short transition (1-2 sentences) that references their stated obstacle and points out that the FULL version of what you just gave them (exact words, specific numbers, personalised to them) is in the paid plan.
3. DO NOT repeat any part of the main paywall copy. This is a continuation, not a restart.

USER SNAPSHOT:
- Role: ${roleLabel}
- Company situation: ${a.company_situation || 'unknown'}
- Last raise: ${a.last_raise || 'unknown'}
- Performance signal: ${ex2.performance_rating || ex2.external_leverage || 'unclear'}
- Manager relationship: ${ex3.manager_relationship || 'unknown'}
- Prior ask history: ${priorAsk}
- Their stated biggest worry: ${obs.code || 'unknown'}${obs.label ? ` — "${obs.label}"` : ''}${obs.free_text ? ` (their words: "${obs.free_text}")` : ''}
- Their final range: ${fr.floor || '?'}–${fr.ceiling || '?'}%

TONE:
- Warm and direct, like a coach answering a follow-up in a session.
- No "upgrade" language. No "unlock". No hype.
- The transition at the end should feel like you're being honest about the limits of a chat reply, not salesy.

SCOPE:
- Only raise-negotiation-adjacent topics. If they ask something off-topic (their career generally, personal life, a different job), briefly redirect to the raise context they're already in.
- If they ask to role-play — answer that role-play is part of the full plan where you can remember what happens across sessions; here in the chat, you can only do a quick single-scene preview.

FORMAT:
- Plain prose only. No headers, no markdown lists, no bold.
- 5-7 sentences total (including the closing transition).
- Don't include a button or CTA text — the frontend wraps your reply with the actual button. Just end with the transition line.`;
}

async function logCoachMessage(email, firstMessage) {
  try {
    const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
    if (!webhookUrl) return;
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        timestamp: new Date().toISOString(),
        event:     firstMessage ? 'COACH_FIRST_MESSAGE' : 'COACH_MESSAGE',
        product:   'raise',
        email,
        source:    'salary.recomlinked.com',
      }),
    });
  } catch (e) { /* non-fatal */ }
}

async function logFreeCoachMessage(payload) {
  try {
    const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
    if (!webhookUrl) return;
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        timestamp: new Date().toISOString(),
        event:     'COACH_FREE_MESSAGE',
        product:   'raise',
        source:    'salary.recomlinked.com',
        ...payload,
      }),
    });
  } catch (e) { /* non-fatal */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // ── Mode discrimination ─────────────────────────────────
  // NUDGE mode: explicit { mode: 'nudge', exchange, user_answer, ... }
  // PAID mode:  { token, message }
  // FREE mode:  { profile, message } (no token)
  if (body.mode === 'nudge') {
    return handleNudgeMode(body, res);
  }
  const isFreeMode = !body.token && !!body.profile;
  if (isFreeMode) {
    return handleFreeMode(body, res);
  }
  return handlePaidMode(body, res);
};

// ════════════════════════════════════════════════════════════
// ══ NUDGE MODE — dynamic clarification during Ex1/Ex2/Ex3 ══
// ════════════════════════════════════════════════════════════
async function handleNudgeMode(body, res) {
  const {
    exchange,        // 1 | 2 | 3
    question,        // the coach question that was asked
    user_answer,     // what the user typed
    prior_attempts,  // how many prior nudges in this exchange
    session_id,      // profileHash for rate limiting
  } = body;

  if (!exchange || exchange < 1 || exchange > 3) {
    return res.status(400).json({ error: 'Invalid exchange' });
  }
  if (!user_answer || typeof user_answer !== 'string') {
    return res.status(400).json({ error: 'user_answer required' });
  }
  if (user_answer.length > 500) {
    return res.status(400).json({ error: 'user_answer too long' });
  }

  const attempts = Math.max(0, parseInt(prior_attempts || 0, 10));

  // Rate limit — Redis counter keyed by session, 15min window
  if (session_id && typeof session_id === 'string' && session_id.length <= 64) {
    try {
      const key = `raise:nudge:rate:${session_id}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, NUDGE_RATE_LIMIT_TTL);
      }
      if (count > NUDGE_RATE_LIMIT_MAX) {
        return res.status(200).json({
          nudge:        pickNudgeFallback(exchange, attempts),
          rate_limited: true,
        });
      }
    } catch (e) { /* non-fatal, proceed without rate limit */ }
  }

  const userMessage = `Exchange: ${exchange}
Coach question asked: ${question || '(not provided)'}
User's reply (too short or generic): ${JSON.stringify(user_answer)}
Prior nudges this exchange: ${attempts}

Write the nudge.`;

  try {
    const response = await client.messages.create({
      model:      NUDGE_MODEL_ID,
      max_tokens: NUDGE_MAX_TOKENS_OUT,
      system:     NUDGE_SYSTEM,
      messages:   [{ role: 'user', content: userMessage }],
    });
    const raw = (response.content[0]?.text || '').trim();
    // Strip surrounding quotes if the model added them despite instructions
    const cleaned = raw.replace(/^["']+|["']+$/g, '').trim();
    const nudge = cleaned || pickNudgeFallback(exchange, attempts);
    return res.status(200).json({ nudge });
  } catch (err) {
    console.error('[raise-coach] nudge claude error:', err.message);
    return res.status(200).json({
      nudge:    pickNudgeFallback(exchange, attempts),
      fallback: true,
    });
  }
}

// ════════════════════════════════════════════════════════════
// ══ FREE MODE — post-paywall chat on /raise/chat/         ══
// ════════════════════════════════════════════════════════════
async function handleFreeMode(body, res) {
  const {
    profile,                  // assessment-level profile
    obstacle,                 // { code, label, free_text? }
    final_range,              // { floor, ceiling }
    accumulated_exchanges,    // { ex1: {...}, ex2: {...}, ex3: {...} }
    message,                  // user's message
  } = body;

  if (!profile || !message) {
    return res.status(400).json({ error: 'Profile and message required' });
  }
  if (typeof message !== 'string' || message.length === 0) {
    return res.status(400).json({ error: 'Message must be a non-empty string' });
  }
  if (message.length > FREE_MAX_CHARS) {
    return res.status(400).json({ error: 'Message too long' });
  }

  const systemPrompt = buildFreeSystemPrompt({
    profile, obstacle, final_range, accumulated_exchanges,
  });

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: FREE_MAX_TOKENS_OUT,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: message }],
    });
    const reply = response.content[0]?.text || "I couldn't respond just now. Please try again.";

    logFreeCoachMessage({
      obstacle_code: obstacle?.code || 'unknown',
      msg_len:       message.length,
      reply_len:     reply.length,
    });

    return res.status(200).json({
      reply,
      mode: 'free',
      // Frontend uses this to render the dynamic CTA button below the reply
      cta:  {
        label: `Get my coaching plan · $${PRICE_USD}`,
        price_usd: PRICE_USD,
      },
    });
  } catch (err) {
    console.error('[raise-coach] free-mode claude error:', err);
    return res.status(500).json({ error: 'Coach unavailable. Please try again.' });
  }
}

// ════════════════════════════════════════════════════════════
// ══ PAID MODE — 30-day coaching window                    ══
// ════════════════════════════════════════════════════════════
async function handlePaidMode(body, res) {
  const { token, message } = body;
  if (!token || !message) {
    return res.status(400).json({ error: 'Token and message required' });
  }

  // ── Resolve token → email → user ───────────────────────
  let email, profile, plan, notes;
  let isTest = false;

  if (token === TEST_TOKEN) {
    isTest  = true;
    email   = 'test@example.com';
    profile = {
      first_name: 'Alex',
      assessment: {
        country: 'ca', seniority: 'mid', company_size: '250_1000',
        company_situation: 'stable', last_raise: '1_2_years',
      },
      final_range: { floor: 56, ceiling: 61 },
      obstacle: { code: 'budget', label: "My manager will say there's no budget" },
      prior_ask: 'never_asked',
      seniority_signal_from_text: 'mid',
    };
    plan  = { headline_summary: 'Solid mid-range position.', amount_range: { low_pct: 8, high_pct: 14 } };
    notes = '';
  } else {
    try {
      email = await redis.get(`raise:token:${token}`);
      if (!email) {
        return res.status(401).json({ error: 'expired', message: 'Your access has expired. Visit /raise/enter to resend your link.' });
      }
      const [userRaw, planRaw, notesRaw] = await Promise.all([
        redis.get(`raise:user:${email}`),
        redis.get(`raise:user:${email}:plan`),
        redis.get(`raise:user:${email}:notes`),
      ]);
      if (!userRaw) {
        return res.status(401).json({ error: 'expired' });
      }
      profile = typeof userRaw  === 'string' ? JSON.parse(userRaw)  : userRaw;
      plan    = planRaw  ? (typeof planRaw  === 'string' ? JSON.parse(planRaw)  : planRaw)  : null;
      notes   = notesRaw ? (typeof notesRaw === 'string' ? notesRaw : String(notesRaw)) : '';
    } catch (err) {
      console.error('[raise-coach] auth error:', err.message);
      return res.status(500).json({ error: 'Auth lookup failed' });
    }
  }

  // ── Load chat history ──────────────────────────────────
  let history = [];
  if (!isTest) {
    try {
      const raw = await redis.get(`raise:user:${email}:chat`);
      if (raw) history = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) { /* continue with empty */ }
  }

  // ── Cap check ──────────────────────────────────────────
  if (!isTest && history.length >= MAX_MESSAGES * 2) {
    return res.status(200).json({
      reply:  "We've covered a lot of ground together. If anything new comes up, your plan above is always available — and if your situation has changed, it may be time to run a fresh assessment.",
      capped: true,
    });
  }

  // ── Build messages for Claude ──────────────────────────
  const trimmed = history.slice(-MAX_CONTEXT * 2);
  const messages = [...trimmed, { role: 'user', content: message }];

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 800,
      system:     buildPaidSystemPrompt({ profile, plan, notes }),
      messages,
    });
    const reply = response.content[0]?.text || "I couldn't generate a response. Please try again.";

    // ── Append to history + persist ───────────────────────
    if (!isTest) {
      const updated = [
        ...history,
        { role: 'user',      content: message },
        { role: 'assistant', content: reply   },
      ].slice(-MAX_HISTORY_RAW * 2);
      try {
        await redis.set(`raise:user:${email}:chat`, JSON.stringify(updated), { ex: TTL_30_DAYS });
      } catch (e) { /* non-fatal */ }

      if (history.length === 0) {
        logCoachMessage(email, true);
      } else if (history.length % 10 === 0) {
        logCoachMessage(email, false);
      }

      // Trigger notes update every 6 exchanges (12 messages) — fire-and-forget
      if (updated.length % 12 === 0) {
        try {
          const base = process.env.RAISE_BASE_URL || 'https://salary.recomlinked.com';
          fetch(`${base}/api/raise-notes-update`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email, internal_key: process.env.RAISE_INTERNAL_KEY || '' }),
          }).catch(() => {});
        } catch (e) { /* non-fatal */ }
      }
    }

    return res.status(200).json({ reply, mode: 'paid', capped: false });
  } catch (err) {
    console.error('[raise-coach] claude error:', err);
    return res.status(500).json({ error: 'Coach unavailable. Please try again.' });
  }
}
