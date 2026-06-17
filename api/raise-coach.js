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

// When the request comes from the offer product, retarget raise-themed
// prompts to the job-offer negotiation context (recruiter persona).
function offerize(text, isOffer) {
  if (!isOffer) return text;
  return text
    .replace(/salary negotiation coach/g, 'job-offer negotiation coach')
    .replace(/salary negotiation/g, 'job-offer negotiation (a candidate countering their offer before signing)')
    .replace(/raise negotiation/g, 'offer negotiation')
    .replace(/raise conversation/g, 'offer negotiation call')
    .replace(/asking for a raise/g, 'countering their job offer')
    .replace(/negotiating a raise/g, 'negotiating their job offer')
    .replace(/toward a raise/g, 'toward a better offer')
    .replace(/Manager/g, 'Recruiter')
    .replace(/manager/g, 'recruiter')
    .replace(/Employee/g, 'Candidate')
    .replace(/employee/g, 'candidate');
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
  if (body.mode === 'disc_insights') {
    return handleDiscInsights(body, res);
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
  if (body.mode === 'simulate_followup') {
    return handleSimulateFollowup(body, res);
  }
  if (body.mode === 'coach_reflection') {
    return handleCoachReflection(body, res);
  }
  if (body.mode === 'coaching_insight') {
    return handleCoachingInsight(body, res);
  }
  if (body.mode === 'coaching_chat') {
    return handleCoachingChat(body, res);
  }
  if (body.mode === 'case_polish') {
    return handleCasePolish(body, res);
  }
  if (body.mode === 'case_save') {
    return handleCaseSave(body, res);
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
// ══ DISC INSIGHTS — AI-generated canvas insights           ══
// ════════════════════════════════════════════════════════════
// ── OFFER product: prompts for the Counter Kit (disc_insights) ──
// Numbers are computed client-side and passed in offer_ctx; the model
// must use them verbatim — it never invents market rates.
function buildOfferDiscPrompts(part, oc, answeredDims) {
  const DL = { under_24h: 'under 24 hours', '24_72h': '24\u201372 hours', this_week: 'this week (3\u20137 days)', '1_2wk': '1\u20132 weeks', none: 'no deadline given' };
  const fm = (n) => '$' + (Number(String(n || 0).replace(/[^\d]/g, '')) || 0).toLocaleString('en-US');
  const baseNum = Number(String(oc.base || 0).replace(/[^\d]/g, '')) || 0;
  const signingAsk = Math.max(500, Math.round(baseNum * 0.08 / 500) * 500);

  const ctxBlock = `THE OFFER:
- Role: ${oc.role || 'not specified'}
- Base offered: ${fm(oc.base)}
- Response deadline: ${DL[oc.deadline] || 'not specified'}
- Competing offer: ${oc.competing || 'no'}
- Hiring process speed: ${oc.speed || 'normal'} (chased/fast = strong hiring urgency = leverage)
- Package extras: ${oc.extras || 'base only'}
- Work arrangement: ${oc.worktype || 'not specified'}${oc.worktype === 'on_site' ? ' (on-site = smaller local talent pool = added leverage)' : oc.worktype === 'remote' ? ' (remote = national talent pool = lean on other leverage)' : ''}
- Employment status: ${oc.employment || 'not specified'}${oc.employment === 'employed_stable' ? ' (CAN WALK AWAY \u2014 the strongest position; counters carry near-zero real risk, but never phrase it as a threat)' : oc.employment === 'between_jobs' ? ' (weaker fallback \u2014 keep the counter warm and low-friction, NEVER let urgency or desperation show in any script)' : oc.employment === 'first_job' ? ' (first real offer \u2014 simple asks, extra reassurance about how normal countering is)' : oc.employment === 'employed_leaving' ? ' (employed but motivated to move \u2014 solid fallback, do not reveal the push factor)' : ''}
- Industry: ${oc.industry || 'not specified'}${/gov|public|school|universit|educat|health|hospital|medic|nurs/i.test(oc.industry || '') ? ' (rigid pay bands are common in this sector \u2014 lead the levers with review timeline, vacation, and title rather than base stretch)' : /tech|software|startup|saas|fintech/i.test(oc.industry || '') ? ' (equity and signing bonuses are normal asks \u2014 bands flex more here)' : ' (use industry norms qualitatively only \u2014 never invent figures)'}
- Company size: ${oc.company_size || 'not specified'}${{'cs_1_50':' (1\u201350 \u2014 leadership decides comp directly, more flexibility)','cs_51_200':' (51\u2013200 \u2014 some structure, package is negotiable)','cs_201_1k':' (201\u20131,000 \u2014 salary bands exist with real room inside)','cs_1k_5k':' (1,001\u20135,000 \u2014 HR involved, package levers matter)','cs_5k_plus':' (5,000+ \u2014 rigid base bands, focus on signing bonus and title)'}[oc.company_size] || ''}
- Salary anchor: ${oc.anchor === 'no_anchor' ? 'Candidate never shared a number — counter sets the first anchor' : oc.anchor === 'matched' ? 'Candidate shared a number and the offer matched it — counter needs new justification (market data, scope, competing signal) to go above their own anchor' : oc.anchor === 'below' ? 'Offer came in below what candidate stated — natural standing to re-ask for original number' : oc.anchor === 'above' ? 'Offer is above what candidate stated — company\'s internal band is higher than candidate\'s expectation, likely more room' : 'not specified'}
- City: ${oc.city || 'not provided'} (use ONLY for qualitative talent-pool and cost-of-living reasoning \u2014 NEVER state or imply specific market salary figures for this city)
- Candidate's natural voice: ${oc.tone || 'warm'} \u2014 write meeting_email and opening_script in this voice: ${oc.tone === 'direct' ? 'short sentences, no filler, gets to the number fast' : oc.tone === 'formal' ? 'polished, professional register, complete sentences, measured warmth' : 'friendly, personable, genuinely enthusiastic but professional'}
${oc.researched_max ? '- Candidate researched market max: ' + fm(oc.researched_max) + ' (use this as the market anchor — their counter can reference it without attribution)' : '- No market research provided \u2014 anchor on offer mechanics, never invent market data'}
${oc.jd_text ? '\nJOB DESCRIPTION (provided by candidate \u2014 use it to personalize: reference the actual scope, responsibilities, or requirements in the counter email, ask stack reasoning, and openers. Do not quote it back verbatim at length):\n' + oc.jd_text + '\n' : ''}

COMPUTED NUMBERS (deterministic, computed from offer mechanics \u2014 use EXACTLY these figures, never invent market rates or any other dollar amounts):
- Negotiation room: ${fm(oc.room_low)}\u2013${fm(oc.room_high)}
- Counter number (the base ask): ${fm(oc.counter)}
- SAFE counter: ${fm(oc.counter_safe)} | MODERATE counter: ${fm(oc.counter_moderate)} | AMBITIOUS counter: ${fm(oc.counter_ambitious)}
- Walk-away power: employment=${oc.employment||'not specified'}, competing offer=${oc.competing||'not specified'}
- Risk tolerance (stated intent): ${oc.risk || 'balanced'} (conservative = protect the offer and close cleanly, balanced = real gain without unnecessary friction, ambitious = maximum number on the table)
  NOTE: Walk-away power and risk tolerance are independent. Someone employed+competing but playing safe has real leverage and a conservative intent. Honour both.
- Years of experience: ${{ under2:'Under 2 years', '2_5':'2–5 years', '5_10':'5–10 years', over10:'10+ years' }[oc.experience] || oc.experience || 'not specified'} (affects talent market scarcity and counter anchor strength)
- Signing bonus ask (the trade-down lever): ${fm(signingAsk)}`;

  if (part === 'hooks' || part === 'teasers') {
    // Strip computed dollar amounts from ctxBlock for hooks — they must not leak before paywall
    const hooksCtxBlock = ctxBlock
      .replace(/- Negotiation room:.*\n/, '- Negotiation room: [locked — do not reference in hooks]\n')
      .replace(/- Counter number.*:\n/, '')
      .replace(/- SAFE counter:.*\n/, '- Counter tiers: [locked — do not reference dollar amounts]\n')
      .replace(/- Signing bonus ask.*\n/, '');
    return {
      system: `You are a senior job-offer negotiation coach. The candidate has an offer in hand and is deciding whether to counter before signing. Generate ONE hook sentence per section.

${hooksCtxBlock}

WHAT A HOOK MUST DO:
- Reveal something the candidate didn't already know \u2014 a hidden risk, counterintuitive dynamic, or non-obvious move
- Be specific to THEIR offer \u2014 not generic advice
- Make them think "I need to read more"
- NEVER restate their input back to them

POSITION HOOKS \u2014 the candidate's 4 negotiation dimensions:
- walkaway = WALK-AWAY POWER: objective leverage — employment status (what happens if they say no?) + competing offers (hard alternatives).
- risk_tol = RISK TOLERANCE: their stated intent — how bold they want to play. Independent from walk-away power.
- urgency = THEIR URGENCY: how badly the company needs this closed (process speed + deadline pressure).
- talent = TALENT MARKET: how replaceable the candidate is and at what price (work arrangement pool size + years of experience + market research + local market).
- offer = OFFER STRUCTURE: where the money sits and which levers exist (base + extras + company size band rigidity).

Diagnostic \u2014 name the hidden risk or opportunity in that dimension of THEIR situation.
NEVER mention specific dollar amounts or salary figures in diagnostic hooks.
Examples:
- risk_pos (employed + competing offer): "You can afford a no \u2014 which means the only thing that can weaken your counter is sounding like you can't."
- risk_pos (between jobs, wants it badly): "Your safest play isn't avoiding the counter \u2014 it's making one so warm and reasonable that a no costs them more goodwill than a yes costs budget."
- urgency (they chased, tight deadline): "A company that moved this fast has already spent political capital on you \u2014 their deadline is pressure theater that cuts in your favour."
- talent (10+ years, on-site): "A senior profile in a local-only search is exactly the hire that takes them six more months to replace \u2014 that math is your leverage."
- offer (base only, enterprise): "A base-only offer at a big company means every lever is still unused \u2014 and there are options beyond base that most candidates never think to ask for."

STRATEGY HOOKS — make each locked section feel like the thing they cannot afford to skip:
Rules for strategy hooks:
- NEVER mention specific dollar amounts, salary figures, or computed numbers — those are locked behind the paywall
- Name the EXACT mistake most people in their position make — specific, not general
- Reference their specific context (their role, their leverage signals, their deadline) — never generic
- End on an incomplete thought that makes them want to read the full section
- The hook must be DIFFERENT from what they'd get from ChatGPT — it references their leverage signals, deadline, and position

SPECIAL FORMAT FOR meeting_email — this one is NOT a teaser sentence:
- meeting_email must be the ACTUAL OPENING of the real counter email — the literal text the candidate would send, not a description of it.
- Start with "Subject: " then a real subject line, then "\\n\\n", then the first 2-3 sentences of the email body (greeting + warm opening + the lead-in to the ask).
- Write it in their natural voice (see tone above). Reference their actual role.
- STOP right before any number or specific figure would appear — the body must end mid-thought, leading into the ask, with NO dollar amounts, percentages, or salary figures anywhere.
- Do NOT explain or describe the email. Do NOT use phrases like "the email that..." or "this email...". Output only the email text itself.
- Example shape (write better, in their voice): "Subject: Re: [Role] offer — a quick note before I sign\\n\\nHi [Name],\\n\\nThank you again for the offer — I'm genuinely excited about the team and the scope of this role. Before I sign, I'd like to align on the compensation so we can close this cleanly. Based on the scope we discussed and where comparable roles are landing, I was hoping we could revisit the..."

Examples (write better than these, calibrated to THEIR specific situation):
- leverage_risk: "The rescind fear is real but statistically near-zero for professional counters — what actually kills offers is the candidate who sounds uncertain, not the one who asks for more."
- emphasize: "Most candidates in your position lead with the wrong ask — the order of the stack determines whether you get a yes on what matters or a no on everything."
- levers: "If they say the base is fixed, nine other levers activate — and the first pivot takes 10 seconds."
- avoid: "There's one phrase that tanks more offer negotiations than any pushback — and most people say it instinctively in the first 30 seconds."
- opening_script: "The recruiter's first impression of how you negotiate is formed in the first sentence — the four openers in this kit each send a different signal."
- pushback: "Every recruiter response to a counter is either a real constraint or a closing tactic — the response is completely different depending on which one it is."
- fallback: "If base is blocked, you have exactly one window to pivot before the conversation closes — this is what you say in that window."
- meeting_email: "Subject: Re: Senior Accountant offer — a quick note before I sign\\n\\nHi Sarah,\\n\\nThank you again for the offer — I'm genuinely excited about the team and the work ahead. Before I sign, I'd like to align on compensation so we can wrap this up cleanly. Based on the scope we discussed and the market for this role, I was hoping we could revisit the..."
- raise_case: "The 48 hours after you send the counter are the most important — this is the exact sequence that keeps the momentum in your direction."

Respond ONLY with valid JSON — exactly these 9 keys, one hook sentence each, no markdown:
{"leverage_risk":"...","emphasize":"...","levers":"...","opening_script":"...","pushback":"...","fallback":"...","meeting_email":"...","raise_case":"..."}`,
// Respond with all 8 keys.
      userMessage: `Candidate's leverage profile:\n${answeredDims}\n\nGenerate all 8 hook sentences — one per key. Every key required.`,
      maxTokens: 1200,
    };
  }

  if (part === 'full_kit' || part === 'strategy' || part === 'strategy_plan') {
    return {
      system: `You are a senior job-offer negotiation coach writing a complete, personalized Counter Kit for a candidate with an offer in hand.

${ctxBlock}

WRITING RULES:
- Write for THIS candidate. Reference their actual offer, deadline, leverage signals.
- Use EXACTLY the computed numbers above wherever a figure appears. NEVER invent market rates, percentages of "typical" raises, or any other dollar amounts.
- Every counter must signal enthusiasm to sign \u2014 never an ultimatum.
- Use **bold** for the single most important phrase per section only.
- Plain text with \\n line breaks. No headers inside sections.
- Tone: a coach who has closed 1,000 offer negotiations \u2014 direct, warm, zero filler.

SECTIONS:

leverage_risk:
  The non-obvious read of their specific leverage given the signals above. How to deploy it without putting the offer at risk. What rescind risk actually looks like (extremely rare for professional counters) and what genuinely triggers it. 4-5 sentences.

levers:
  One sentence: when base is blocked, the negotiation isn't over \u2014 it moves to the levers below.
  Then EXACTLY these 10 levers, each ONE line, **bold name** \u2014 when to use it for THIS candidate:
  **Signing bonus** / **Vacation days** / **Remote or hybrid days** / **Title** / **Start date** / **Annual review timeline (in writing)** / **Performance bonus** / **Relocation support** / **Education budget** / **Equity or options**.
  Order them by relevance to this candidate's situation (their extras, work arrangement, and role). End with one sentence on the trading rule: concede on levers, never on base, and never give two levers for nothing.

emphasize:
  This is the ASK STACK \u2014 what to ask for and in what order. Format exactly:
  **ASK 1 \u2014 Base: ${fm(oc.counter)}.** [Why base leads \u2014 it compounds every year and anchors every future job. 1-2 sentences tied to their situation.]
  **ASK 2 \u2014 Signing bonus: ${fm(signingAsk)}.** [Why this is the trade-down when base is blocked \u2014 one-time budget, doesn't touch their band. 1-2 sentences.]
  **FALLBACK \u2014 A written 6-month compensation review.** [When to deploy it and why it must be in writing. 1-2 sentences.]

opening_script:
  This is the PHONE OPENER \u2014 why the first 30 seconds of the call sets the recruiter's posture.
  Then 4 complete openers, each a different angle, in first person, using their counter number where natural:
  **Option 1 \u2014 Enthusiasm first:** [2-3 sentences]
  **Option 2 \u2014 Anchored to scope:** [2-3 sentences]
  **Option 3 \u2014 Sign-this-week:** [2-3 sentences]
  **Option 4 \u2014 Direct:** [2-3 sentences]

pushback:
  The key insight: every recruiter pushback is either a real constraint or a closing tactic \u2014 and the response differs.
  Then EXACTLY these 8 recruiter moves with responses, formatted as:
  **"[recruiter line]"**
  \u2192 [response, 1-2 sentences, non-defensive, using their computed numbers where natural]
  Cover exactly: "This is our best and final offer." / "We need your answer by tomorrow." / "What's your current salary?" / "The band for this role is fixed." / "We can revisit compensation at your first review." / [silence after the counter] / "Why do you need more?" / "The offer expires today" (exploding deadline).

meeting_email:
  This is the COUNTER EMAIL. One sentence on why countering in writing first beats improvising on a call.
  Then the complete email:
  Subject: [short, references their offer]
  
  [Full email body, 90-130 words, first person, warm. Must include EXACTLY the counter number ${fm(oc.counter)}, one sentence of reasoning anchored to role scope, and must end with the closing signal: if we can get there, ready to sign this week. Only placeholder allowed: [Name] for the recruiter.]

fallback:
  This is the FALLBACK PLAYBOOK \u2014 what to do if base is rejected. Three concrete moves in order:
  1. The signing bonus pivot: the exact script to use when they say base is fixed. One sentence in quotes, first person. Must include ${fm(signingAsk)} as the ask. Why this works (one-time budget, doesn't touch the band).
  2. The 6-month review ask: how to get a compensation review committed in writing, not verbally. One sentence in quotes. Must specify 'in writing' and name a date.
  3. The title upgrade: how a title change now creates comp leverage in the next role. One sentence on when to deploy it.
  End with: 'The fallback sequence is: base \u2192 signing \u2192 review \u2192 title. Never give two levers for nothing.'

raise_case:
  This is the SEQUENCING PLAN \u2014 their 72-hour playbook. Numbered steps:
  1. [Send the counter email first \u2014 when, and why writing leads]
  2. [The waiting window \u2014 how long, what silence means]
  3. [The call \u2014 take it practiced, openers ready]
  4. [Getting the final number in writing before signing]
  5. [If the deadline is too tight \u2014 the exact extension script, one sentence in quotes]

Return ONLY these 8 keys as valid JSON. Values are plain text strings with \\n for line breaks. No markdown fences. No preamble.
{"leverage_risk":"...","emphasize":"...","levers":"...","opening_script":"...","pushback":"...","fallback":"...","meeting_email":"...","raise_case":"..."}`,
// 8 keys total.
      userMessage: `Candidate's leverage profile:\n${answeredDims}\n\nGenerate the 8 Counter Kit sections.`,
      maxTokens: 4096,
    };
  }

  if (part === 'strategy_position') {
    return {
      system: `You are a senior job-offer negotiation coach. Write 2-3 sentences of deep tactical insight for each of the candidate's 4 negotiation dimensions.

${ctxBlock}

DIMENSIONS:
- walkaway = WALK-AWAY POWER \u2014 objective leverage. Synthesize employment status (what happens if they say no?) and competing offers. A competing offer in hand is a BATNA, not a bluff \u2014 the insight must say how strong or weak this alternative actually is.
- risk_tol = RISK TOLERANCE \u2014 their stated intent. Note the interaction with walkaway: strong walkaway + safe risk = real power, conservative use; weak walkaway + ambitious risk = bold play that must be executed perfectly. The insight must call out this dynamic explicitly.
- urgency = THEIR URGENCY \u2014 how badly the company needs this closed. Synthesize process speed and deadline. Tight deadline + fast process = they want it done, which is leverage. Slow process + no deadline = urgency is unclear, counter needs to create its own momentum (the sign-this-week line).
- talent = TALENT MARKET \u2014 how replaceable they are and at what price. Synthesize work arrangement (remote = national pool, on-site = local scarcity), years of experience (seniority = scarcity), market research, and city. The read: how long and how expensive would replacing them be?
- offer = OFFER STRUCTURE \u2014 where the money sits and what can move. Synthesize base vs extras (which levers are unused) and company size (band rigidity, signing-bonus likelihood).

For each, calibrate by the dimension's score:
- Strong (\u226565): the hidden risk of assuming it's enough, OR exactly how to deploy it without burning it. 2-3 sentences.
- Medium (42-64): the dynamic plus one specific move to strengthen it before the call. 2-3 sentences.
- Weak (<42): the honest consequence AND the play that works anyway \u2014 never leave them hopeless, weak dims have counters too. 2-3 sentences.

Use EXACTLY the computed numbers above where figures appear. Use **bold** for the single key tactic only. No generic advice \u2014 every sentence must be impossible to write without THEIR specific answers.

Return ONLY these 5 keys as valid JSON. No markdown fences. No preamble.
{"walkaway":"...","risk_tol":"...","urgency":"...","talent":"...","offer":"..."}`,
      userMessage: `Candidate's leverage profile:\n${answeredDims}\n\nGenerate the 5 position insights.`,
      maxTokens: 800,
    };
  }
  return null;
}

async function handleDiscInsights(body, res) {
  const { blocker, answers, dims, levers, weaks, part, tailor } = body;
  const storeFor = body._store_for; // access token to store results for paid user
  const isOffer = body.product === 'offer';
  const oc = body.offer_ctx || {};

  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers required' });
  }

  const dimDescriptions = {
    // raise product dims
    evidence: { label: 'Evidence & Leverage' },
    timing:   { label: 'Timing & Window'     },
    manager:  { label: 'Manager'              },
    company:  { label: 'Company & Environment'},
    market:   { label: 'Market & Positioning' },
    // offer product dims
    walkaway: { label: 'Walk-Away Power (employment + competing offer)' },
    risk_tol: { label: 'Risk Tolerance (how bold they want to play)' },
    urgency:  { label: 'Their Urgency' },
    talent:   { label: 'Talent Market' },
    offer:    { label: 'Offer Structure' },
  };

  const answeredDims = Object.entries(dimDescriptions)
    .filter(([k]) => answers[k])
    .map(([k, v]) => {
      const score    = dims && dims[k] ? dims[k] : 50;
      const strength = score >= 60 ? 'strong' : score >= 40 ? 'medium' : 'weak';
      return `- ${v.label} (${k}): user answered "${answers[k]}" — rated ${strength} (score ${score}/100)`;
    })
    .join('\n');

  const blockerContext = blocker || 'unknown';
  const leverList      = (levers || []).join(', ') || 'none identified';
  const weakList       = (weaks  || []).join(', ') || 'none identified';

  // Tailor context block (used by strategy only)
  const tailorBlock = tailor && (tailor.role_change || tailor.manager_reaction || tailor.timing)
    ? '\nADDITIONAL CONTEXT:\n' +
      (tailor.role_change      ? `- Role growth: ${tailor.role_change}\n`           : '') +
      (tailor.manager_reaction ? `- Expected manager reaction: ${tailor.manager_reaction}\n` : '') +
      (tailor.timing           ? `- Conversation timing: ${tailor.timing}\n`         : '')
    : '';

  let system, userMessage, maxTokens;

  // ── OFFER product — Counter Kit prompts ───────────────────────────────────
  if (isOffer) {
    const op = buildOfferDiscPrompts(part, oc, answeredDims);
    if (!op) return res.status(400).json({ error: `Unknown part: ${part}` });
    system = op.system; userMessage = op.userMessage; maxTokens = op.maxTokens;

  // ── HOOKS — merged position + teasers (one call at paywall) ────────────────
  // Generates one sharp hook sentence per section (all 12 blocks).
  // Position hooks: diagnostic insight the user didn't know.
  // Strategy hooks: counterintuitive setup that makes them want the full section.
  } else if (part === 'hooks' || part === 'teasers') {

    system = `You are a senior salary negotiation coach. Generate ONE hook sentence per section.

The user is preparing to ask for a raise.
Blocker: "${blockerContext}"
Leverage: ${leverList}
Weak spots: ${weakList}

WHAT A HOOK MUST DO:
- Reveal something the user didn't already know — a hidden risk, counterintuitive dynamic, or non-obvious move
- Be specific to THEIR situation — not generic advice that works for anyone
- Make them think "I need to read more" — not "I already knew that"
- NEVER restate their input back to them
- NEVER state the obvious

POSITION HOOKS (evidence/timing/manager/company/market):
These are diagnostic — name the hidden risk or opportunity IN their specific dimension score.
Strong dimensions: reveal the trap of assuming it's enough, or how to weaponize it properly.
Weak dimensions: name the specific consequence of this weakness in their situation.
Examples:
- evidence (strong, recruiters): "Recruiter interest is third-party validation — but only if you can quote a specific range, not just 'I've been approached.'"
- evidence (weak): "No documented wins means you're asking for trust instead of payment for proven value — a losing position in any environment."
- timing (strong, review soon): "The review window is your best shot, but managers who expect the conversation are also more prepared to deflect it."
- manager (weak, distant): "A distant manager won't fight for you — they'll defer upward, which means your real audience is their boss."
- company (weak, cutting): "Cost-cutting environments kill raises that sound like overhead and approve raises that sound like retention insurance."

STRATEGY HOOKS (leverage_risk/emphasize/avoid/opening_script/pushback/meeting_email/raise_case):
These are conversion hooks — make the locked section feel essential.
Examples:
- leverage_risk: "Your competing offer is your strongest card — but play it first and you become a flight risk, not a valued employee."
- emphasize: "Most people lead with what they've done — the ones who get raises lead with what it would cost to lose them."
- avoid: "The fastest way to lose this conversation is apologizing before you ask — it signals you're already prepared to back down."
- opening_script: "Your first 30 seconds decide the manager's posture for the rest of the meeting — most people waste it."
- pushback: "Every objection is one of two things: a real constraint or a test of how serious you are — and you handle them completely differently."
- meeting_email: "Managers ignore comp emails that sound like a request — they open ones that sound like a decision has already been made."
- raise_case: "Most one-pagers fail because they argue what the person deserves — the ones that work prove what it costs to lose them."

Respond ONLY with valid JSON, one sentence per key, no markdown:
{"evidence":"...","timing":"...","manager":"...","company":"...","market":"...","leverage_risk":"...","emphasize":"...","avoid":"...","opening_script":"...","pushback":"...","meeting_email":"...","raise_case":"..."}`;

    userMessage = `User's position:\n${answeredDims}\n\nGenerate 12 hook sentences — one per key.`;
    maxTokens   = 800;

  // ── STRATEGY — full plan at checkout (all 12 sections) ─────────────────────
  // Generates complete content for all sections.
  // Position sections: 2-3 sentences of deep tactical insight.
  // Strategy sections: full tactical content with exact volume specified.
  } else if (part === 'strategy' || part === 'strategy_plan') {
    // 7 plan sections — the heavy call
    system = `You are a senior salary negotiation coach writing a complete, personalized raise negotiation plan.

The user is preparing to ask for a raise.
Blocker: "${blockerContext}"
Leverage: ${leverList}
Weak spots: ${weakList}

WRITING RULES:
- Write for THIS specific person. Reference their answers, their blocker, their leverage and weak spots.
- Every sentence must contain information they didn't already know.
- Lead with the counterintuitive move, not the obvious one.
- Use **bold** for the single most important phrase per section only.
- Plain text with line breaks for structure. No headers inside sections.
- Tone: a coach who has seen 1,000 of these conversations — direct, warm, zero filler.

SECTIONS:

leverage_risk:
  The non-obvious dynamic of their specific leverage. How to deploy it without triggering a negative reaction. What to say and what to avoid. 4-5 sentences.

emphasize:
  What most people get wrong about emphasis given their specific position.
  Then 5 numbered points — each ONE sentence with a concrete tactic specific to their situation:
  1. [tactic]
  2. [tactic]
  3. [tactic]
  4. [tactic]
  5. [tactic]

avoid:
  The most common self-sabotage pattern for someone in their position.
  Then 4 numbered points — each ONE sentence naming the exact phrase or behavior to avoid AND why:
  1. [phrase/behavior] — [why it backfires]
  2. [phrase/behavior] — [why it backfires]
  3. [phrase/behavior] — [why it backfires]
  4. [phrase/behavior] — [why it backfires]

opening_script:
  Why the first 30 seconds matters more than the rest of the conversation for their specific situation.
  Then 4 complete opening scripts, each taking a different psychological angle:
  **Option 1 — Collaborative:** [full 2-3 sentence opening in first person]
  **Option 2 — Data-driven:** [full 2-3 sentence opening in first person]
  **Option 3 — Future-focused:** [full 2-3 sentence opening in first person]
  **Option 4 — Direct:** [full 2-3 sentence opening in first person]
  Each option should feel meaningfully different — different frame, different emotional register.

pushback:
  The key insight about how to categorize objections before responding.
  Then 8 specific manager objections with responses, formatted exactly as:
  **"[manager objection]"**
  → [their response, 1-2 sentences, specific and non-defensive]
  Cover: budget frozen, timing/wait for review, needs to check with HR, performance not there yet, surprised by the ask, vague deferral ("let me think about it"), threatening the relationship, and one curveball specific to their blocker.

meeting_email:
  What makes managers actually open and respond to comp emails.
  Then the complete email:
  Subject: [specific subject line]
  
  [Full email body, 120-160 words. First person. Confident but not ambitious. Ends with a clear ask for 20-30 minutes.]

raise_case:
  Why most one-paragraph raise cases fail to land.
  Then the one-paragraph raise case:
  [2-4 sentences. Leads with scope/impact, not tenure. Includes a specific number or range. Ends with the ask.]

Return ONLY these 7 keys as valid JSON. Values are plain text strings with \n for line breaks. No markdown fences. No preamble.
{"leverage_risk":"...","emphasize":"...","avoid":"...","opening_script":"...","pushback":"...","meeting_email":"...","raise_case":"..."}`;

    userMessage  = `User's position:\n${answeredDims}${tailorBlock}\n\nGenerate the 7 plan sections.`;
    maxTokens    = 2500;

  } else if (part === 'strategy_position') {
    // 5 position sections — the fast call (runs in parallel with strategy_plan)
    system = `You are a senior salary negotiation coach. Write 2-3 sentences of deep tactical insight for each of the user's 5 position dimensions.

The user is preparing to ask for a raise.
Blocker: "${blockerContext}"
Leverage: ${leverList}
Weak spots: ${weakList}

For each dimension, calibrate by score:
- Strong (score ≥60): Name the hidden risk of assuming it's enough, OR the exact way to weaponize it. 2-3 sentences.
- Medium (score 40-59): Name the dynamic and one specific move to strengthen or leverage it. 2-3 sentences.
- Weak (score <40): Name the specific consequence AND one concrete action they can take in 7 days. 2-3 sentences.

Use **bold** for the single key tactic only. Direct, specific — no generic advice.

Return ONLY these 5 keys as valid JSON. No markdown fences. No preamble.
{"evidence":"...","timing":"...","manager":"...","company":"...","market":"..."}`;

    userMessage = `User's position:\n${answeredDims}\n\nGenerate the 5 position insights.`;
    maxTokens   = 800;

  } else if (part === 'store_kit') {
    // Client-side kit storage: pre-generated kit JSON → Redis (no Claude API call)
    if (!storeFor || !body._kit_json) return res.status(400).json({ error: 'store_kit requires _store_for and _kit_json' });
    try {
      await Promise.all([
        redis.set(`offer:kit:${storeFor}`, body._kit_json, { ex: 86400 * 30 }),
        body.offer_ctx ? redis.set(`offer:ctx:${storeFor}`, JSON.stringify(body.offer_ctx), { ex: 86400 * 30 }) : Promise.resolve(),
      ]);
      return res.status(200).json({ stored: true });
    } catch(e) {
      return res.status(500).json({ error: 'store failed' });
    }
  } else {
    return res.status(400).json({ error: `Unknown part: ${part}` });
  }


  // If _store_for present, generate and store for paid user (webhook path)
  if (storeFor && redis) {
    try {
      const fullResp = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: maxTokens,
        system, messages: [{ role: 'user', content: userMessage }],
      });
      const kitText = (fullResp.content[0]?.text || '').trim();
      // Store kit + context together so returning users can restore their data
      const offerCtxToStore = body.offer_ctx || null;
      await Promise.all([
        redis.set(`offer:kit:${storeFor}`, kitText, { ex: 86400 * 30 }),
        offerCtxToStore ? redis.set(`offer:ctx:${storeFor}`, JSON.stringify(offerCtxToStore), { ex: 86400 * 30 }) : Promise.resolve(),
      ]);
      return res.status(200).json({ stored: true });
    } catch(e) {
      console.error('[raise-coach] store kit error:', e.message);
      return res.status(500).json({ error: 'store failed' });
    }
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = (response.content[0]?.text || '').trim();
    let insights = {};
    try {
      // Strip markdown fences, then extract the first {...} JSON object
      let cleaned = raw.replace(/```json|```/g, '').trim();
      // If Claude added preamble text, extract the JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]+\}/);
      if (jsonMatch) cleaned = jsonMatch[0];
      insights = JSON.parse(cleaned);
      if (typeof insights !== 'object' || Array.isArray(insights)) insights = {};
      if (Object.keys(insights).length === 0) {
        console.error('[disc_insights] empty insights, raw:', raw.slice(0, 300));
      }
    } catch (parseErr) {
      console.error('[disc_insights] JSON parse error:', parseErr.message, 'raw:', raw.slice(0, 300));
      insights = {};
    }

    return res.status(200).json({ insights, mode: 'disc_insights', part: part || 'hooks' });
  } catch (err) {
    console.error('[disc_insights] API error:', err);
    return res.status(200).json({ insights: {}, mode: 'disc_insights', part: part || 'hooks' });
  }
}


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
      messages: [{ role: 'user', content: offerize(prompt, body.product === 'offer') }],
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
      messages: [{ role: 'user', content: offerize(prompt, body.product === 'offer') }],
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
  const userOpening = context?.user_opening || '';

  const situationLine = userOpening
    ? `The employee just opened the conversation by saying: "${userOpening}"\nTheir underlying concern: "${blockerLabel}"`
    : `An employee is negotiating a raise. Their main concern: "${blockerLabel}"`;

  const prompt = `Generate 5-6 realistic manager response THEMES for a salary negotiation.

SITUATION: ${situationLine}
${role ? `Role: ${role}` : ''}
${timing ? `Timeline: ${timing}` : ''}

For each scenario, provide:
- "type": a SHORT quote (3-7 words) showing what the manager says. This is the pill label — it must be instantly understandable. Write it as a direct mini-quote in the manager's voice, like: "No budget right now" or "Why do you deserve more?" or "Let me think about it". Do NOT use abstract labels like "Deflecting upward" or "Passive agreement" — users can't tell what those mean.${userOpening ? '\n- The manager is responding DIRECTLY to what the employee just said. Each response should feel like a natural reaction to their specific opening.' : ''}
- "text": the full 1-2 sentence version of what the manager would say.
- "difficulty": one of "easy", "tough", or "curveball". Easy = receptive, open, or curious responses. Tough = standard pushback, budget objections, delays. Curveball = unexpected, emotional, or confrontational responses that catch you off guard.

The themes should be VARIED — mix supportive, challenging, deflecting, emotional, and factual responses. Make them feel like a real person. Include a mix of difficulties.

JSON only, no preamble:
{ "scenarios": [ { "type": "\\"No budget right now\\"", "text": "Budgets are locked until...", "difficulty": "tough" }, ... ] }`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: offerize(prompt, body.product === 'offer') }],
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

