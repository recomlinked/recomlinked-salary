// api/raise-enrich.js
// Salary Negotiation Coach — Paid dashboard pre-computation
// Called fire-and-forget when the paywall renders. Generates the paid plan
// so that when the user completes Stripe checkout, their dashboard loads instantly.
//
// Responds 202 immediately, runs Claude generation after, stores result in Redis
// under raise:enrich:{profileHash} with 7-day TTL. The webhook on payment
// merges this into raise:user:{email}:plan.
//
// ── Round 2 updates ──────────────────────────────────────
// NEW SIGNALS CONSUMED:
//   obstacle                    — { code, label, free_text?, coach_line? } from Ex4
//   exchanges.ex1.extracted.seniority_signal_from_text — Ex1 title-inference
//   exchanges.ex3.extracted.prior_ask                  — "never_asked"|"asked_got_no"|...
//
// SECTION TITLES now rewritten as user-voice questions, matching the chat
// page's plan-preview chips 1:1. When the user taps a chip on the chat page,
// they're asking the same question that titles the section on the plan page.
//
// OBSTACLE_HOOK per section — a short line the plan page renders at the top
// of each section that references the user's stated obstacle. Lets the plan
// feel like it's answering their specific worry section-by-section, not
// giving generic coaching.

const Anthropic = require('@anthropic-ai/sdk');
const { Redis }  = require('@upstash/redis');

const client = new Anthropic();
const redis  = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const CACHE_TTL = 60 * 60 * 24 * 7;

function makeEnrichKey(profileHash) {
  return `raise:enrich|${profileHash}`;
}

