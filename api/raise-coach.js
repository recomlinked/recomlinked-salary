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
// free-text answer during Ex1/Ex2 is too short/generic. Haiku, not Sonnet.
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
const NUDGE_SYSTEM = `You are a salary negotiation coach nudging a user whose answer was too short, too vague, or off-topic. Write ONE nudge sentence.

HARD RULES:
- Only ask for information the original coach question explicitly requested. Do NOT invent new requirements (e.g. if the question asked for role + industry, do NOT ask for company size, company name, or what the company does — those weren't asked).
- If the user has provided PART of the answer already in prior messages, acknowledge that and ask only for the missing piece. Example: if they said "CTO" then "fintech", that's role + industry — that is a complete answer, classify as sufficient, don't ask for more.
- NEVER repeat the coach's original question verbatim. Paraphrase the specific missing piece.
- ONE sentence. Max 28 words.
- Coach's voice: direct, warm, human.
- If the user typed filler like "hi", acknowledge lightly ("Happy to chat, but") and redirect.
- If off-topic, name it briefly ("That's a real concern, but for this question I need...") then redirect.
- If the user is frustrated ("you asked me that", "fuck you", etc.), apologize briefly and restate what you actually need in simplest form. Don't repeat a rejected request.
- Progressive tone based on attempt number:
  * attempt 1: warm, light clarification
  * attempt 2: acknowledge what they've already given, ask for the specific missing piece
  * attempt 3+: direct, honest — accept what they have if it's minimally sufficient
- Don't say "I see" or "I understand". Don't use em-dashes.
- No question mark at the end unless it's a real question.
- Output ONLY the nudge line. No JSON, no quotes, no labels.

REMEMBER: your job is to help the user complete the specific question that was asked. Don't expand scope. Don't ask for fields the original question didn't request.`;

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
function buildFreeSystemPrompt({ profile, obstacle, timing, final_range, accumulated_exchanges }) {
  const a   = profile || {};
  const ex1 = accumulated_exchanges?.ex1?.extracted || {};
  const ex2 = accumulated_exchanges?.ex2?.extracted || {};
  const obs = obstacle || {};
  const fr  = final_range || {};
  const userTiming = timing || 'exploring';

  const roleLabel = ex1.job_title_normalised || '(role unknown)';

  // Infer manager_relationship and prior_ask from obstacle (Ex3 removed)
  const inferredManagerRel = {
    relationship: 'complicated',
    pushy:        'complicated',
    budget:       'professional',
    prior_no:     'professional',
  }[obs.code] || 'unknown';
  const inferredPriorAsk = obs.code === 'prior_no' ? 'asked_got_no' : 'not_mentioned';

  return `You are a salary negotiation coach chatting with someone who has just completed a 2-exchange assessment but has NOT YET paid for the full coaching plan. They're on the free chat page, saw the paywall ($${PRICE_USD} coaching plan), and are asking you another question instead of clicking.

YOUR JOB — in this exact order:
1. Answer their question usefully and specifically. Reference what they told you in the exchanges (role, evidence, obstacle). This is NOT a sales pitch — give them a genuinely helpful answer a coach would give. 3-5 sentences max.
2. End with a short transition (1-2 sentences) that references their stated obstacle and points out that the FULL version of what you just gave them (exact words, specific numbers, personalised to them) is in the paid plan.
3. DO NOT repeat any part of the main paywall copy. This is a continuation, not a restart.

USER SNAPSHOT:
- Role: ${roleLabel}
- Company situation: ${a.company_situation || 'unknown'}
- Last raise: ${a.last_raise || 'unknown'}
- Performance signal: ${ex2.performance_rating || ex2.external_leverage || 'unclear'}
- Manager relationship (inferred): ${inferredManagerRel}
- Prior ask history (inferred): ${inferredPriorAsk}
- Their stated biggest worry: ${obs.code || 'unknown'}${obs.label ? ` — "${obs.label}"` : ''}${obs.free_text ? ` (their words: "${obs.free_text}")` : ''}
- Their timeline: ${userTiming}${userTiming === 'this_week' ? ' (URGENT — conversation could be any day)' : ''}
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
        event:     'RAISE_COACH_MSG',
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
        event:     'RAISE_POST_PAYWALL_MSG',
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
  // NUDGE mode:      explicit { mode: 'nudge', exchange, user_answer, ... }
  // DISCOVERY mode:  explicit { mode: 'discovery', blocker, timing, message, history }
  // SIMULATE_OPENINGS: generates 3 opening lines from user context
  // SIMULATE_RESPONSES: generates 3 manager scenarios with replies
  // PAID mode:       { token, message }
  // FREE mode:       { profile, message } (no token)
  if (body.mode === 'nudge') {
    return handleNudgeMode(body, res);
  }
  if (body.mode === 'discovery') {
    return handleDiscoveryMode(body, res);
  }
  if (body.mode === 'simulate_openings') {
    return handleSimulateOpenings(body, res);
  }
  if (body.mode === 'simulate_responses') {
    return handleSimulateResponses(body, res);
  }
  if (body.mode === 'simulate_scenarios') {
    return handleSimulateScenarios(body, res);
  }
  if (body.mode === 'simulate_replies') {
    return handleSimulateReplies(body, res);
  }
  if (body.mode === 'simulate_custom_scenario') {
    return handleSimulateCustomScenario(body, res);
  }
  if (body.mode === 'coach_reflection') {
    return handleCoachReflection(body, res);
  }
  const isFreeMode = !body.token && !!body.profile;
  if (isFreeMode) {
    return handleFreeMode(body, res);
  }
  return handlePaidMode(body, res);
};

// ════════════════════════════════════════════════════════════
// ══ NUDGE MODE — dynamic clarification during Ex1/Ex2 ═════
// ════════════════════════════════════════════════════════════
async function handleNudgeMode(body, res) {
  const {
    exchange,        // 1 | 2
    question,        // the coach question that was asked
    user_answer,     // what the user typed THIS turn
    prior_messages,  // array of prior free-text answers in this exchange
    combined_text,   // all prior_messages joined (convenience)
    prior_attempts,  // how many prior nudges in this exchange
    session_id,      // profileHash for rate limiting
  } = body;

  if (!exchange || exchange < 1 || exchange > 2) {
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

  // Build a history-aware prompt so Haiku sees what the user already said
  // across prior messages. Without this, each nudge call is stateless and
  // Haiku re-asks for information the user already provided.
  const priorArr = Array.isArray(prior_messages) ? prior_messages : [];
  const priorBlock = priorArr.length
    ? priorArr.map((m, i) => `  ${i + 1}. "${String(m).slice(0, 200)}"`).join('\n')
    : '  (none — this is their first message in this exchange)';
  const combinedLine = (combined_text && typeof combined_text === 'string')
    ? combined_text.slice(0, 800)
    : priorArr.join('. ');

  const userMessage = `Exchange: ${exchange}
Coach question that was asked: ${question || '(not provided)'}

User's messages in this exchange so far:
${priorBlock}

User's most recent message (this turn): ${JSON.stringify(user_answer)}

Combined text of everything they've said in this exchange: ${JSON.stringify(combinedLine)}

Prior nudges already sent this exchange: ${attempts}

IMPORTANT: Only ask for what is still missing from the COMBINED text above. If they've already given role + industry across messages (even in separate turns), that is sufficient and you should NOT ask for either again — the system will accept their combined answer. Your nudge only matters when something the coach question actually asked for is genuinely missing from the combined text.

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
    timing,                   // 'this_week' | 'few_weeks' | 'this_quarter' | 'exploring'
    final_range,              // { floor, ceiling }
    accumulated_exchanges,    // { ex1: {...}, ex2: {...} }
    message,                  // user's message
    session_id,               // profile_hash — anonymous user identifier
    free_dialog_count,        // how many free-mode msgs this user has sent
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
    profile, obstacle, timing, final_range, accumulated_exchanges,
  });

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: FREE_MAX_TOKENS_OUT,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: message }],
    });
    const reply = response.content[0]?.text || "I couldn't respond just now. Please try again.";

    // Log to Raise Leads tab with the schema fields the Apps Script expects
    logFreeCoachMessage({
      session_id:         session_id || '',
      obstacle:           obstacle?.code || 'unknown',
      range_floor:        final_range?.floor   ?? '',
      range_ceiling:      final_range?.ceiling ?? '',
      free_dialog_count:  free_dialog_count ?? '',
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

// ════════════════════════════════════════════════════════════
// ══ DISCOVERY MODE — pre-paywall coaching-by-questions     ══
// ════════════════════════════════════════════════════════════
// Called when a user clicks a blocker chip on the landing page.
// The coach asks smart questions that help the user discover
// their own gaps. After 2 exchanges, the frontend shows the paywall.
//
// The coach NEVER gives solutions. Only asks questions that
// reveal blind spots. The user sells themselves on needing the plan.

const DISCOVERY_SYSTEM = `You are a senior salary negotiation coach. A user clicked a specific raise blocker on a landing page and told you their timeline. Your job is to coach by asking — NOT by telling.

THE USER'S BLOCKER: {blocker_code} — "{blocker_label}"
THE USER'S TIMELINE: {timing}

YOUR FRAMEWORK — you have exactly 2 messages:

MESSAGE 1 (after they answer your blocker-specific question):
- Acknowledge what they said in 1 sentence — use THEIR words
- Ask about their BLIND SPOT: the thing they haven't considered
- This should be the question that creates the "oh shit" moment
- Usually it's about what happens AFTER they do the thing they're afraid of
- ONE question only. 2-3 sentences total.

MESSAGE 2 (your final message before the paywall appears):
- MIRROR back the 2-3 gaps they just revealed through their own answers
- Be specific — use their exact words when reflecting back
- Name the gaps clearly but do NOT solve them
- End with something like "Those are exactly what a plan would address" or similar natural bridge
- 2-3 sentences total. No lists. No bullet points.

ABSOLUTE RULES:
- NEVER give the actual solution — just make the gap visible
- NEVER mention price, payment, or "upgrade"
- NEVER say "the plan includes" or sell anything
- Ask ONE question per message — never two
- 2-3 sentences max per message
- Use their exact words when reflecting back
- Be warm, direct, specific. Not generic coaching-speak.
- Reference their timeline when relevant (urgent = different tone than exploring)

THE GOAL: After your 2 messages, the user should think "I need help with this" — not because you told them to, but because they DISCOVERED their own gaps through your questions.`;

// Blocker-specific opening questions — these are the first coach question
// AFTER the user taps their timing. Hardcoded for quality control.
const DISCOVERY_OPENERS = {
  underpaid:      "What makes you think you're underpaid — is it a feeling, or do you have something concrete like a job posting or a colleague's number?",
  quiet:          "When you think about making your work more visible, what feels hardest — finding the right moment, or finding the right words?",
  timing:         "What makes the timing feel off — nothing scheduled, or something else?",
  no_advocate:    "When you need something from your manager, how does that usually go — do they help, or do you have to push?",
  unknown_amount: "When you think about a number, what stops you — no data, or too many options?",
  no_script:      "If you had to open the conversation tomorrow, what would your first sentence be — or is it completely blank?",
  fear_no:        "When you imagine them saying no, what happens next in your head — do you have a response, or does the conversation just end?",
  prior_no:       "When they said no last time, what reason did they give?",
  putting_off:    "What happens in your head right before you decide 'not today'?",
  pushy:          "When you imagine asking, what specifically feels pushy about it?",
  relationship:   "What specifically are you afraid would change in the relationship?",
  budget:         "Has your manager actually said 'no budget' before, or are you expecting it?",
  justify:        "What would you say if your manager asked 'why should I pay you more' right now?",
  other:          "Tell me what's on your mind — what's the thing that stops you when you think about asking?",
};

async function handleDiscoveryMode(body, res) {
  const {
    blocker,        // { code, label }
    timing,         // 'this_week' | 'few_weeks' | 'this_quarter' | 'exploring'
    message,        // user's typed answer
    history,        // array of { role, content } — prior messages in this discovery
    message_number, // 1 or 2 (which coach response we're generating)
    session_id,
  } = body;

  if (!blocker || !message) {
    return res.status(400).json({ error: 'blocker and message required' });
  }
  if (typeof message !== 'string' || message.length === 0) {
    return res.status(400).json({ error: 'message must be non-empty' });
  }
  if (message.length > FREE_MAX_CHARS) {
    return res.status(400).json({ error: 'message too long' });
  }

  const blockerCode  = blocker.code || 'other';
  const blockerLabel = blocker.label || '';
  const timingVal    = timing || 'exploring';
  const msgNum       = message_number || 1;

  // Build system prompt with blocker + timing injected
  const system = DISCOVERY_SYSTEM
    .replace('{blocker_code}', blockerCode)
    .replace('{blocker_label}', blockerLabel)
    .replace('{timing}', timingVal);

  // Build messages array — include history so Claude sees the full conversation
  const priorMessages = Array.isArray(history) ? history : [];
  const messages = [
    ...priorMessages,
    { role: 'user', content: message },
  ];

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 200,  // short responses only — 2-3 sentences
      system,
      messages,
    });
    const reply = response.content[0]?.text || "Tell me more about your situation.";

    return res.status(200).json({
      reply,
      mode: 'discovery',
      message_number: msgNum,
    });
  } catch (err) {
    console.error('[raise-coach] discovery mode error:', err);
    // Fallback — use a generic follow-up so the UX doesn't break
    const fallback = msgNum === 1
      ? "That's helpful context. Here's what I'm curious about — if you had to have this conversation tomorrow, what would you say first?"
      : "You've identified some real gaps. Those are exactly the things a structured plan would address.";
    return res.status(200).json({
      reply: fallback,
      mode: 'discovery',
      message_number: msgNum,
    });
  }
}