Generate 4-5 possible REPLY THEMES the employee could use, RANKED from most effective to least effective. For each, provide:
- "theme": a short plain-English label (3-6 words) that instantly tells the user what they'd say. Write it as a mini-summary in first person, like: "Share my market data", "Ask what it would take", "Push back firmly", "Suggest a timeline". Do NOT use abstract labels like "Data-driven approach" — users can't tell what those mean.
- "text": the full response (1-2 sentences, specific, strategic)
- "score": effectiveness rating 1-5 (5 = strongest move that most likely advances toward a raise, 1 = weakest or riskiest move)

Sort the replies from highest score to lowest. The first reply should be the BEST strategic move for this situation.

Make the replies varied — some direct, some diplomatic, some data-driven. Each should be a genuinely different approach.

JSON only:
{ "replies": [ { "theme": "Share my market data", "text": "I've done some research...", "score": 5 }, ... ] }`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: offerize(prompt, body.product === 'offer') }],
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
      messages: [{ role: 'user', content: offerize(prompt, body.product === 'offer') }],
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
// ══ SIMULATE FOLLOWUP — manager responds to user's reply    ══
// ════════════════════════════════════════════════════════════
// ══ SIMULATE FOLLOWUP — multiple possible manager reactions  ══
// ════════════════════════════════════════════════════════════
// After the user picks a reply, the manager could react in several ways.
// This returns 4-5 possible manager follow-up responses as scenario chips
// (same pattern as the initial scenario selection), keeping the tree
// branching at every level.
async function handleSimulateFollowup(body, res) {
  const { conversation_history, blocker, context } = body;
  const role = context?.role || '';
  const history = (conversation_history || [])
    .map(t => `${t.role === 'manager' ? 'Manager' : 'You'}: "${t.text}"`)
    .join('\n');

  const prompt = `You're simulating a salary negotiation. The employee's concern: "${blocker?.label || 'asking for a raise'}"
