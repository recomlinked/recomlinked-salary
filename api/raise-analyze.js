// api/raise-analyze.js
// Salary Negotiation Coach — Initial probability range
// Called on chat page load with the assessment profile.
// Returns: initial range [floor, ceiling], color, context line, first coach message.
//
// The math is DETERMINISTIC in code (see spec § 2). Claude only writes the
// one-line context that accompanies the initial range — it never picks numbers.
//
// Cache key: raise:analyze|{country}|{situation}|{lastRaise}|{seniority}|{size}
// TTL: 7 days (same-profile users get the cached context line).

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

  // Annual-raise baseline overrides default baseline
  if (p.last_raise === 'annual_raise_want_more') {
    floor   = 35;
    ceiling = 55;
  }

  // Tier 1 ceiling caps (most restrictive wins)
  if (p.company_situation === 'cutting')  ceiling = Math.min(ceiling, 42);
  if (p.last_raise === 'under_1_year')    ceiling = Math.min(ceiling, 32);

  // Tier 1 floor lifts
  if (p.company_situation === 'growing')  floor = Math.max(floor, 45);
  if (p.last_raise === '2_plus_years')    floor = Math.min(floor + 10, ceiling - 5);

  // Seniority × company size modifiers
  const isSenior       = ['senior', 'lead'].includes(p.seniority);
  const isLargeCompany = ['1000_10000', '10000_plus'].includes(p.company_size);
  if (isSenior && isLargeCompany) floor = Math.min(floor + 3, ceiling - 5);
  if (p.seniority === 'junior' && p.company_size === 'under_50') {
    ceiling = Math.max(ceiling - 3, floor + 5);
  }

  // Country modifier — slight conservatism outside US
  if (p.country === 'ca') ceiling = Math.max(ceiling - 2, floor + 5);
  if (p.country === 'uk') ceiling = Math.max(ceiling - 3, floor + 5);
  // us, au, other: baseline

  // Clamp, ensure min 5pp width
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
  return `raise:analyze|${p.country}|${p.company_situation}|${p.last_raise}|${p.seniority}|${p.company_size}`;
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
const SYSTEM_PROMPT = `You are a salary negotiation coach. The user has just completed a 4-question assessment. Your ONLY job right now is to write a SINGLE short context line (max 18 words) that grounds the user in why their initial probability range is where it is.

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
function firstCoachMessage(floor, ceiling) {
  return `That's your starting range, ${floor}–${ceiling}%, based on the structural factors alone. Four quick questions will narrow it and show where your real leverage is.`;
}

// ── Main handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const {
    country,
    company_situation,
    last_raise,
    seniority,
    company_size,
    refSource,
  } = req.body || {};

  // Validation — all 5 fields required
  if (!country || !company_situation || !last_raise || !seniority || !company_size) {
    return res.status(400).json({ error: 'Missing required assessment fields' });
  }

  const profile = { country, company_situation, last_raise, seniority, company_size };

  // ── Deterministic math runs unconditionally ────────────
  const { floor, ceiling } = calculateInitialRange(profile);
  const color              = colorFromMidpoint(floor, ceiling);
  const dominant           = dominantFactorCode(profile);

  // ── Cache check for the Claude-generated context line ──
  const cacheKey = makeCacheKey(profile);
  let contextLine = null;
  try {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const cached = typeof raw === 'string' ? JSON.parse(raw) : raw;
      contextLine = cached.context_line || null;
    }
  } catch (e) { /* continue without cache */ }

  // ── If no cache, call Claude for the context line ─────
  if (!contextLine) {
    const userMessage = `User profile:
- Country: ${country}
- Company situation: ${company_situation}
- Last raise: ${last_raise}
- Seniority: ${seniority}
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

      // Cache the context line
      if (contextLine) {
        await redis.set(cacheKey, JSON.stringify({ context_line: contextLine }), { ex: CACHE_TTL_SECONDS })
          .catch(() => { /* non-fatal */ });
      }
    } catch (err) {
      console.error('[raise-analyze] claude error:', err.message);
      // Fallback: static line per dominant factor
      contextLine = fallbackContext(dominant);
    }
  }

  // ── Log (fire-and-forget) ──────────────────────────────
  logToSheet({
    country, company_situation, last_raise, seniority, company_size,
    floor, ceiling, color, dominant,
    refSource: refSource || '',
  });

  return res.status(200).json({
    floor,
    ceiling,
    color,                        // 'red' | 'amber' | 'green'
    context_line: contextLine,
    first_coach_message: firstCoachMessage(floor, ceiling),
    exchange_next: 1,             // Exchange 1 is role/industry
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