// ════════════════════════════════════════════════════════════
// ══ SIMULATE OPENINGS — generate 3 personalized openers   ══
// ════════════════════════════════════════════════════════════
async function handleSimulateOpenings(body, res) {
  const { context, blocker } = body;
  const role = context?.role || 'professional';
  const evidence = context?.evidence_label || 'strong performance';
  const timing = context?.timing || 'upcoming';
  const company = context?.company_situation || 'stable';
  const lastRaise = context?.last_raise || 'unknown';
  const blockerLabel = blocker?.label || '';

  const prompt = `Generate 3 opening lines for a salary negotiation conversation.

CONTEXT:
- Role: ${role}
- Strongest evidence: ${evidence}
- Company situation: ${company}
- Last raise: ${lastRaise}
- Timeline: ${timing}
- Main concern: ${blockerLabel}

Generate exactly 3 opening lines with different approaches:
1. "Direct" — states the ask clearly upfront
2. "Collaborative" — frames it as a joint discussion about role growth
3. "Evidence-led" — leads with data/accomplishments

Each opening should be 1-2 sentences, specific to their role and situation, and should NOT mention a specific dollar amount.

Respond ONLY with valid JSON, no preamble:
{ "openings": [ { "style": "Direct", "text": "..." }, { "style": "Collaborative", "text": "..." }, { "style": "Evidence-led", "text": "..." } ] }`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0]?.text || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json({ openings: parsed.openings, mode: 'simulate_openings' });
  } catch (err) {
    console.error('[simulate_openings] error:', err);
    return res.status(200).json({
      openings: [
        { style: 'Direct', text: `I've been thinking about my compensation. Based on my contributions and what I'm seeing in the market, I believe there's a gap we should discuss.` },
        { style: 'Collaborative', text: `I'd like to talk about where my role is heading. My scope has grown significantly and I want to make sure we're aligned.` },
        { style: 'Evidence-led', text: `I've done some research on market rates for my role and I'd like to walk you through what I found.` },
      ],
      mode: 'simulate_openings',
    });
  }
}

