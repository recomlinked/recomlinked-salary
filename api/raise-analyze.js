// api/raise-analyze.js
// Salary Negotiation Coach — Initial probability range
// Called on chat page load with the assessment profile.
// Returns: initial range [floor, ceiling], color, context line, first coach message.
//
// INPUT: 3-field assessment → { company_situation, last_raise, company_size }.
// Previously required 5 fields (incl. country + seniority). The landing page
// reduced its assessment from 4 questions to 3 to optimise funnel velocity.
// The chat page's Ex1 free-text extraction refines seniority from the user's
// typed job title; regional nuance is now handled at the coach-prompt layer
// rather than in the initial range math.
// (Note: frontend localStorage still stores country:'us' / seniority:'mid'
// defaults to keep profileHash on the chat page backwards-compatible —
// those fields are ignored here but not harmful if present in the payload.)
//
// The math is DETERMINISTIC in code (see spec § 2). Claude only writes the
// one-line context that accompanies the initial range — it never picks numbers.
//
// Cache key: raise:analyze|{situation}|{lastRaise}|{size}
// TTL: 7 days (same-profile users get the cached context line).
//
// ── Round 2 update ───────────────────────────────────────
// firstCoachMessage now references 3 exchanges, not 4 (matches the 3-exchange
// chat flow). The chat page also overrides this locally for redundancy.

const Anthropic = require('@anthropic-ai/sdk');
const { Redis }  = require('@upstash/redis');

const client = new Anthropic();
const redis  = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

// ── Deterministic initial range ───────────────────────────
// Values from salary-negotiation-coach-spec.md § 2
function calculateInitialRange(p) {
  let floor   = 40;
  let ceiling = 70;

  if (p.last_raise === 'annual_raise_want_more') {
    floor   = 35;
    ceiling = 55;
  }

  if (p.company_situation === 'cutting')  ceiling = Math.min(ceiling, 42);
  if (p.last_raise === 'under_1_year')    ceiling = Math.min(ceiling, 32);

  if (p.company_situation === 'growing')  floor = Math.max(floor, 45);
  if (p.last_raise === '2_plus_years')    floor = Math.min(floor + 10, ceiling - 5);

  floor   = Math.max(10, Math.round(floor));
  ceiling = Math.min(90, Math.round(ceiling));
  if (ceiling - floor < 5) ceiling = floor + 5;

  return { floor, ceiling };
}

function colorFromMidpoint(floor, ceiling) {
  const mid = (floor + ceiling) / 2;
  if (mid < 40) return 'red';
  if (mid < 60) return 'amber';
  return 'green';
}

function dominantFactorCode(p) {
  if (p.company_situation === 'cutting' && p.last_raise === 'under_1_year') return 'cutting_new';
  if (p.last_raise === 'under_1_year')                                      return 'new_employee';
  if (p.company_situation === 'cutting')                                    return 'cutting';
  if (p.company_situation === 'growing' && p.last_raise === '2_plus_years') return 'growing_overdue';
  if (p.last_raise === '2_plus_years')                                      return 'overdue';
  if (p.company_situation === 'growing')                                    return 'growing';
  if (p.last_raise === 'annual_raise_want_more')                            return 'above_annual';
  if (p.last_raise === 'never_asked')                                       return 'never_asked';
  return 'stable';
}

function makeCacheKey(p) {
  return `raise:analyze|${p.company_situation}|${p.last_raise}|${p.company_size}`;
}

async function logToSheet(payload) {
  try {
    const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
    if (!webhookUrl) return;
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        timestamp: new Date().toISOString(),
        event:     'RAISE_ANALYZE',
        product:   'raise',
        source:    'salary.recomlinked.com',
        ...payload,
      }),
    });
  } catch (e) { /* non-fatal */ }
}

// ── System prompt — Claude writes ONLY the context line ───
const SYSTEM_PROMPT = `You are a salary negotiation coach. The user has just completed a 3-question assessment (company situation, last raise, company size). Your ONLY job right now is to write a SINGLE short context line (max 18 words) that grounds the user in why their initial probability range is where it is.

Style:
- Direct, warm, no hype.
- Reference the DOMINANT factor (the thing driving their range most).
- No promises. No numbers. No exclamation marks.
- Do not say "probability" or "range" — the UI already shows those.

Respond ONLY with valid JSON, no preamble:
{
  "context_line": "<one line, max 18 words>"
}`;

// ── First coach message template ──────────────────────────
// Round 2: reference THREE questions, not four (matches new 3-exchange flow).
function firstCoachMessage(floor, ceiling) {
  return `That's your starting range, ${floor}–${ceiling}%, based on the structural factors alone. Three quick questions will narrow it and show where your real leverage is.`;
}

// ── Main handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const {
    company_situation,
    last_raise,
    company_size,
    refSource,
    reason,
  } = req.body || {};

  if (!company_situation || !last_raise || !company_size) {
    return res.status(400).json({ error: 'Missing required assessment fields' });
  }

  const profile = { company_situation, last_raise, company_size };

  const { floor, ceiling } = calculateInitialRange(profile);
  const color              = colorFromMidpoint(floor, ceiling);
  const dominant           = dominantFactorCode(profile);

  // Cache check for the Claude-generated context line
  const cacheKey = makeCacheKey(profile);
  let contextLine = null;
  try {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const cached = typeof raw === 'string' ? JSON.parse(raw) : raw;
      contextLine = cached.context_line || null;
    }
  } catch (e) { /* continue without cache */ }

  if (!contextLine) {
    const userMessage = `User profile:
- Company situation: ${company_situation}
- Last raise: ${last_raise}
- Company size: ${company_size}
- Dominant factor: ${dominant}
- Computed range: ${floor}-${ceiling}%

Write the context line.`;

    try {
      const response = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 120,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userMessage }],
      });
      const raw     = response.content[0]?.text || '{}';
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed  = JSON.parse(cleaned);
      contextLine   = (parsed.context_line || '').trim();

      if (contextLine) {
        await redis.set(cacheKey, JSON.stringify({ context_line: contextLine }), { ex: CACHE_TTL_SECONDS })
          .catch(() => { /* non-fatal */ });
      }
    } catch (err) {
      console.error('[raise-analyze] claude error:', err.message);
      contextLine = fallbackContext(dominant);
    }
  }

  logToSheet({
    company_situation, last_raise, company_size,
    floor, ceiling, color, dominant,
    refSource: refSource || '',
    reason:    reason    || '',
  });

  return res.status(200).json({
    floor,
    ceiling,
    color,
    context_line: contextLine,
    first_coach_message: firstCoachMessage(floor, ceiling),
    exchange_next: 1,
  });
};

// ── Fallback context lines if Claude fails ────────────────
function fallbackContext(code) {
  const map = {
    cutting_new:      'New tenure plus company cuts is the toughest combination to negotiate through.',
    new_employee:     'Being under a year at the company is the biggest factor working against you right now.',
    cutting:          'Company-wide cuts significantly limit raise availability, though not impossible.',
    growing_overdue:  'A growing company and a long wait between raises is a strong combination in your favour.',
    overdue:          'Extended tenure without a raise meaningfully strengthens your case.',
    growing:          'Your company\'s growth phase gives you a solid foundation to negotiate from.',
    above_annual:     'Negotiating above a standard annual raise requires clear evidence and market leverage.',
    never_asked:      'Never having asked before is an untapped lever in your favour.',
    stable:           'Your structural situation is neutral — the case you build will drive the outcome.',
  };
  return map[code] || map.stable;
}
