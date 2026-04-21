// api/raise-exchange.js
// Salary Negotiation Coach — Per-exchange range update
// Called after each of the 4 coaching exchanges during free chat.
// Receives: current state + user's new answer.
// Returns: new range, movement reason line, extracted fields, next question (or null if ex4).
//
// Claude's job: extract structured fields from free-text OR validate chip choice,
// classify the overall signal (strong_positive | positive | neutral | negative),
// and write the reason line. The range math itself runs DETERMINISTICALLY in code
// (see spec § 9 canonical rules).

const Anthropic = require('@anthropic-ai/sdk');
const { Redis }  = require('@upstash/redis');

const client = new Anthropic();
const redis  = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Target widths per exchange (tightens steadily toward 5pp at ex4)
const TARGET_WIDTH = { 1: 25, 2: 19, 3: 13, 4: 5 };

// ── Range math — spec § 9 "tightens but doesn't tank" ─────
// Signal: 'strong_positive' | 'positive' | 'neutral' | 'negative' | 'strong_negative'
function updateRange(current, targetWidth, signal, initialFloor) {
  let { floor, ceiling } = current;
  const currentWidth = ceiling - floor;
  const shrinkBy     = Math.max(0, currentWidth - targetWidth);

  // Shrink depends on signal direction
  // strong_positive: floor lifts by ~75% of shrink, ceiling drops by ~25%
  // positive:        floor lifts by ~60%,           ceiling drops by ~40%
  // neutral:         symmetric shrink
  // negative:        floor lifts by ~30%,           ceiling drops by ~70%
  // strong_negative: floor lifts by ~15%,           ceiling drops by ~85%
  const ratios = {
    strong_positive: [0.75, 0.25],
    positive:        [0.60, 0.40],
    neutral:         [0.50, 0.50],
    negative:        [0.30, 0.70],
    strong_negative: [0.15, 0.85],
  }[signal] || [0.50, 0.50];

  let floorLift  = Math.round(shrinkBy * ratios[0]);
  let ceilingDrop= Math.round(shrinkBy * ratios[1]);

  // Also apply a small midpoint nudge for strong signals
  if (signal === 'strong_positive') { floorLift += 2; ceilingDrop -= 2; }
  if (signal === 'strong_negative') { floorLift -= 2; ceilingDrop += 2; }

  let newFloor   = floor + floorLift;
  let newCeiling = ceiling - ceilingDrop;

  // ── Canonical rule: floor NEVER drops below initial Tier 1 floor ──
  if (typeof initialFloor === 'number') newFloor = Math.max(newFloor, initialFloor);

  // Force exact target width (to ensure clean 5pp final range)
  if (newCeiling - newFloor !== targetWidth) {
    // Center adjustment around current midpoint
    const midTarget = Math.round((newFloor + newCeiling) / 2);
    newFloor   = midTarget - Math.floor(targetWidth / 2);
    newCeiling = newFloor + targetWidth;
    if (typeof initialFloor === 'number' && newFloor < initialFloor) {
      newFloor   = initialFloor;
      newCeiling = newFloor + targetWidth;
    }
  }

  // Clamp
  newFloor   = Math.max(10, Math.min(85, newFloor));
  newCeiling = Math.min(92, Math.max(newFloor + targetWidth, newCeiling));

  return { floor: newFloor, ceiling: newCeiling };
}

function colorFromMidpoint(floor, ceiling) {
  const mid = (floor + ceiling) / 2;
  if (mid < 40) return 'red';
  if (mid < 60) return 'amber';
  return 'green';
}

// ── System prompts per exchange ───────────────────────────
// Each prompt constrains Claude to: (a) extract specific fields,
// (b) classify the signal, (c) write the reason line.

const EXCHANGE_1_SYSTEM = `You are a salary negotiation coach. The user has just told you their job title and company/industry in free text.

Your job: extract structured fields and classify how their field/industry shapes their raise probability RIGHT NOW in the market (spring 2026).

Fields to extract:
- job_title_normalised: short clean title
- function: one of [finance, product, engineering, sales, marketing, ops, hr, design, cs, legal, data, other]
- industry: one of [saas, fintech, healthcare, retail, manufacturing, media, consulting, government, nonprofit, energy, education, other]
- company_type: one of [startup, scaleup, public, private_mid, government, nonprofit, unknown]

Signal classification (how their field affects raise probability):
- strong_positive: hot market, tight talent supply, high retention pressure
- positive: above-average conditions
- neutral: stable market
- negative: below-average conditions, cost pressure in the sector
- strong_negative: major layoffs or budget freezes common in this field

Reason line (max 20 words):
- Must reference their specific field/industry
- Must reflect their signal direction
- Must sound like a working coach, not a static article

Respond ONLY with valid JSON, no preamble:
{
  "extracted": { "job_title_normalised": "...", "function": "...", "industry": "...", "company_type": "..." },
  "signal": "strong_positive|positive|neutral|negative|strong_negative",
  "reason_line": "..."
}`;