// System prompt — teaches Claude the 3-exchange + obstacle schema and the
// output shape (user-voice section titles + obstacle hooks).
const ENRICH_PROMPT = `You are a senior salary negotiation coach generating the paid coaching plan for a specific user.

You have their full assessment + 3 chat exchange answers + obstacle they flagged + final probability range. Generate a complete coaching plan tailored to their situation.

INPUTS YOU'LL RECEIVE:
- Assessment: company_situation, last_raise, company_size
- Ex1 extracted: job_title_normalised, function, industry, company_type, seniority_signal_from_text
- Ex2 extracted: performance_rating, external_leverage, market_position, specific_achievements, leverage_detail
- Ex3 extracted: manager_relationship, prior_ask, context_detail
- Obstacle: code (budget|justify|timing|prior_no|unknown_amount|other), label, optional free_text, coach_line
- Final range: floor-ceiling %

SIGNALS TO TREAT AS LOAD-BEARING:
1. seniority_signal_from_text — if present and not "unclear", treat as more reliable than the default "mid" in the assessment. Use it to calibrate amount_range (junior ≈ lower %, senior/lead ≈ higher %) and to shape language (a VP needs different coaching than a junior analyst).

2. prior_ask — if "asked_got_no" or "asked_got_partial", the opening_script and pushback_responses MUST address reopening the conversation after a prior no. Don't pretend it didn't happen. The plan's first blocker often is "how to reopen without looking desperate or bitter".

3. obstacle.code — the user explicitly told you what they're most worried about. Every section of the plan should make contact with it. The obstacle_hook field on each section is where you name it directly.

OUTPUT RULES:
- Be highly personalised — reference their specific function, industry, seniority, performance, leverage, manager relationship, and prior ask history.
- Section TITLES use second-person user-voice questions, matching how the user asked the question ("How should I open the conversation?" not "Opening script").
- Section SUBTITLES are the coach's short framing of what that section delivers.
- Every section's obstacle_hook is one sentence that ties the section to the user's stated obstacle. If the obstacle doesn't genuinely relate to that section, write a hook that bridges honestly ("This isn't directly about your timing worry, but it feeds it — here's why").
- amount_range must be defensible for their specific seniority + function + industry + market position.

RESPOND ONLY WITH VALID JSON. No markdown, no preamble. Just raw JSON matching this schema:

{
  "headline_summary": "<2-3 sentences explaining why the range sits where it does, named obstacle addressed, in the coach's voice>",

  "amount_range": {
    "low_pct":  <number — minimum % raise this user could realistically target>,
    "high_pct": <number — ambitious % raise to anchor with>,
    "explanation": "<1-2 sentences on why this range, referencing field, seniority, and leverage>"
  },

  "sections": {
    "blockers": {
      "title": "What's actually holding my number back?",
      "subtitle": "Three specific things — and the fix for each",
      "obstacle_hook": "<1 sentence tying blockers to their obstacle>",
      "top_3_blockers": [
        {
          "blocker": "<short name, max 6 words>",
          "why":     "<1 sentence why it's holding them back>",
          "fix":     "<1-2 sentences on exactly how to fix it in the next 2-3 weeks>"
        },
        <exactly 3 items>
      ]
    },

    "script": {
      "title": "How should I open the conversation?",
      "subtitle": "The first sentence, the full opener, and why it works",
      "obstacle_hook": "<1 sentence tying the opening to their obstacle>",
      "one_liner": "<the exact opening sentence they should say, max 25 words>",
      "full_opener": "<2-4 sentences they can say to open the conversation, natural and human-sounding>",
      "why_it_works": "<1 sentence naming the mechanism — why this opener works for their specific manager relationship>"
    },

    "pushback": {
      "title": "What if my manager pushes back?",
      "subtitle": "The three responses you'll actually hear — and what to say",
      "obstacle_hook": "<1 sentence tying pushback handling to their obstacle>",
      "pushback_responses": [
        {
          "pushback": "<the likely pushback, e.g. 'There's no budget this cycle'>",
          "response": "<exactly what to say back, 1-2 sentences, calm and non-defensive>"
        },
        <exactly 3 pushbacks — the 3 most likely for THIS person's situation, given their obstacle>
      ]
    },

    "timing": {
      "title": "When's my best moment to ask?",
      "subtitle": "The specific window for your situation",
      "obstacle_hook": "<1 sentence tying timing to their obstacle — especially if obstacle.code == 'timing'>",
      "timing_recommendation": "<2-3 sentences on the best specific moment to ask given their review cycle, company situation, and prior_ask history>",
      "window_options": [
        { "window": "<short name, e.g. 'After Q2 close'>",          "why": "<1 sentence>" },
        { "window": "<short name, e.g. 'Post-project milestone'>",  "why": "<1 sentence>" }
      ]
    },

    "email": {
      "title": "Can you draft the email for me?",
      "subtitle": "Subject line, body, and the single change that gets the meeting booked",
      "obstacle_hook": "<1 sentence tying the email to their obstacle>",
      "email_template": {
        "subject": "<specific subject line — not generic>",
        "body":    "<full email draft, 150-250 words, personalised to this person, ends with ask for a conversation>"
      }
    },

    "prep": {
      "title": "What should I do in the next 30 days?",
      "subtitle": "Week by week — audit, position, set up, ask",
      "obstacle_hook": "<1 sentence tying prep to their obstacle>",
      "30_day_prep_plan": [
        { "week": 1, "theme": "<short theme>", "actions": ["<specific action 1>", "<specific action 2>"] },
        { "week": 2, "theme": "<short theme>", "actions": [...] },
        { "week": 3, "theme": "<short theme>", "actions": [...] },
        { "week": 4, "theme": "<short theme>", "actions": [...] }
      ]
    },

    "roleplay": {
      "title": "Let's role-play the conversation",
      "subtitle": "Practise until it feels normal, not rehearsed",
      "obstacle_hook": "<1 sentence tying role-play to their obstacle — especially if obstacle.code == 'justify' or 'prior_no'>",
      "opening_scene": "<1-2 sentences setting the scene for role-play — 'Your manager just pulled up their laptop and said \\"what's up?\\"…'>",
      "coach_instructions": "<1 sentence on what the coach (you) will do during role-play — 'I'll play your manager, with their real style based on what you've told me. You open. We'll pause when it matters.'>"
    }
  }
}

CRITICAL:
- Return ONLY the JSON object. No markdown fences, no preamble.
- Every section's title MUST match this schema exactly (they're the user-voice questions shown as chat chips).
- obstacle_hook must never be empty — if the section doesn't relate, bridge honestly.`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { profile, exchanges, obstacle, final_range, profile_hash } = req.body || {};

  if (!profile || !exchanges || !final_range || !profile_hash) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const enrichKey = makeEnrichKey(profile_hash);

  // ── Cache check — skip regeneration if already done ────
  try {
    const existing = await redis.get(enrichKey);
    if (existing) {
      return res.status(200).json({ ok: true, cached: true });
    }
  } catch (e) { /* continue */ }

  // ── Respond 202 immediately — client doesn't wait ──────
  res.status(202).json({ ok: true, cached: false });

  // ── Build a load-bearing context block for Claude ──────
  // Pull out the signals we specifically want Claude to reason over so they
  // don't get buried in the JSON dump.
  const ex1  = exchanges.ex1?.extracted || {};
  const ex2  = exchanges.ex2?.extracted || {};
  const ex3  = exchanges.ex3?.extracted || {};
  const seniorityFromText = ex1.seniority_signal_from_text || 'unclear';
  const priorAsk          = ex3.prior_ask || 'not_mentioned';
  const obstacleCode      = obstacle?.code || 'other';
  const obstacleLabel     = obstacle?.label || '';
  const obstacleFreeText  = obstacle?.free_text || '';

  const loadBearingContext = `
LOAD-BEARING SIGNALS (pay extra attention):
- seniority_signal_from_text: ${seniorityFromText}
  ${seniorityFromText !== 'unclear' ? `(USE THIS over the default "mid" from the assessment.)` : '(fall back to mid-level calibration.)'}
- prior_ask: ${priorAsk}
  ${priorAsk === 'asked_got_no' || priorAsk === 'asked_got_partial'
      ? '(The user has asked before and was told no or given less than requested. The plan MUST address reopening the conversation.)'
      : '(No prior refusal to work around.)'}
- obstacle: ${obstacleCode} — "${obstacleLabel}"
  ${obstacleFreeText ? `User's exact words: "${obstacleFreeText}"` : ''}
  (Every section's obstacle_hook should tie back to this worry.)
`.trim();

  const userMessage = `${loadBearingContext}

Full assessment:
${JSON.stringify(profile, null, 2)}

Chat exchanges (in order):
${JSON.stringify(exchanges, null, 2)}

Obstacle:
${JSON.stringify(obstacle || {}, null, 2)}

Final probability range: ${final_range.floor}–${final_range.ceiling}%

Generate the full coaching plan JSON per the schema above.`;

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 3500,
      system:     ENRICH_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    });
    const raw     = response.content[0]?.text || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const result  = JSON.parse(cleaned);

    // ── Compatibility shim: flatten new sections shape into top-level fields
    // the current plan page expects, so this deploy doesn't break the paid
    // dashboard before the plan page is updated (Pass 3). New clients can
    // read from result.sections; old clients keep reading the flat fields.
    const sections = result.sections || {};
    const flattened = {
      headline_summary:    result.headline_summary,
      amount_range:        result.amount_range,
      top_3_blockers:      sections.blockers?.top_3_blockers || [],
      opening_script: {
        one_liner:   sections.script?.one_liner   || '',
        full_opener: sections.script?.full_opener || '',
      },
      pushback_responses:  sections.pushback?.pushback_responses || [],
      timing_recommendation: sections.timing?.timing_recommendation || '',
      email_template:      sections.email?.email_template || { subject: '', body: '' },
      '30_day_prep_plan':  sections.prep?.['30_day_prep_plan']    || [],
      // New structured field — plan page can start reading this in Pass 3
      sections,
      // Metadata for debugging / future use
      meta: {
        obstacle_code:     obstacleCode,
        seniority_used:    seniorityFromText,
        prior_ask:         priorAsk,
        generated_at:      new Date().toISOString(),
      },
    };

    await redis.set(enrichKey, JSON.stringify(flattened), { ex: CACHE_TTL });
    console.log(`[raise-enrich] stored key="${enrichKey}" obstacle="${obstacleCode}" seniority="${seniorityFromText}" priorAsk="${priorAsk}"`);
  } catch (err) {
    console.error(`[raise-enrich] failed key="${enrichKey}" error="${err.message}"`);
    // Non-fatal — paid dashboard will re-generate on load if plan missing
  }
};