${role ? `Their role: ${role}` : ''}

Conversation so far:
${history}

The employee just said their last line. Now generate 4-5 DIFFERENT ways the manager could respond next. Each should be a genuinely different reaction — some supportive, some resistant, some deflecting, some curious.

For each scenario:
- "type": a short quote (3-7 words) showing what the manager says — a mini-quote in the manager's voice like: "That's fair, let me check", "I need to loop in HR", "What exactly are you asking for?"
- "text": the full 1-2 sentence version
- "difficulty": one of "easy", "tough", or "curveball". Easy = receptive/open. Tough = standard pushback. Curveball = unexpected/confrontational.

JSON only:
{ "scenarios": [ { "type": "\\"That's fair, let me check\\"", "text": "...", "difficulty": "easy" }, ... ] }`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: offerize(prompt, body.product === 'offer') }],
    });
    const raw = response.content[0]?.text || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json({
      scenarios: parsed.scenarios,
      mode: 'simulate_followup',
    });
  } catch (err) {
    console.error('[simulate_followup] error:', err);
    return res.status(200).json({
      scenarios: null,
      mode: 'simulate_followup',
    });
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
      messages: [{ role: 'user', content: offerize(prompt, body.product === 'offer') }],
    });
    const text = response.content[0]?.text || '';
    return res.status(200).json({ reflection: text, mode: 'coach_reflection' });
  } catch (err) {
    console.error('[coach_reflection] error:', err);
    return res.status(200).json({ reflection: null, mode: 'coach_reflection' });
  }
}