const EXCHANGE_2_SYSTEM = `You are a salary negotiation coach. The user has just told you about their last 12 months of performance.

Fields to extract:
- performance_rating: one of [exceeded, specific_win, met, mixed]
- specific_achievements: array of 0-3 short strings (only if they mentioned concrete wins)

Signal classification:
- strong_positive: exceeded expectations
- positive: strong specific win
- neutral: met expectations
- negative: mixed year

Reason line (max 20 words):
- Reference their rating specifically
- Reflect the "tightens but doesn't tank" rule — weak performance reframes as "upside limited", never "probability tanked"

Respond ONLY with valid JSON, no preamble:
{
  "extracted": { "performance_rating": "...", "specific_achievements": [...] },
  "signal": "...",
  "reason_line": "..."
}`;

const EXCHANGE_3_SYSTEM = `You are a salary negotiation coach. The user has just told you about their market position and external leverage.

Fields to extract:
- market_position: one of [underpaid, at_market, overpaid, unsure]
- external_leverage: one of [competing_offer, actively_recruited, underpaid_evidence, none]
- leverage_detail: string (if they typed specifics)

Signal classification:
- strong_positive: competing_offer
- positive: actively_recruited OR credible underpaid evidence
- neutral: at-market, unsure
- negative: none / no external leverage

Reason line (max 20 words):
- Must reference leverage specifically
- If no external leverage: frame as "paid plan shows how to build it fast" — never tank the number

Respond ONLY with valid JSON, no preamble:
{
  "extracted": { "market_position": "...", "external_leverage": "...", "leverage_detail": "..." },
  "signal": "...",
  "reason_line": "..."
}`;

const EXCHANGE_4_SYSTEM = `You are a salary negotiation coach. The user has just told you about their manager relationship AND review cycle timing. This is the FINAL exchange before the paywall.

Fields to extract:
- manager_relationship: one of [strong, professional, complicated, never_asked]
- review_timing: one of [imminent, soon, distant, none, just_happened]
- context_detail: string (e.g., "manager was just replaced", "I'm on a PIP")

Signal classification uses the combinatorial matrix:
- strong_positive: strong + imminent/soon
- positive: strong + distant OR never_asked + soon
- neutral: professional + any OR strong + no_cycle
- negative: complicated + any OR any + just_happened
- strong_negative: complicated + just_happened

Reason line (max 22 words):
- Must reference BOTH relationship AND timing
- This is the final reason before paywall — should feel conclusive

Respond ONLY with valid JSON, no preamble:
{
  "extracted": { "manager_relationship": "...", "review_timing": "...", "context_detail": "..." },
  "signal": "...",
  "reason_line": "..."
}`;

const NEXT_QUESTIONS = {
  1: {
    question: "How would you describe your performance over the last 12 months?",
    chips: [
      { value: 'exceeded',     label: 'Exceeded expectations' },
      { value: 'specific_win', label: 'Had a strong specific win' },
      { value: 'met',          label: 'Met expectations' },
      { value: 'mixed',        label: "It's been a mixed year" },
    ],
    allows_free_text: true,
  },
  2: {
    question: "Do you have a sense of how your salary compares to market rate — and has anyone approached you about other opportunities recently?",
    chips: [
      { value: 'underpaid',          label: "I know I'm underpaid for my role" },
      { value: 'competing_offer',    label: 'I have a competing offer' },
      { value: 'actively_recruited', label: "I'm being actively recruited" },
      { value: 'none',               label: 'No external leverage right now' },
    ],
    allows_free_text: true,
  },
  3: {
    question: "Last one. How's your relationship with whoever decides your salary, and when's your next review or raise cycle?",
    chips_row_1: [
      { value: 'strong',       label: 'Strong — they advocate for me' },
      { value: 'professional', label: 'Professional but not close' },
      { value: 'complicated',  label: "It's complicated" },
      { value: 'never_asked',  label: "I haven't asked before" },
    ],
    chips_row_2: [
      { value: 'imminent',     label: 'Review in the next month' },
      { value: 'soon',         label: 'Review in 1–3 months' },
      { value: 'distant',      label: 'Review in 3–6 months' },
      { value: 'none',         label: 'No set review cycle' },
      { value: 'just_happened',label: 'Review just happened' },
    ],
    allows_free_text: true,
  },
};

