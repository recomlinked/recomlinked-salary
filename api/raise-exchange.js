// api/raise-exchange.js
// Salary Negotiation Coach — Per-exchange range update
// Called after each of the 3 coaching exchanges + the final obstacle capture
// during free chat. Receives: current state + user's new answer.
// Returns: new range, movement reason line, extracted fields, next question
// (or is_final=true when exchange=3 so the frontend can show the obstacle
// question; obstacle submission uses exchange=4 and returns is_paywall=true).
//
// INPUT (re. the 3-question assessment reduction): `profile` from the chat page
// contains 3 real user-selected fields (company_situation, last_raise, company_size)
// plus 2 legacy default fields kept for chat-page profileHash compatibility
// (country:'us', seniority:'mid'). This file ignores the legacy defaults when
// building prompts so Claude doesn't treat them as real user answers.
// Ex1 now extracts seniority_signal_from_text from the user's role description,
// which downstream (raise-enrich.js) can use in place of the default.
//
// Claude's job: extract structured fields from free-text OR validate chip choice,
// classify the overall signal (strong_positive | positive | neutral | negative),
// and write the reason line. The range math itself runs DETERMINISTICALLY in code
// (see spec § 9 canonical rules).
//
// 3-exchange redesign notes:
//   Ex1 = role & industry (free text)              — unchanged
//   Ex2 = your case: performance + leverage merged  — NEW merged question
//         (was Ex2 perf + Ex3 market in the old 4-exchange version)
//   Ex3 = manager + prior_ask only (timing dropped, moved to obstacle chip)
//   Ex4 = OBSTACLE capture only — no range math, just classify the obstacle
//         for paywall copy composition. Coach line is the final line before
//         the paywall bubble renders.

const Anthropic = require('@anthropic-ai/sdk');
const { Redis }  = require('@upstash/redis');

const client = new Anthropic();
const redis  = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Target widths per exchange — 3-step tightening (was 4-step 25/19/13/5)
// Ex1: 25pp width (widest tightening)
// Ex2: 15pp width (merged perf + leverage, bigger signal, bigger shrink)
// Ex3: 5pp  width (final locked range)
const TARGET_WIDTH = { 1: 25, 2: 15, 3: 5 };

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

  let floorLift   = Math.round(shrinkBy * ratios[0]);
  let ceilingDrop = Math.round(shrinkBy * ratios[1]);

  // Also apply a small midpoint nudge for strong signals
  if (signal === 'strong_positive') { floorLift += 2; ceilingDrop -= 2; }
  if (signal === 'strong_negative') { floorLift -= 2; ceilingDrop += 2; }

  let newFloor   = floor + floorLift;
  let newCeiling = ceiling - ceilingDrop;

  // ── Canonical rule: floor NEVER drops below initial Tier 1 floor ──
  if (typeof initialFloor === 'number') newFloor = Math.max(newFloor, initialFloor);

  // Force exact target width, but only when the range is WIDER than target.
  // Never expand a range that's already narrower than the target width —
  // that would grow uncertainty when we should only reduce it.
  if (newCeiling - newFloor > targetWidth) {
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
- seniority_signal_from_text: one of [junior, mid, senior, lead, exec, unclear]
  (Infer from the title and any years/context mentioned. Examples: "Junior Analyst" → junior; "Senior PM, 8 years" → senior; "Director of Eng" → lead; "VP" or "Head of" → exec. Default to "unclear" if no signal.)

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
  "extracted": { "job_title_normalised": "...", "function": "...", "industry": "...", "company_type": "...", "seniority_signal_from_text": "..." },
  "signal": "strong_positive|positive|neutral|negative|strong_negative",
  "reason_line": "..."
}`;

// ── Exchange 2: MERGED performance + leverage ────────────
// The user's single answer tells us whichever axis matters most to them.
// Claude classifies the strongest signal they actually gave.
const EXCHANGE_2_SYSTEM = `You are a salary negotiation coach. The user has just told you about their case for a raise — either their recent performance, their market leverage, or both. This is the single "what's your ammunition?" question in the 3-exchange flow.