// ════════════════════════════════════════════════════════════
// ══ COACHING INSIGHT — personalized feedback after each     ══
// ══ practice action (opening picked, scenario, reply)       ══
// ════════════════════════════════════════════════════════════
// Uses Haiku for speed — this runs in background during practice.
async function handleCoachingInsight(body, res) {
  const { action, context, conversation_history, blocker } = body;
  const blockerLabel = blocker?.label || 'asking for a raise';
  const history = (conversation_history || [])
    .map(t => `${t.role === 'manager' ? 'Manager' : 'You'}: "${t.text}"`)
    .join('\n');

  let prompt;
  const gistInstruction = `\n\nRESPONSE FORMAT — respond ONLY with valid JSON, no preamble:\n{ "gist": "One sentence: the key risk or strength of this move (max 15 words, starts with a verdict like 'Strong —', 'Risky —', 'Safe —', 'Bold —')", "full": "The full multi-paragraph analysis below" }`;

  if (action === 'opening_picked') {
    prompt = `You are a salary negotiation coach. A person whose concern is "${blockerLabel}" chose an opening with the theme: "${context?.theme || 'direct approach'}"

Analyze the STRATEGIC APPROACH of this opening theme. Do NOT quote, reference, or critique any specific words or phrases they used. Analyze only the strategy and direction.

For the "full" field, give structured feedback using this EXACT format (1 sentence each):

**Approach:** What negotiation strategy this type of opening signals to a manager
**Risk:** One strategic risk of this approach direction (not about wording)
**Opportunity:** What this approach opens up if the manager responds positively
**Next move:** What type of manager reaction to prepare for after this type of opening

CRITICAL: Do NOT reference or critique their specific words, phrasing, or language. Only analyze the strategic approach and direction.${gistInstruction}`;
  }
  else if (action === 'scenario_selected') {
    prompt = `You are a salary negotiation coach. A person whose concern is "${blockerLabel}" is practicing their raise conversation.

The manager responded with a "${context?.scenario_type || ''}" type of response.

Analyze the MANAGER'S RESPONSE TYPE only. Do NOT re-analyze the user's opening or quote specific words.

For the "full" field, give structured feedback using this EXACT format (1 sentence each):

**Signal:** What this type of manager response reveals about their position (supportive, defensive, deflecting, testing)
**Hidden meaning:** What managers typically mean beneath this type of response
**Preparation:** What strategic approach works best when facing this type of reaction
**Watch for:** The key signal to listen for that tells you whether to push forward or adjust

CRITICAL: Analyze the response type and strategy only.${gistInstruction}`;
  }
  else if (action === 'reply_chosen') {
    prompt = `You are a salary negotiation coach. A person whose concern is "${blockerLabel}" is practicing their raise conversation.

They chose a reply with the theme: "${context?.reply_theme || 'direct response'}" in response to a manager who gave a "${context?.scenario_type || ''}" reaction.

Analyze the REPLY STRATEGY only. Do NOT re-analyze their opening or the manager's response. Do NOT quote or critique specific words.

For the "full" field, give structured feedback using this EXACT format (1 sentence each):

**Strategy:** What negotiation tactic this type of reply represents
**Strength:** The strongest strategic element of this approach direction
**Weakness:** One strategic vulnerability in this approach (not about wording)
**After this:** What typically happens next in negotiations after this type of reply

CRITICAL: Analyze the strategic direction only.${gistInstruction}`;
  }
  else {
    prompt = `You are a salary negotiation coach giving brief feedback. The person's concern: "${blockerLabel}". Action: ${action}.${gistInstruction}`;
  }

  try {
    const response = await client.messages.create({
      model: NUDGE_MODEL_ID,
      max_tokens: 350,
      messages: [{ role: 'user', content: offerize(prompt, body.product === 'offer') }],
    });
    const raw = (response.content[0]?.text || '').trim();
    // Try to parse as JSON for new gist+full format
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      return res.status(200).json({ insight: parsed.full || raw, gist: parsed.gist || '', mode: 'coaching_insight' });
    } catch (e) {
      // Fallback — old format (plain text), generate gist from first sentence
      const firstSentence = raw.split(/[.!]\s/)[0] || raw.slice(0, 80);
      return res.status(200).json({ insight: raw, gist: firstSentence, mode: 'coaching_insight' });
    }
  } catch (err) {
    console.error('[coaching_insight] error:', err);
    return res.status(200).json({ insight: null, gist: null, mode: 'coaching_insight' });
  }
}