function systemForExchange(n) {
  if (n === 1) return EXCHANGE_1_SYSTEM;
  if (n === 2) return EXCHANGE_2_SYSTEM;
  if (n === 3) return EXCHANGE_3_SYSTEM;
  if (n === 4) return EXCHANGE_4_SYSTEM;
  return null;
}

function fallbackResult(exchange, answer) {
  // Used if Claude call fails — keeps the UX alive
  return {
    extracted: {},
    signal: 'neutral',
    reason_line: 'Your range is tightening as we learn more about your situation.',
  };
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
        event:     'RAISE_EXCHANGE',
        product:   'raise',
        ...payload,
      }),
    });
  } catch (e) { /* non-fatal */ }
}

// ── Main handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const {
    exchange,              // 1 | 2 | 3 | 4
    answer,                // free-text answer OR a single chip value OR {row1, row2} for ex4
    profile,               // assessment profile (country, company_situation, last_raise, seniority, company_size)
    current_range,         // { floor, ceiling }
    initial_floor,         // from analyze response — used to enforce canonical floor rule
    accumulated_exchanges, // previous exchanges' extracted data (for context only)
  } = req.body || {};

  // Validation
  if (!exchange || exchange < 1 || exchange > 4) {
    return res.status(400).json({ error: 'Invalid exchange number' });
  }
  if (!profile || !current_range) {
    return res.status(400).json({ error: 'Missing profile or current_range' });
  }
  if (answer == null || answer === '') {
    return res.status(400).json({ error: 'Answer required' });
  }

  // ── Build user message for Claude ──────────────────────
  let userMessage;
  if (exchange === 4) {
    // Answer is either a structured object or string
    const a1 = typeof answer === 'object' ? answer.relationship : '';
    const a2 = typeof answer === 'object' ? answer.timing       : '';
    const free = typeof answer === 'object' ? (answer.free_text || '') : (typeof answer === 'string' ? answer : '');
    userMessage = `User's relationship chip: ${a1 || '(not selected)'}
User's timing chip: ${a2 || '(not selected)'}
User's free text: ${free || '(none)'}
Prior accumulated profile: ${JSON.stringify(accumulated_exchanges || {})}`;
  } else {
    userMessage = `User answer: ${typeof answer === 'string' ? answer : JSON.stringify(answer)}
Prior accumulated profile: ${JSON.stringify(accumulated_exchanges || {})}
Assessment: ${JSON.stringify(profile)}`;
  }

  // ── Call Claude ────────────────────────────────────────
  let claudeResult;
  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      system:     systemForExchange(exchange),
      messages:   [{ role: 'user', content: userMessage }],
    });
    const raw     = response.content[0]?.text || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    claudeResult  = JSON.parse(cleaned);
  } catch (err) {
    console.error('[raise-exchange] claude error:', err.message);
    claudeResult = fallbackResult(exchange, answer);
  }

  // ── Apply deterministic range update ───────────────────
  const targetWidth = TARGET_WIDTH[exchange];
  const newRange    = updateRange(
    current_range,
    targetWidth,
    claudeResult.signal || 'neutral',
    initial_floor,
  );
  const color       = colorFromMidpoint(newRange.floor, newRange.ceiling);

  // ── Next question (null if this was ex4) ───────────────
  const next = NEXT_QUESTIONS[exchange] || null;

  // ── Fire-and-forget logging ────────────────────────────
  logToSheet({
    exchange,
    signal:     claudeResult.signal,
    new_floor:  newRange.floor,
    new_ceil:   newRange.ceiling,
    extracted:  JSON.stringify(claudeResult.extracted || {}).slice(0, 400),
  });

  return res.status(200).json({
    floor:       newRange.floor,
    ceiling:     newRange.ceiling,
    color,
    reason_line: claudeResult.reason_line || 'Your range is tightening as we learn more.',
    extracted:   claudeResult.extracted   || {},
    signal:      claudeResult.signal      || 'neutral',
    next_question: next,                // null if ex4 → client shows paywall
    is_final:    exchange === 4,
  });
};
