// api/raise-notes-update.js
// Salary Negotiation Coach — Coach's notes maintenance
// Called fire-and-forget by raise-coach.js every ~12 messages.
// Takes: previous coach's notes + last N raw transcript messages
// Returns: updated compact notes narrative (stored as plain text in Redis)
//
// Purpose: bounds context window cost. Instead of passing hundreds of messages
// into every coach call, we pass the stable notes + last 10 raw messages.
//
// Protected by RAISE_INTERNAL_KEY env var to prevent external abuse.

const Anthropic = require('@anthropic-ai/sdk');
const { Redis } = require('@upstash/redis');

const client = new Anthropic();
const redis  = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TTL_30_DAYS = 60 * 60 * 24 * 30;

const NOTES_PROMPT = `You are maintaining coaching notes for a Salary Negotiation Coach who meets with the same user over 30 days.

Below you have:
1. The user's profile (stable facts)
2. The previous version of your coaching notes (may be empty)
3. The most recent chat transcript

Your job: produce an UPDATED compact notes narrative. This is for YOUR OWN use in future sessions so you remember this person.

WHAT TO INCLUDE:
- Their manager's name, team context, company name if mentioned
- Their target number and the number they're actually asking for (if different)
- Specific achievements they've shared that you can reference back
- Concerns or fears they've expressed
- Meetings scheduled, had, or planned — with dates
- Homework you've given them and whether they've done it
- Their communication style (direct? nervous? over-prepared? avoidant?)
- Key decisions you've made together
- Any pushback they've anticipated and the plan

WHAT TO EXCLUDE:
- Verbatim conversation
- Generic coaching advice (that's in the plan)
- Speculation beyond what they've said

FORMAT:
Plain prose paragraphs. No bullet points. No headers. 200-400 words MAX. Written as your own notes to your future self.

Respond with ONLY the notes text. No JSON, no preamble.`;

async function buildNotes({ profile, previousNotes, transcript }) {
  const userMessage = `USER PROFILE:
Name: ${profile.first_name || '(unknown)'}
Country: ${profile.assessment?.country || '?'}
Seniority: ${profile.assessment?.seniority || '?'}
Company size: ${profile.assessment?.company_size || '?'}
Company situation: ${profile.assessment?.company_situation || '?'}
Last raise: ${profile.assessment?.last_raise || '?'}
Final range: ${profile.final_range?.floor || '?'}-${profile.final_range?.ceiling || '?'}%

PREVIOUS NOTES:
${previousNotes || '(none — this is your first update)'}

RECENT TRANSCRIPT:
${transcript.map(m => `${m.role === 'user' ? 'USER' : 'COACH'}: ${m.content}`).join('\n\n')}

Write the updated notes.`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 600,
    system:     NOTES_PROMPT,
    messages:   [{ role: 'user', content: userMessage }],
  });
  return response.content[0]?.text?.trim() || '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Simple internal protection — this endpoint is called only by raise-coach.js
  const providedKey = req.body?.internal_key;
  const expectedKey = process.env.RAISE_INTERNAL_KEY;
  if (expectedKey && providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Respond 202 so caller doesn't wait
  res.status(202).json({ ok: true });

  try {
    const [userRaw, notesRaw, chatRaw] = await Promise.all([
      redis.get(`raise:user:${email}`),
      redis.get(`raise:user:${email}:notes`),
      redis.get(`raise:user:${email}:chat`),
    ]);
    if (!userRaw)  return;
    if (!chatRaw)  return;

    const profile      = typeof userRaw  === 'string' ? JSON.parse(userRaw)  : userRaw;
    const previousNotes= notesRaw ? (typeof notesRaw === 'string' ? notesRaw : String(notesRaw)) : '';
    const history      = typeof chatRaw  === 'string' ? JSON.parse(chatRaw)  : chatRaw;

    // Take the most recent 20 messages for summarisation
    const recent = history.slice(-20);
    if (recent.length < 6) return; // not enough new content — skip

    const notes = await buildNotes({ profile, previousNotes, transcript: recent });
    if (notes) {
      await redis.set(`raise:user:${email}:notes`, notes, { ex: TTL_30_DAYS });
      console.log(`[raise-notes-update] updated notes for ${email} — ${notes.length} chars`);
    }
  } catch (err) {
    console.error('[raise-notes-update] failed:', err.message);
  }
};