// ════════════════════════════════════════════════════════════
// ══ COACHING CHAT — free-form conversation with the coach   ══
// ══ Uses full practice context for personalized responses    ══
// ════════════════════════════════════════════════════════════
// Uses Sonnet for deeper, more nuanced coaching responses.
async function handleCoachingChat(body, res) {
  const { message, chat_history, practice_context } = body;
  const blocker = practice_context?.blocker || body.blocker || {};
  const blockerLabel = blocker?.label || 'asking for a raise';
  const userOpening = practice_context?.user_opening || '';
  const scenariosExplored = practice_context?.scenarios_explored || [];
  const branchHistory = practice_context?.branch_history || [];
  const conversation = practice_context?.conversation || [];

  const practiceHistory = conversation
    .map(t => `${t.role === 'manager' ? 'Manager' : 'You'}: "${t.text}"`)
    .join('\n');

  const branchSummary = branchHistory
    .map(b => `Scenario: "${b.scenario}" → User chose: "${b.reply}"`)
    .join('\n');

  const chatMessages = (chat_history || []).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  const systemPrompt = offerize(`You are a salary negotiation coach having a conversation with someone who is practicing their raise negotiation.

THEIR SITUATION:
- Main concern: "${blockerLabel}"
${userOpening ? `- They opened with: "${userOpening}"` : '- Haven\'t picked an opening yet'}
${scenariosExplored.length > 0 ? `- Scenarios explored: ${scenariosExplored.join(', ')}` : ''}

${practiceHistory ? `PRACTICE CONVERSATION SO FAR:\n${practiceHistory}\n` : ''}
${branchSummary ? `CHOICES THEY'VE MADE:\n${branchSummary}\n` : ''}

COACHING GUIDELINES:
- Be direct, warm, and specific. Reference their actual practice choices when relevant.
- Give actionable advice they can use in the real conversation.
- If they ask about something they haven't practiced yet, encourage them to try it in practice mode.
- Keep responses to 2-4 sentences. Don't lecture.
- Never use markdown formatting, bullets, or headers. Plain conversational text only.
- You're a supportive coach, not a textbook. Talk like a trusted mentor.`, body.product === 'offer');

  try {
    const messages = [
      ...chatMessages,
      { role: 'user', content: message },
    ];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: messages,
    });
    const text = response.content[0]?.text || '';
    return res.status(200).json({ reply: text, mode: 'coaching_chat' });
  } catch (err) {
    console.error('[coaching_chat] error:', err);
    return res.status(200).json({ reply: null, mode: 'coaching_chat' });
  }
}

