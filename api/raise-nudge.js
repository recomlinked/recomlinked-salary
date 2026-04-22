// api/raise-nudge.js
// Salary Negotiation Coach — Dynamic clarification nudges
// Called when the user's free-text answer during Ex1/Ex2/Ex3 is too short or
// generic to work with. Returns a single coach-voice sentence that asks for
// more specifically, adapting tone based on how many times they've under-answered.
//
// Uses claude-haiku-4-5 (cheap, fast). Nudges are short in + short out, no need
// for Sonnet-tier reasoning. Rate-limited per session to prevent abuse.
//
// ── Cost profile ─────────────────────────────────────────
// Per nudge: ~200 tokens in, ~40 tokens out on Haiku ≈ $0.0003
// Hard cap per session: 20 nudges → worst-case $0.006/session (bot hammering)
// Normal flow: 0-3 nudges across 3 exchanges → $0.001 or less
//
// ── Input ────────────────────────────────────────────────
// {
//   exchange:        1 | 2 | 3,
//   question:        string — the coach's question that was asked
//   user_answer:     string — what they typed (too short/generic)
//   prior_attempts:  number — how many times they've under-answered in a row
//   session_id:      string — profileHash from the frontend, used for rate limit
// }
//
// ── Output ───────────────────────────────────────────────
// { nudge: "short coach-voice line asking for more specifically" }
//
// Or on rate-limit: { nudge: "<canonical fallback>", rate_limited: true }

const Anthropic = require('@anthropic-ai/sdk');
const { Redis }  = require('@upstash/redis');

const client = new Anthropic();
const redis  = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const RATE_LIMIT_MAX = 20;                  // max nudge calls per session
const RATE_LIMIT_TTL = 15 * 60;             // 15 minutes
const MODEL_ID       = 'claude-haiku-4-5-20251001';
const MAX_TOKENS_OUT = 80;                  // one short sentence, that's it

// ── Fallback nudges if the model fails or rate limit is hit ──
// Indexed by exchange + attempt number (0 = first time they've been nudged).
// These read as natural, not template-y, even without Claude.
const FALLBACK_NUDGES = {
  1: [
    "I need a bit more to work with. Your job title and the kind of company you're at — even a short phrase like 'Senior PM at a SaaS startup' works.",
    "Still too thin for me to tell the field. What's your actual role, and what does your company do?",
    "I genuinely can't help without this one. One sentence on your role and your company is enough.",
  ],
  2: [
    "Give me a sentence on your strongest card — a specific win, a market offer, a sense you're underpaid. Whatever's most true.",
    "I can work with rough, but I need something concrete. What's the best piece of evidence in your corner?",
    "This is the one that sets your ceiling. One real answer — any of the chips above, or a sentence of your own.",
  ],
  3: [
    "Pick one above, or tell me in a sentence — does your manager go to bat for you, or is it more distant?",
    "The relationship piece changes the whole playbook. A chip or a sentence, either works.",
    "This last one matters a lot. Tap a chip or type one line about your manager.",
  ],
};

function pickFallback(exchange, priorAttempts) {
  const arr = FALLBACK_NUDGES[exchange] || FALLBACK_NUDGES[1];
  const idx = Math.min(priorAttempts || 0, arr.length - 1);
  return arr[idx];
}

// System prompt — trains Claude to write ONE short coach-voice nudge.
// No fluff, no preamble, just the nudge. Tone shifts with attempt count.
const NUDGE_SYSTEM = `You are a salary negotiation coach chatting with a user who just gave you an answer that's too short, too vague, or off-topic. Write ONE nudge sentence asking them to clarify.

RULES:
- ONE sentence. Max 28 words.
- Coach's voice — direct, warm, human. Never scripted.
- Reference what they actually typed if it gives you something to work with. If they typed "hi" or similar filler, acknowledge it lightly and redirect.
- Progressive tone based on attempt number:
  • attempt 1: warm, light clarification — assume they just didn't see what you needed
  • attempt 2: slightly more specific, make the requested shape concrete
  • attempt 3+: direct, honest — "I genuinely can't help without this one. One sentence is enough."
- Don't quote their message back. Don't say "I see" or "I understand".
- Don't use em-dashes. Use commas or full stops.
- No question mark at the end unless it's a real question you need them to answer.
- Output ONLY the nudge line. No JSON, no quotes around it, no labels.`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const {
    exchange,        // 1 | 2 | 3
    question,        // the coach question that was asked
    user_answer,     // what the user typed
    prior_attempts,  // how many prior nudges in this exchange
    session_id,      // profileHash for rate limiting
  } = req.body || {};

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

  // ── Rate limit check ───────────────────────────────────
  if (session_id && typeof session_id === 'string' && session_id.length <= 64) {
    try {
      const key = `raise:nudge:rate:${session_id}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, RATE_LIMIT_TTL);
      }
      if (count > RATE_LIMIT_MAX) {
        // Return a fallback silently rather than erroring — better UX
        return res.status(200).json({
          nudge:        pickFallback(exchange, attempts),
          rate_limited: true,
        });
      }
    } catch (e) { /* non-fatal — proceed without rate limit */ }
  }

  const userMessage = `Exchange: ${exchange}
Coach question asked: ${question || '(not provided)'}
User's reply (too short or generic): ${JSON.stringify(user_answer)}
Prior nudges this exchange: ${attempts}

Write the nudge.`;

  try {
    const response = await client.messages.create({
      model:      MODEL_ID,
      max_tokens: MAX_TOKENS_OUT,
      system:     NUDGE_SYSTEM,
      messages:   [{ role: 'user', content: userMessage }],
    });
    const raw = (response.content[0]?.text || '').trim();
    // Strip surrounding quotes if the model added them despite instructions
    const cleaned = raw.replace(/^["']+|["']+$/g, '').trim();
    const nudge = cleaned || pickFallback(exchange, attempts);

    return res.status(200).json({ nudge });
  } catch (err) {
    console.error('[raise-nudge] claude error:', err.message);
    return res.status(200).json({
      nudge:    pickFallback(exchange, attempts),
      fallback: true,
    });
  }
};
