// api/raise-coach.js
// Salary Negotiation Coach — Paid coaching chat
// 30-day coaching window. Context-rich: every call includes the user's profile,
// their coach's notes (a Claude-maintained compact summary of history), and the last
// 10 messages of raw transcript. This keeps cost bounded even if the user chats daily.
//
// History storage (per spec § memory):
//   raise:user:{email}        — profile (stays stable)
//   raise:user:{email}:plan   — enriched plan from webhook
//   raise:user:{email}:chat   — full chat history (capped to MAX_HISTORY_RAW messages)
//   raise:user:{email}:notes  — compact Claude-generated summary (updated via raise-notes-update)
//
// Auth: access token (from query string of /raise/paid/?token=...)
// Session cap: MAX_MESSAGES per 30-day window (generous — 200). Hidden from UI.

const Anthropic = require('@anthropic-ai/sdk');
const { Redis }  = require('@upstash/redis');

const client = new Anthropic();
const redis  = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TTL_30_DAYS     = 60 * 60 * 24 * 30;
const MAX_HISTORY_RAW = 50;   // keep last 50 messages in Redis (rolls over)
const MAX_CONTEXT     = 10;   // pass last 10 messages to Claude as raw transcript
const MAX_MESSAGES    = 200;  // hidden cap — generous enough nobody hits it

const TEST_TOKEN = 'RAISE-TEST-2026';

// ── System prompt for the coach ────────────────────────────
function buildSystemPrompt({ profile, plan, notes }) {
  const a   = profile.assessment || {};
  const fr  = profile.final_range || {};
  const p   = plan || {};
  return `You are the user's personal Salary Negotiation Coach. You have 30 days to prepare them for a successful raise conversation at their current job. You remember every conversation in this window.

USER SNAPSHOT:
- Name: ${profile.first_name || '(not known)'}
- Country: ${a.country || 'unknown'}
- Seniority: ${a.seniority || 'unknown'}
- Company size: ${a.company_size || 'unknown'}
- Company situation: ${a.company_situation || 'unknown'}
- Last raise: ${a.last_raise || 'unknown'}
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
- Reference their actual profile, never generic.
- Every answer ends with something they can DO next.
- 3-6 sentences unless they explicitly ask for detail.
- Uses their name sparingly — once per session, not every message.

ROLE-PLAY MODE:
If they ask to practise, ask who you should play (the manager, HR, themselves), set the scene in one sentence, then stay in character until they say "out" or "end role play". After role-play ends, give 2-3 short notes on what worked and what to adjust.

Never be generic. Every response should feel like it could only be written for this specific person.`;
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
        event:     firstMessage ? 'COACH_FIRST_MESSAGE' : 'COACH_MESSAGE',
        product:   'raise',
        email,
        source:    'salary.recomlinked.com',
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

  const { token, message } = req.body || {};
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
      assessment:  { country: 'ca', seniority: 'mid', company_size: '250_1000', company_situation: 'stable', last_raise: '1_2_years' },
      final_range: { floor: 56, ceiling: 61 },
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
      system:     buildSystemPrompt({ profile, plan, notes }),
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

      // Log first message of a session
      if (history.length === 0) {
        logCoachMessage(email, true);
      } else if (history.length % 10 === 0) {
        logCoachMessage(email, false);
      }

      // ── Trigger notes update every 6 exchanges (12 messages) ──
      // Fire-and-forget — runs in the background.
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

    return res.status(200).json({ reply, capped: false });
  } catch (err) {
    console.error('[raise-coach] claude error:', err);
    return res.status(500).json({ error: 'Coach unavailable. Please try again.' });
  }
};
