// api/raise-enrich.js
// Salary Negotiation Coach — Paid dashboard pre-computation
// Called fire-and-forget when the paywall renders. Generates the paid plan
// so that when the user completes Stripe checkout, their dashboard loads instantly.
//
// Responds 202 immediately, runs Claude generation after, stores result in Redis
// under raise:enrich:{profileHash} with 7-day TTL. The webhook on payment
// merges this into raise:user:{email}:plan.

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

const ENRICH_PROMPT = `You are a senior salary negotiation coach generating the paid coaching plan for a specific user.

You have their full assessment + all 4 chat exchange answers + final probability range. Generate a complete coaching plan tailored to their situation.

Be highly personalised — reference their specific function, industry, seniority, performance, leverage, manager relationship, and review timing.

RESPOND ONLY WITH VALID JSON. No markdown, no preamble. Just raw JSON matching this schema:

{
  "headline_summary": "<2-3 sentences explaining why the range sits where it does, in the coach's voice>",
  "amount_range": {
    "low_pct":  <number — the minimum % raise this user could realistically target>,
    "high_pct": <number — the ambitious % raise to anchor with>,
    "explanation": "<1-2 sentences on why this range, referencing their field and position>"
  },
  "top_3_blockers": [
    {
      "blocker":  "<short name, max 6 words>",
      "why":      "<1 sentence why it's holding them back>",
      "fix":      "<1-2 sentences on exactly how to fix it in the next 2-3 weeks>"
    },
    <exactly 3 items>
  ],
  "opening_script": {
    "one_liner": "<the exact opening sentence they should say, max 25 words>",
    "full_opener": "<2-4 sentences they can say to open the conversation, natural and human-sounding>"
  },
  "pushback_responses": [
    {
      "pushback": "<the likely pushback, e.g. 'There's no budget this cycle'>",
      "response": "<exactly what to say back, 1-2 sentences, calm and non-defensive>"
    },
    <exactly 3 pushbacks — the 3 most likely for THIS person's situation>
  ],
  "timing_recommendation": "<1-2 sentences on the best specific moment to ask, given their review cycle>",
  "email_template": {
    "subject": "<specific subject line — not generic>",
    "body":    "<full email draft, 150-250 words, personalised to this person, ends with ask for a conversation>"
  },
  "30_day_prep_plan": [
    { "week": 1, "actions": ["<specific action 1>", "<specific action 2>"] },
    { "week": 2, "actions": [...] },
    { "week": 3, "actions": [...] },
    { "week": 4, "actions": [...] }
  ]
}`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { profile, exchanges, final_range, profile_hash } = req.body || {};

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

  // ── Generate enrichment ────────────────────────────────
  const userMessage = `Assessment:
${JSON.stringify(profile, null, 2)}

Chat exchanges (in order):
${JSON.stringify(exchanges, null, 2)}

Final probability range: ${final_range.floor}–${final_range.ceiling}%

Generate the paid coaching plan JSON.`;

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2500,
      system:     ENRICH_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    });
    const raw     = response.content[0]?.text || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const result  = JSON.parse(cleaned);

    // Store under profile hash — checkout webhook will merge this into the user record
    await redis.set(enrichKey, JSON.stringify(result), { ex: CACHE_TTL });
    console.log(`[raise-enrich] stored key="${enrichKey}"`);
  } catch (err) {
    console.error(`[raise-enrich] failed key="${enrichKey}" error="${err.message}"`);
    // Non-fatal — paid dashboard will re-generate on load if plan missing
  }
};