// ════════════════════════════════════════════════════════════
// ══ CASE POLISH MODE — polish raw answers into professional raise case sections
// ════════════════════════════════════════════════════════════

const CASE_SECTION_PROMPTS = {
  performance: {
    0: { name: 'Opening Statement', instruction: 'Write a 1-2 sentence professional opening statement for a raise request. Frame it as a compensation alignment conversation, not a complaint. Use the person\'s role and tenure naturally. Be confident and direct.' },
    1: { name: 'Key Results', instruction: 'Rewrite these results as 2-3 quantified achievements for a professional raise document. Output EACH result on its own line in this EXACT format: **Short Title** — one sentence describing the impact with numbers/outcomes. The title is 2-4 words (e.g. "Checkout Redesign"). Use a real em-dash (—) between title and description. No bullets, no numbering, one result per line. Lead the description with the measurable outcome.' },
    2: { name: 'Recognition & Reviews', instruction: 'Write a brief professional sentence summarizing the recognition, then add: [[badges: TAG1 | TAG2 | gold:BEST_TAG | TAG3]] with 2-4 short tags (reviews, ratings, awards). Mark the single most impressive with gold: prefix. Each tag under 4 words. Example: Consistently recognized for strong performance. [[badges: Q1 review: Exceeds | gold: Impact Award | Mentoring 2 juniors]]' },
    3: { name: 'Compensation Alignment', instruction: 'Prefix your output with [[callout]] then write a short anchor story (2-3 sentences) leading with business impact. Example: [[callout]] When the enterprise deal was at risk, I redesigned the proposal flow in 3 days; the client signed a $420K contract the following week.' },
    4: { name: 'The Ask', instruction: 'Output the ask in EXACTLY this single-line format with no other text: [[ask]] $CURRENT \u2192 $TARGET | PERCENT increase \u00b7 EFFECTIVE_DATE. Use the real numbers from the answer. If no effective date is given, use "effective next quarter". Example: [[ask]] $112,000 \u2192 $134,000 | 19.6% increase \u00b7 effective next quarter' },
    5: { name: 'Additional Leverage', instruction: 'Weave this additional context naturally into a short supporting paragraph. If it mentions competing offers, frame carefully (loyalty first, then the market signal). If it mentions market data, reference it as external validation. If empty or skipped, return an empty string.' },
  },
  scope: {
    0: { name: 'Opening Statement', instruction: 'Write a 1-2 sentence professional opening statement for a compensation adjustment request based on scope expansion. Reference both the original role and the current role naturally. Frame it as aligning compensation to actual responsibilities, not a complaint.' },
    1: { name: 'Role Evolution', instruction: 'Prefix your output with [[callout]] then write a 2-3 sentence before/after of how the role grew. Example: [[callout]] I was hired to own a single service; today I lead the platform team of four and own the API roadmap.' },
    2: { name: 'Impact Delivered', instruction: 'Output EACH result on its own line in EXACTLY this format: **Short Title** \u2014 one sentence with the numbers/impact. Title is 2-4 words. Use a real em-dash. No bullets, no numbering, one per line. These came from responsibilities beyond the original job description.' },
    3: { name: 'The Timeline', instruction: 'Write a brief paragraph highlighting how long the person has been performing the expanded role and when they last received a compensation adjustment. Frame the time gap as supporting evidence — the longer the gap between expanded scope and pay adjustment, the stronger the case. Be factual and direct.' },
    4: { name: 'The Ask', instruction: 'Output the ask in EXACTLY this single-line format with no other text: [[ask]] $CURRENT \u2192 $TARGET | PERCENT increase \u00b7 EFFECTIVE_DATE. Use the real numbers from the answer. If no effective date is given, use "effective next quarter". Example: [[ask]] $112,000 \u2192 $134,000 | 19.6% increase \u00b7 effective next quarter' },
    5: { name: 'Additional Leverage', instruction: 'Weave this additional context naturally into a supporting paragraph. Reference market data, recruiter interest, or competing offers as external validation. If empty or skipped, return an empty string.' },
  },
  offer: {
    0: { name: 'Opening Statement', instruction: 'Write a 1-2 sentence opening that leads with loyalty and commitment to the company. Reference the person\'s tenure and role. Make clear this is a transparency conversation, not a threat. The tone should be: "I want to stay, and I want us to figure this out together."' },
    1: { name: 'The Situation', instruction: 'Prefix your output with [[callout]] then present the competing offer factually (company, role, compensation) in 2-3 sentences, framed as transparency not threat. Example: [[callout]] I have received an offer from a Series B company for a Senior PM role at $165K base plus equity, roughly 22% above my current pay.' },
    2: { name: 'Why I Want to Stay', instruction: 'Transform these reasons into a compelling, authentic paragraph about why the person values their current company. Reference specific things: the team, the product, the relationships, the mission. This section should make the manager feel valued too. Avoid generic "I love working here" — be specific.' },
    3: { name: 'What Would Be Lost', instruction: 'Write a brief paragraph framing what the company would lose — institutional knowledge, relationships, projects in flight, team continuity. Reference the offer deadline to create appropriate urgency without pressure. Frame it as mutual cost, not a threat.' },
    4: { name: 'The Ask & Timeline', instruction: 'Output the ask in EXACTLY this single-line format with no other text: [[ask]] $CURRENT \u2192 $TARGET | PERCENT increase \u00b7 EFFECTIVE_DATE. Use the real numbers from the answer. If no effective date is given, use "effective next quarter". Example: [[ask]] $112,000 \u2192 $134,000 | 19.6% increase \u00b7 effective next quarter For the date portion, use the offer/decision deadline if given.' },
    5: { name: 'Additional Context', instruction: 'Weave this additional context naturally into a supporting paragraph. If it mentions other offers or recruiter interest, frame as market validation. If empty or skipped, return an empty string.' },
  },
  market: {
    0: { name: 'Opening Statement', instruction: 'Write a 1-2 sentence opening requesting a market-rate adjustment. Reference the role, company, and location naturally. Frame it as proactive alignment — the person is raising this because they value the role and want to resolve the gap before it becomes a larger issue.' },
    1: { name: 'Market Evidence', instruction: 'Output EACH result on its own line in EXACTLY this format: **Short Title** \u2014 one sentence with the numbers/impact. Title is 2-4 words. Use a real em-dash. No bullets, no numbering, one per line. Each line is one data source: title is the source name (e.g. Glassdoor, LinkedIn), description is the figure. Example: **Glassdoor** \u2014 Median for this role in my city is $92K.' },
    2: { name: 'Role & Tenure', instruction: 'Write a brief paragraph about the person\'s tenure, last raise timing, and how their role has evolved. Frame the time since last adjustment as supporting evidence for the gap. Be factual and professional.' },
    3: { name: 'Contribution Summary', instruction: 'Transform these responsibilities into a value statement — not just what the person does, but what would be lost. Write 2-3 sentences highlighting their most impactful contributions. Frame responsibilities as evidence of market-rate work being done below market-rate pay.' },
    4: { name: 'The Ask', instruction: 'Output the ask in EXACTLY this single-line format with no other text: [[ask]] $CURRENT \u2192 $TARGET | PERCENT increase \u00b7 EFFECTIVE_DATE. Use the real numbers from the answer. If no effective date is given, use "effective next quarter". Example: [[ask]] $112,000 \u2192 $134,000 | 19.6% increase \u00b7 effective next quarter Frame the percent as the market gap.' },
    5: { name: 'Additional Context', instruction: 'Weave this additional context naturally into a supporting paragraph. Reference recruiter outreach, competing offers, or certifications as market validation. If empty or skipped, return an empty string.' },
  },
  promotion: {
    0: { name: 'Opening Statement', instruction: 'Write a 1-2 sentence opening expressing gratitude for the promotion while noting that compensation was not adjusted. Frame it as: the person wants to align their pay to the new responsibilities. Reference both old and new titles. Be professional and direct — grateful but clear.' },
    1: { name: 'What Changed', instruction: 'Transform this description into a clear before/after comparison of what the promotion changed. Structure it around: scope increase, team size, budget authority, decision-making level, reporting line. Be specific. The goal is to make the magnitude of the change undeniable.' },
    2: { name: 'Early Wins', instruction: 'Output EACH result on its own line in EXACTLY this format: **Short Title** \u2014 one sentence with the numbers/impact. Title is 2-4 words. Use a real em-dash. No bullets, no numbering, one per line. These show the person already performing at the new title level.' },
    3: { name: 'Compensation Gap', instruction: 'Write a factual paragraph presenting the gap between the person\'s current salary and the market rate for their new title. Include both numbers and the percentage gap. Frame it as: the promotion was earned, the compensation adjustment is overdue, and the gap grows more noticeable over time.' },
    4: { name: 'The Ask', instruction: 'Output the ask in EXACTLY this single-line format with no other text: [[ask]] $CURRENT \u2192 $TARGET | PERCENT increase \u00b7 EFFECTIVE_DATE. Use the real numbers from the answer. If no effective date is given, use "effective next quarter". Example: [[ask]] $112,000 \u2192 $134,000 | 19.6% increase \u00b7 effective next quarter' },
    5: { name: 'Additional Leverage', instruction: 'Weave this additional context naturally into a supporting paragraph. If it mentions the old role being backfilled at a higher salary, highlight that irony. If empty or skipped, return an empty string.' },
  },
};