// ════════════════════════════════════════════════════════════
// ══ SIMULATE RESPONSES — 3 manager scenarios with replies  ══
// ════════════════════════════════════════════════════════════
async function handleSimulateResponses(body, res) {
  const { context, blocker, opening_line } = body;
  const role = context?.role || 'professional';
  const evidence = context?.evidence_label || 'strong performance';
  const company = context?.company_situation || 'stable';
  const lastRaise = context?.last_raise || 'unknown';
  const blockerLabel = blocker?.label || '';

  const prompt = `Salary negotiation simulation. The user just opened with: "${opening_line}"

CONTEXT:
- Role: ${role}
- Evidence: ${evidence}
- Company: ${company}
- Last raise: ${lastRaise}
- Their worry: ${blockerLabel}

Generate 3 realistic manager responses. For EACH, provide 2 suggested user replies.

Rules:
- Each scenario should have a different TYPE (choose the most relevant 3 from: Receptive, Pushback, Deflecting, Counter-offer, Fact-checking, Emotional)
- Manager lines: under 30 words, realistic, specific to their industry
- Suggested replies: under 35 words each, strategic, specific — not generic coaching advice
- The scenarios should feel like a REAL manager talking, not a textbook

Respond ONLY with valid JSON, no preamble:
{
  "scenarios": [
    { "type": "Receptive", "text": "...", "replies": ["...", "..."] },
    { "type": "Pushback", "text": "...", "replies": ["...", "..."] },
    { "type": "Deflecting", "text": "...", "replies": ["...", "..."] }
  ]
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0]?.text || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json({ scenarios: parsed.scenarios, mode: 'simulate_responses' });
  } catch (err) {
    console.error('[simulate_responses] error:', err);
    return res.status(200).json({
      scenarios: [
        { type: 'Receptive', text: "I appreciate you bringing this up. What did you have in mind?", replies: ["Based on my research, I believe an adjustment to reflect my current scope would be appropriate.", "I'd like to discuss what the market shows for my role and responsibilities."] },
        { type: 'Pushback', text: "This isn't really a good time for that conversation.", replies: ["I understand. Can we schedule a specific time next week? I'd like to be thoughtful about it.", "I'd rather discuss it now while the context is fresh — it'll only take 10 minutes."] },
        { type: 'Deflecting', text: "Let me check with HR and get back to you.", replies: ["Of course. Would it help if I put together a summary you could share with them?", "When can I expect to hear back? I want to make sure we don't miss the budget cycle."] },
      ],
      mode: 'simulate_responses',
    });
  }
}

// ════════════════════════════════════════════════════════════
// ══ SIMULATE SCENARIOS — 5-6 scenario labels for a blocker ══
// ════════════════════════════════════════════════════════════
async function handleSimulateScenarios(body, res) {
  const { blocker, context } = body;
  const blockerCode = blocker?.code || 'other';
  const blockerLabel = blocker?.label || '';
  const role = context?.role || '';
  const timing = context?.timing || '';

  const prompt = `Generate 5-6 realistic manager response THEMES for a salary negotiation.

SITUATION: An employee is negotiating a raise. Their main concern: "${blockerLabel}"
${role ? `Role: ${role}` : ''}
${timing ? `Timeline: ${timing}` : ''}

For each scenario, provide:
- "type": a SHORT quote (3-7 words) showing what the manager says. This is the pill label — it must be instantly understandable. Write it as a direct mini-quote in the manager's voice, like: "No budget right now" or "Why do you deserve more?" or "Let me think about it". Do NOT use abstract labels like "Deflecting upward" or "Passive agreement" — users can't tell what those mean.
- "text": the full 1-2 sentence version of what the manager would say.

The themes should be VARIED — mix supportive, challenging, deflecting, emotional, and factual responses. Make them feel like a real person.

JSON only, no preamble:
{ "scenarios": [ { "type": "\\"No budget right now\\"", "text": "Budgets are locked until..." }, ... ] }`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0]?.text || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json({ scenarios: parsed.scenarios, mode: 'simulate_scenarios' });
  } catch (err) {
    console.error('[simulate_scenarios] error:', err);
    return res.status(200).json({ scenarios: null, mode: 'simulate_scenarios' });
  }
}

// ════════════════════════════════════════════════════════════
// ══ SIMULATE REPLIES — reply pills for a specific scenario ══
// ════════════════════════════════════════════════════════════
async function handleSimulateReplies(body, res) {
  const { manager_said, scenario_type, blocker, context } = body;
  const role = context?.role || '';

  const prompt = `A manager just said: "${manager_said}" (scenario type: ${scenario_type})

The employee's concern was: "${blocker?.label || 'asking for a raise'}"
${role ? `Their role: ${role}` : ''}

Generate 4-5 possible REPLY THEMES the employee could use. For each, provide:
- "theme": a short plain-English label (3-6 words) that instantly tells the user what they'd say. Write it as a mini-summary in first person, like: "Share my market data", "Ask what it would take", "Push back firmly", "Suggest a timeline". Do NOT use abstract labels like "Data-driven approach" — users can't tell what those mean.
- "text": the full response (1-2 sentences, specific, strategic)

Make the replies varied — some direct, some diplomatic, some data-driven. Each should be a genuinely different approach.

JSON only:
{ "replies": [ { "theme": "Share my market data", "text": "I've done some research..." }, ... ] }`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0]?.text || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json({ replies: parsed.replies, mode: 'simulate_replies' });
  } catch (err) {
    console.error('[simulate_replies] error:', err);
    return res.status(200).json({ replies: null, mode: 'simulate_replies' });
  }
}

// ════════════════════════════════════════════════════════════
// ══ SIMULATE CUSTOM SCENARIO — from user's theme words     ══
// ════════════════════════════════════════════════════════════
async function handleSimulateCustomScenario(body, res) {
  const { theme, blocker, context } = body;

  const prompt = `A user is practicing a salary negotiation. Their concern: "${blocker?.label || 'asking for a raise'}"

They want to practice a scenario where the manager responds in this way: "${theme}"

Generate a realistic manager response matching that theme. Keep it to 1-2 sentences. Make it sound like a real person.

JSON only:
{ "scenario": { "type": "${theme}", "text": "..." } }`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0]?.text || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json({ scenario: parsed.scenario, mode: 'simulate_custom_scenario' });
  } catch (err) {
    console.error('[simulate_custom_scenario] error:', err);
    return res.status(200).json({ scenario: { type: theme, text: `"I understand your concern, but let me explain where we stand on this."` }, mode: 'simulate_custom_scenario' });
  }
}

// ════════════════════════════════════════════════════════════
// ══ COACH REFLECTION — analyze explored paths, give feedback ══
// ════════════════════════════════════════════════════════════
async function handleCoachReflection(body, res) {
  const { blocker, context, branch_history, explored_count, total_count } = body;
  const blockerLabel = blocker?.label || 'asking for a raise';
  const role = context?.role || '';
  const paths = (branch_history || []).map(b => `Manager scenario: "${b.scenario}" → User chose: "${b.reply}"`).join('\n');

  const prompt = `You're a salary negotiation coach reviewing someone's preparation.

Their concern: "${blockerLabel}"
${role ? `Role: ${role}` : ''}
They explored ${explored_count} of ${total_count} scenarios.

Paths they practiced:
${paths || '(none yet)'}

Write a brief coaching reflection in this EXACT format. Keep each section to 1-2 sentences max. Do not use headings or markdown other than the bold labels shown.

Start with one short paragraph (no label) about what their choices reveal — be specific, reference their actual picks.

Then three labeled sections, each as its own paragraph, exactly in this order and with these exact bold labels:

**Strength:** [one specific thing they did well]

**Blind spot:** [one specific gap or risk in their approach]

**Try next:** [name one unexplored scenario type they should practice and why — be concrete]

Be direct, encouraging, and specific. No filler. No generic advice. Reference their actual choices.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 250,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0]?.text || '';
    return res.status(200).json({ reflection: text, mode: 'coach_reflection' });
  } catch (err) {
    console.error('[coach_reflection] error:', err);
    return res.status(200).json({ reflection: null, mode: 'coach_reflection' });
  }
}
