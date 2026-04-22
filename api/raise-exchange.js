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

FIRST — CHECK IF THE ANSWER HAS SIGNAL:
An answer is SUFFICIENT if it contains BOTH:
  (a) any recognisable job title, role, or function, including:
      - C-suite abbreviations: CEO, CFO, CTO, CHRO, CMO, COO, CIO, CRO, CPO, CISO, CDO, CCO, or any C-level
      - VP / SVP / EVP / Head of [anything]
      - Director / Manager / Lead / Principal / Staff
      - Common role abbreviations (accept the most natural reading, don't demand clarification):
        * PM (Product / Project / Program / Portfolio Manager)
        * FA (Financial Analyst)
        * BA (Business Analyst)
        * DA (Data Analyst)
        * SE / SWE / SDE (Software Engineer)
        * SRE (Site Reliability Engineer)
        * QA (Quality Assurance)
        * UX / UI (designer)
        * EM (Engineering Manager)
        * TPM (Technical Program Manager)
        * DevOps, MLE (ML Engineer), PMM (Product Marketing Manager)
        * CS (Customer Success), SDR / BDR / AE (sales roles)
      - Individual contributor titles: Engineer, Analyst, Accountant, Designer, Writer, Developer, Consultant, etc.
      - Any recognisable English-language job title
  (b) any recognisable industry or field:
      - Tech variants: SaaS, fintech, healthtech, edtech, biotech, e-commerce, proptech, insurtech
      - Traditional: retail, manufacturing, healthcare, finance, banking, insurance, legal, consulting, media, government, nonprofit, energy, real estate, logistics, hospitality, airline, telecom, automotive, pharma, agriculture, construction, education
      - General descriptors: "tech", "a startup", "a bank", "a hospital", "a law firm", "an agency"

Very short answers are fine if both pieces are present. Examples of SUFFICIENT answers:
  - "CTO in fintech", "CHRO at a retail chain", "CMO in SaaS", "CIO in banking"
  - "VP of engineering, healthtech", "Head of Ops, manufacturing"
  - "PM, SaaS" → sufficient (Product/Project Manager, SaaS industry)
  - "FA in banking" → sufficient (Financial Analyst, banking)
  - "BA, consulting firm" → sufficient
  - "SWE at a startup" → sufficient
  - "TPM, fintech" → sufficient
  - "UX designer at an agency" → sufficient
  - "accountant at a retail chain" → sufficient

When a role abbreviation is ambiguous (e.g. PM could be Product/Project/Program Manager), DO NOT ask the user to clarify — pick the most common reading for their industry (e.g. SaaS PM → Product Manager) and proceed. The range math is the same regardless.

Classify the signal as "insufficient" ONLY when the answer fails to provide both role AND industry. Examples of INSUFFICIENT:
  - "hi", "hello", "test", "asdf", "no", "nothing"
  - Single field only: "CTO" alone (no industry), "fintech" alone (no role)
  - Off-topic: "I don't trust my boss", "fuck you"

If the user provided role + industry across MULTIPLE messages in a short conversation (e.g. first message "CTO", later "fintech"), and their current message completes the picture, that is sufficient. Don't re-ask for what's already been provided. Don't invent requirements like company_size or company_name — those aren't asked for.

Fields to extract (only if signal is NOT insufficient):
- job_title_normalised: short clean title
- function: one of [finance, product, engineering, sales, marketing, ops, hr, design, cs, legal, data, other]
- industry: one of [saas, fintech, healthcare, retail, manufacturing, media, consulting, government, nonprofit, energy, education, other]
- company_type: one of [startup, scaleup, public, private_mid, government, nonprofit, unknown] — default "unknown" if not clearly stated, DO NOT mark insufficient just because this is unknown
- seniority_signal_from_text: one of [junior, mid, senior, lead, exec, unclear]
  (Infer from the title:
   - "junior" → junior
   - "Senior [X]" → senior
   - "Director / Head of / Principal / Staff" → lead
   - Any C-suite (CEO, CFO, CTO, CHRO, CMO, COO, CIO, CRO, CPO, CISO, CDO, CCO, or any other C-level) → exec
   - "VP / SVP / EVP / Chief [anything]" → exec
   - Default "unclear" if title isn't clear)

Signal classification (how their field affects raise probability):
- insufficient: missing role OR industry (see above)
- strong_positive: hot market, tight talent supply, high retention pressure (e.g. fintech CTO, AI/ML roles)
- positive: above-average conditions
- neutral: stable market
- negative: below-average conditions, cost pressure in the sector
- strong_negative: major layoffs or budget freezes common in this field

Reason line (max 20 words) — ONLY if signal is NOT insufficient:
- Must reference their specific field/industry
- Must reflect their signal direction
- Must sound like a working coach

Nudge line (max 25 words) — ONLY if signal IS insufficient:
- Warm, direct, coach-voice
- Ask ONLY for the specific missing piece (role or industry)
- Give an example phrasing like "Senior PM at a SaaS startup"
- NEVER ask for company size, company name, or anything beyond role + industry

Respond ONLY with valid JSON, no preamble:
{
  "extracted": { "job_title_normalised": "...", "function": "...", "industry": "...", "company_type": "...", "seniority_signal_from_text": "..." },
  "signal": "insufficient|strong_positive|positive|neutral|negative|strong_negative",
  "reason_line": "...",
  "nudge_line": "..."
}`;

// ── Exchange 2: MERGED performance + leverage ────────────
// The user's single answer tells us whichever axis matters most to them.
// Claude classifies the strongest signal they actually gave.
const EXCHANGE_2_SYSTEM = `You are a salary negotiation coach. The user has just told you about their case for a raise — either their recent performance, their market leverage, or both. This is the single "what's your ammunition?" question in the 3-exchange flow.

FIRST — CHECK IF THE ANSWER HAS SIGNAL:
An answer is SUFFICIENT if it engages with the question in any way. Examples of SUFFICIENT answers:
  - Positive: "I exceeded my targets", "I have a competing offer", "I'm underpaid based on Glassdoor"
  - Neutral: "I met expectations", "things went okay", "I don't have strong evidence right now"
  - Negative / honest admission: "nothing", "no", "I have nothing", "I don't have anything", "I had nothing" — THESE ARE ALL VALID. User is honestly saying they have no leverage. Classify as negative or strong_negative, not insufficient.

Classify "insufficient" ONLY when the answer is completely off-topic or filler:
  - "hi", "test", "asdf"
  - Off-topic: "I don't trust my boss", "fuck you", "what was the options"

If user has provided context across multiple messages in short conversation (e.g. first "no", then "in real world I had nothing"), that IS an answer. Accept it and classify accordingly — don't keep asking for "more" when they've clearly said they have nothing. Pushing further is bad coaching.

Fields to extract (any that apply — use "not_mentioned" if not addressed):
- performance_rating: one of [exceeded, specific_win, met, mixed, poor, not_mentioned]
- external_leverage:  one of [competing_offer, actively_recruited, underpaid_evidence, none, not_mentioned]
- market_position:    one of [underpaid, at_market, overpaid, unsure, not_mentioned]
- specific_achievements: array of 0-3 short strings
- leverage_detail: string

Signal classification:
- insufficient: answer was filler or off-topic (see above — rare!)
- strong_positive: competing_offer OR exceeded expectations
- positive: actively_recruited OR credible underpaid evidence OR specific performance win
- neutral: met expectations / at-market / unsure
- negative: "I don't have strong evidence" / "nothing" / honest admission of no leverage
- strong_negative: explicitly poor performance AND zero leverage

Reason line (max 22 words) — ONLY if signal is NOT insufficient:
- Reference what they actually said
- For "negative" signal (honest no-leverage): reframe as "upside limited, focus shifts to making the case strategically" — never "tanked"

Nudge line (max 25 words) — ONLY if signal IS insufficient:
- Warm, direct, coach-voice
- Ask for specifics the user didn't provide
- Don't repeat the original question; paraphrase the ask

Respond ONLY with valid JSON, no preamble:
{
  "extracted": {
    "performance_rating": "...",
    "external_leverage": "...",
    "market_position": "...",
    "specific_achievements": [...],
    "leverage_detail": "..."
  },
  "signal": "insufficient|strong_positive|positive|neutral|negative|strong_negative",
  "reason_line": "...",
  "nudge_line": "..."
}`;

// ── Exchange 3: MANAGER relationship + prior_ask (timing removed) ────
// Timing moved to obstacle-question chip in the frontend. Ex3 stays focused
// on the relational axis which is a distinct signal from evidence.
const EXCHANGE_3_SYSTEM = `You are a salary negotiation coach. The user has just told you about their manager relationship and whether they've asked for a raise before. This is the FINAL exchange before the obstacle capture.

FIRST — CHECK IF THE ANSWER HAS SIGNAL:
If they selected a chip (relationship = strong|professional|complicated|never_asked), that IS valid signal even if free_text is empty. Only return "insufficient" if BOTH relationship is empty AND the free_text doesn't describe a manager relationship or prior ask. Off-topic free text ("I don't trust my process", "hi", "asdf") with no chip selected is insufficient.

Fields to extract (only if signal is NOT insufficient):
- manager_relationship: one of [strong, professional, complicated, never_asked]
- prior_ask: one of [not_mentioned, never_asked, asked_got_yes, asked_got_no, asked_got_partial]
- context_detail: string

Signal classification — relationship × prior_ask matrix:
- insufficient: no chip and no relationship content in free text
- strong_positive: strong + (asked_got_yes OR never_asked/not_mentioned)
- positive: professional + (asked_got_yes OR never_asked) OR strong + asked_got_partial
- neutral: professional + (never_asked OR not_mentioned) OR strong + asked_got_no
- negative: complicated + any OR professional + asked_got_no OR any + asked_got_partial
- strong_negative: complicated + asked_got_no

Reason line (max 22 words) — ONLY if NOT insufficient.
Nudge line (max 25 words) — ONLY if insufficient. Ask for the missing relationship piece; don't repeat the original question.

Respond ONLY with valid JSON, no preamble:
{
  "extracted": { "manager_relationship": "...", "prior_ask": "...", "context_detail": "..." },
  "signal": "insufficient|strong_positive|positive|neutral|negative|strong_negative",
  "reason_line": "...",
  "nudge_line": "..."
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

// Fire-and-forget log to the Google Apps Script webhook. `event` must match
// an event name the Apps Script's appendRaiseLead recognises (so it routes to
// the Raise Leads tab and color-codes the row). `fields` is merged into the
// payload — the Apps Script reads role/industry/range_floor/etc. by name.
async function logToSheet(event, fields) {
  try {
    const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
    if (!webhookUrl) return;
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        product:   'raise',
        ...(fields || {}),
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
    logToSheet('RAISE_OBSTACLE', {
      session_id:    req.body?.profile_hash || '',
      obstacle:      claudeResult.obstacle_code || 'other',
      range_floor:   current_range ? current_range.floor   : '',
      range_ceiling: current_range ? current_range.ceiling : '',
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

  // ── Insufficient signal guard (Ex1-3) ────────────────────
  // If Claude classified the user's answer as "insufficient", the answer had
  // no real signal. Don't run range math. Don't advance the exchange.
  // Return a nudge_line the frontend will render as a coach bubble.
  if (claudeResult.signal === 'insufficient') {
    logToSheet('RAISE_EXCHANGE_' + exchange, {
      session_id:    req.body?.profile_hash || '',
      signal:        'insufficient',
      range_floor:   current_range.floor,
      range_ceiling: current_range.ceiling,
    });
    return res.status(200).json({
      is_insufficient: true,
      nudge_line:      claudeResult.nudge_line || "I need a bit more to work with. Can you give me specifics?",
      // Return current range unchanged so frontend doesn't lose state
      floor:   current_range.floor,
      ceiling: current_range.ceiling,
      signal:  'insufficient',
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
  // Pull user-visible fields out of Claude's extracted structure so analytics
  // queries can segment by role/industry without parsing JSON blobs.
  const ext = claudeResult.extracted || {};
  logToSheet('RAISE_EXCHANGE_' + exchange, {
    session_id:    req.body?.profile_hash || '',
    role:          ext.job_title_normalised || '',
    industry:      ext.industry             || '',
    company_type:  ext.company_type         || '',
    seniority:     ext.seniority_signal_from_text || '',
    range_floor:   newRange.floor,
    range_ceiling: newRange.ceiling,
    signal:        claudeResult.signal,
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