Fields to extract (any that apply — use "not_mentioned" if the user didn't touch that axis):
- performance_rating: one of [exceeded, specific_win, met, mixed, not_mentioned]
- external_leverage:  one of [competing_offer, actively_recruited, underpaid_evidence, none, not_mentioned]
- market_position:    one of [underpaid, at_market, overpaid, unsure, not_mentioned]
- specific_achievements: array of 0-3 short strings (only if they mentioned concrete wins)
- leverage_detail: string (if they typed specifics about offers or recruiter interest)

Signal classification — pick the STRONGEST axis they actually mentioned:
- strong_positive: competing_offer OR exceeded expectations
- positive: actively_recruited OR credible underpaid evidence OR specific performance win
- neutral: met expectations / at-market / unsure / nothing strongly stated
- negative: mixed performance year AND no external leverage
- strong_negative: poor performance AND explicitly negative leverage signals

If the user only addressed one axis (e.g. only performance), classify from that axis and set the other fields to "not_mentioned". Don't penalise them for not mentioning leverage — many people genuinely have no external leverage and that's fine.

Reason line (max 22 words):
- Reference whichever axis the user actually led with
- Reflect the "tightens but doesn't tank" rule — weak evidence reframes as "upside limited" or "paid plan shows how to build leverage", never "probability tanked"

Respond ONLY with valid JSON, no preamble:
{
  "extracted": {
    "performance_rating": "...",
    "external_leverage": "...",
    "market_position": "...",
    "specific_achievements": [...],
    "leverage_detail": "..."
  },
  "signal": "...",
  "reason_line": "..."
}`;

// ── Exchange 3: MANAGER relationship + prior_ask (timing removed) ────
// Timing moved to obstacle-question chip in the frontend. Ex3 stays focused
// on the relational axis which is a distinct signal from evidence.
const EXCHANGE_3_SYSTEM = `You are a salary negotiation coach. The user has just told you about their manager relationship and whether they've asked for a raise before. This is the FINAL exchange before the obstacle capture.

Fields to extract:
- manager_relationship: one of [strong, professional, complicated, never_asked]
- prior_ask: one of [not_mentioned, never_asked, asked_got_yes, asked_got_no, asked_got_partial]
  (A prior "no" is a strong coaching signal — the plan has to handle re-opening the conversation.
   "asked_got_partial" = asked and got something smaller than requested.
   Default to "not_mentioned" if the user didn't touch the topic.)
- context_detail: string (e.g., "manager was just replaced", "I'm on a PIP", "asked last year and was told budget was frozen")

Signal classification — relationship × prior_ask matrix:
- strong_positive: strong + (asked_got_yes OR never_asked/not_mentioned)
- positive:        professional + (asked_got_yes OR never_asked) OR strong + asked_got_partial
- neutral:         professional + (never_asked OR not_mentioned) OR strong + asked_got_no
- negative:        complicated + any OR professional + asked_got_no OR any + asked_got_partial
- strong_negative: complicated + asked_got_no

Reason line (max 22 words):
- Must reference the manager relationship specifically
- If prior_ask is asked_got_no, acknowledge the past rejection directly but frame as addressable with the right approach
- This is the last reason line before the obstacle question — should feel like we're zeroing in

Respond ONLY with valid JSON, no preamble:
{
  "extracted": { "manager_relationship": "...", "prior_ask": "...", "context_detail": "..." },
  "signal": "...",
  "reason_line": "..."
}`;

// ── Exchange 4: OBSTACLE capture (no range math) ─────────
// The user has already seen their final range card. They've just told us
// the one thing they're most worried about. We classify it into a canonical
// obstacle code for paywall copy keying, and write the final coach line
// that bridges directly into the paywall bubble.
const EXCHANGE_4_SYSTEM = `You are a salary negotiation coach. The user has seen their final probability range and you've just asked: "Before I map out your plan, what's the one thing you're most worried about?"

They may have tapped a canonical chip OR typed free text. Your job is to classify their worry into one of six canonical obstacle codes AND write a short, empathetic coach line that acknowledges their specific worry and bridges into the paywall that follows.

Canonical obstacle codes:
- budget         : manager will cite budget constraints / no money / "bad year"
- justify        : unsure how to justify the number / feels underqualified / imposter vibes
- timing         : no review scheduled / just happened / feels like the wrong moment
- prior_no       : asked before and got a no or a delay
- unknown_amount : doesn't know what specific number to ask for
- other          : something meaningfully different from the five above

If the user TYPED free text, classify to the CLOSEST canonical code (don't default to "other" unless genuinely none of the five fit). Preserve their exact phrasing in user_phrase_echo for the paywall to reference.

Coach line (max 30 words):
- Must acknowledge their SPECIFIC worry (reference the obstacle)
- Must hint that the paid plan addresses exactly this thing
- Must NOT say "upgrade" or "pay" or "unlock" — the paywall bubble handles that
- Must feel like a natural next sentence from a coach, not a sales line
- Ends with something that leads smoothly into the paywall

Example coach lines:
- budget:         "That 'no budget' line is the single most common deflection, and it almost always means 'I need ammunition to take upstairs', not 'no'. We can fix that."
- justify:        "Justifying the number is the easiest part once you see the framing. Most people over-complicate it. There are three moves that do the work for you."
- timing:         "Timing feels like a constraint but it's usually a variable you can move. There are specific windows that work even when nothing's scheduled."
- prior_no:       "A prior no is not the end of the conversation, it's information. Reopening it correctly is a skill, and it's teachable."
- unknown_amount: "Not knowing the number is the most solvable blocker on this list. There's a specific formula for your situation that gets you to a defensible ask."
- other:          (improvise, same structure, same tone)

Respond ONLY with valid JSON, no preamble:
{
  "obstacle_code": "budget|justify|timing|prior_no|unknown_amount|other",
  "user_phrase_echo": "<their exact words if free text, else empty string>",
  "coach_line": "<1-2 sentences, max 30 words>"
}`;

// ── Next-question payloads ──────────────────────────────
// Ex1 → Ex2, Ex2 → Ex3. After Ex3, frontend renders obstacle question locally.
// After Ex4 (obstacle), frontend renders paywall.
const NEXT_QUESTIONS = {
  1: {
    question: "What's the strongest evidence in your corner right now? Recent wins, market offers, or a sense you're underpaid — whatever's most true.",
    chips: [
      { value: 'exceeded',           label: 'I exceeded expectations / had a strong win' },
      { value: 'competing_offer',    label: 'I have a competing offer' },
      { value: 'actively_recruited', label: "I'm being actively recruited" },
      { value: 'underpaid',          label: "I know I'm underpaid for my role" },
      { value: 'met_but_overdue',    label: "I met expectations and it's been a while" },
      { value: 'no_strong_evidence', label: "I don't have strong evidence right now" },
    ],
    allows_free_text: true,
  },
  2: {
    question: "Last question before I lock in your range. How's your relationship with whoever decides your salary, and have you asked for a raise before (if so, how did it go)?",
    chips_row_1: [
      { value: 'strong',       label: 'Strong — they advocate for me' },
      { value: 'professional', label: 'Professional but not close' },
      { value: 'complicated',  label: "It's complicated" },
      { value: 'never_asked',  label: "I haven't asked before" },
    ],
    allows_free_text: true,
    free_text_hint: 'If you asked before, tell me what happened — that changes the playbook.',
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
  if (exchange === 4) {
    // Obstacle fallback — generic acknowledgement that won't break the paywall
    return {
      obstacle_code: 'other',
      user_phrase_echo: typeof answer === 'string' ? String(answer).slice(0, 200) : '',
      coach_line: "That's a real concern, and the coaching plan has a specific answer for it.",
    };
  }
  // Used if Claude call fails for Ex1-3 — keeps the UX alive
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
    exchange,              // 1 | 2 | 3 (range tightening) | 4 (obstacle capture)
    answer,                // free-text answer OR chip value OR {relationship, free_text} for ex3 OR {obstacle_code, label, free_text} for ex4
    profile,               // chat-page profile: 3 real fields + 2 legacy defaults
    current_range,         // { floor, ceiling }
    initial_floor,         // from analyze response — used to enforce canonical floor rule
    accumulated_exchanges, // previous exchanges' extracted data (for context only)
  } = req.body || {};

  // Validation
  if (!exchange || exchange < 1 || exchange > 4) {
    return res.status(400).json({ error: 'Invalid exchange number' });
  }
  if (!profile) {
    return res.status(400).json({ error: 'Missing profile' });
  }
  // Ex4 (obstacle) doesn't need current_range for math, but we still want it
  // for context. Ex1-3 require it.
  if (exchange <= 3 && !current_range) {
    return res.status(400).json({ error: 'Missing current_range' });
  }
  if (answer == null || answer === '') {
    return res.status(400).json({ error: 'Answer required' });
  }

  // Strip legacy default fields (country, seniority) before exposing the
  // profile to Claude — those are defaults carried in localStorage for the
  // chat page's profileHash, not real user answers.
  const cleanProfile = {
    company_situation: profile.company_situation,
    last_raise:        profile.last_raise,
    company_size:      profile.company_size,
  };

  // ── Build user message for Claude ──────────────────────
  let userMessage;
  if (exchange === 3) {
    // Ex3: manager-only, optional free text
    const rel  = typeof answer === 'object' ? (answer.relationship || '') : '';
    const free = typeof answer === 'object' ? (answer.free_text || '') : (typeof answer === 'string' ? answer : '');
    userMessage = `User's relationship chip: ${rel || '(not selected)'}
User's free text: ${free || '(none)'}
Prior accumulated profile: ${JSON.stringify(accumulated_exchanges || {})}
Assessment: ${JSON.stringify(cleanProfile)}`;
  } else if (exchange === 4) {
    // Ex4: obstacle capture. Answer is { obstacle_code, label, free_text? }
    // for chip selection, OR { free_text } for typed input.
    const chipCode  = typeof answer === 'object' ? (answer.obstacle_code || '') : '';
    const chipLabel = typeof answer === 'object' ? (answer.label || '') : '';
    const free      = typeof answer === 'object' ? (answer.free_text || '') : (typeof answer === 'string' ? answer : '');
    userMessage = `User's obstacle chip (if any): ${chipCode || '(free text only)'}
Chip label (if any): ${chipLabel || '(none)'}
User's free text (if any): ${free || '(none)'}
Final range: ${current_range ? `${current_range.floor}-${current_range.ceiling}%` : 'unknown'}
Accumulated exchanges so far: ${JSON.stringify(accumulated_exchanges || {})}`;
  } else {
    userMessage = `User answer: ${typeof answer === 'string' ? answer : JSON.stringify(answer)}
Prior accumulated profile: ${JSON.stringify(accumulated_exchanges || {})}
Assessment: ${JSON.stringify(cleanProfile)}`;
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

  // ── Ex4 obstacle branch: no range math, return obstacle payload ───
  if (exchange === 4) {
    logToSheet({
      exchange: 4,
      obstacle: claudeResult.obstacle_code || 'other',
      user_phrase: (claudeResult.user_phrase_echo || '').slice(0, 200),
    });

    return res.status(200).json({
      is_obstacle:       true,
      is_paywall:        true,
      obstacle_code:     claudeResult.obstacle_code    || 'other',
      user_phrase_echo:  claudeResult.user_phrase_echo || '',
      coach_line:        claudeResult.coach_line       || "Let's get you a plan.",
      // Range unchanged — frontend already has it from Ex3
      floor:   current_range ? current_range.floor   : null,
      ceiling: current_range ? current_range.ceiling : null,
    });
  }

  // ── Ex1-3: apply deterministic range update ────────────
  const targetWidth = TARGET_WIDTH[exchange];
  const newRange    = updateRange(
    current_range,
    targetWidth,
    claudeResult.signal || 'neutral',
    initial_floor,
  );
  const color       = colorFromMidpoint(newRange.floor, newRange.ceiling);

  // Next question (null if this was ex3 — frontend shows obstacle question)
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
    floor:         newRange.floor,
    ceiling:       newRange.ceiling,
    color,
    reason_line:   claudeResult.reason_line || 'Your range is tightening as we learn more.',
    extracted:     claudeResult.extracted   || {},
    signal:        claudeResult.signal      || 'neutral',
    next_question: next,                // null if exchange===3 → client shows obstacle question
    is_final:      exchange === 3,      // true after ex3 → render final range card + obstacle question
    is_obstacle:   false,
    is_paywall:    false,
  });
};