async function handleCasePolish(body, res) {
  try {
    const { template, section_index, section_name, raw_answer, question_text, all_answers, q2_text, tone_context } = body;

    if (!template || section_index === undefined || !raw_answer) {
      return res.status(400).json({ error: 'Missing required fields: template, section_index, raw_answer' });
    }

    const templatePrompts = CASE_SECTION_PROMPTS[template];
    if (!templatePrompts) {
      return res.status(400).json({ error: 'Unknown template: ' + template });
    }

    const sectionPrompt = templatePrompts[section_index];
    if (!sectionPrompt) {
      return res.status(400).json({ error: 'Unknown section index: ' + section_index });
    }

    // Build context from all answers so far
    let contextBlock = '';
    if (all_answers && typeof all_answers === 'object') {
      const entries = Object.entries(all_answers).filter(([k, v]) => v);
      if (entries.length > 0) {
        contextBlock = '\n\nContext from other answers (for consistency, do NOT repeat these — just use for tone and context):\n' +
          entries.map(([k, v]) => `- ${k}: ${v}`).join('\n');
      }
    }

    const systemPrompt = `You are a professional raise case document writer. You take raw, informal input from employees and transform it into polished, professional language suitable for a formal salary review request document.

Rules:
- Write in first person ("I" not "they")
- Be direct and confident, not ambitious or entitled
- Use specific numbers and facts from the input — never fabricate
- Keep it concise: 2-4 sentences per section maximum
- Match the tone of a senior professional writing to their manager
- No headers, labels, or bullet formatting — just flowing prose (unless the section specifically calls for bullets)
- If the input is empty or says "skip", return an empty string`;

    const userPrompt = `Template: ${template} (Performance Case)
Section: ${sectionPrompt.name}
Section instruction: ${sectionPrompt.instruction}

Question asked: "${question_text}"
Raw answer from user: "${raw_answer}"${contextBlock}

Write ONLY the polished section text. No preamble, no labels, no markdown.`;

    // For section 0, run polish + Q2 placeholder generation in parallel
    let q2Promise = null;
    if (section_index === 0 && q2_text) {
      q2Promise = client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        system: 'You generate realistic placeholder examples for form inputs. Write exactly 3 brief bullet points that someone in the given role would relate to. Keep each bullet under 40 characters. No full sentences — just the key fact. Format: e.g.\\n1. [item]\\n2. [item]\\n3. [item]',
        messages: [{ role: 'user', content: `Role: ${raw_answer}\nTemplate type: ${template}\nThe next question is: "${q2_text}"\nWrite a placeholder in this exact format:\ne.g.\n1. [short answer relevant to the question]\n2. [short answer relevant to the question]\n3. [short answer relevant to the question]` }],
      }).catch(e => { console.warn('[case_polish] q2 placeholder failed:', e.message); return null; });
    }

    const [response, q2Response] = await Promise.all([
      client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      q2Promise || Promise.resolve(null),
    ]);

    const polished = response.content[0]?.text?.trim() || raw_answer;
    const q2_placeholder = q2Response?.content?.[0]?.text?.trim() || '';

    const result = {
      polished: polished,
      section_index: section_index,
      section_name: sectionPrompt.name,
      mode: 'case_polish',
    };
    if (q2_placeholder) result.q2_placeholder = q2_placeholder;

    return res.status(200).json(result);

  } catch (err) {
    console.error('[case_polish] error:', err);
    return res.status(200).json({
      polished: body.raw_answer || '',
      section_index: body.section_index,
      error: 'Polish failed, using raw text',
      mode: 'case_polish',
    });
  }
}

// ════════════════════════════════════════════════════════════
// ══ CASE SAVE MODE — store case data in Redis before Stripe payment
// ════════════════════════════════════════════════════════════

async function handleCaseSave(body, res) {
  try {
    const { template, answers, polished, session_id } = body;

    if (!template || !answers || !polished) {
      return res.status(400).json({ error: 'Missing required fields: template, answers, polished' });
    }

    // Generate a unique case ID
    const caseId = 'case_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    // Store in Redis with 24h TTL (enough time to complete payment)
    const caseData = {
      template,
      answers,
      polished,
      session_id: session_id || null,
      created_at: new Date().toISOString(),
    };

    await redis.set(`raise:case:${caseId}`, JSON.stringify(caseData), { ex: 60 * 60 * 24 });

    return res.status(200).json({
      case_id: caseId,
      mode: 'case_save',
    });

  } catch (err) {
    console.error('[case_save] error:', err);
    return res.status(500).json({ error: 'Failed to save case data' });
  }
}
