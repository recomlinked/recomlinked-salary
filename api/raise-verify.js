// api/raise-verify.js
// Salary Negotiation Coach — Access token verification
// Called by /raise/paid/ page on load. Two modes:
//   1. ?token=xxx       → look up user by access token (bookmarked link)
//   2. ?session_id=xxx  → look up email by Stripe session, then resolve token (post-checkout redirect)
//
// Returns the paid user record + their plan + days remaining.
// Also supports TEST_TOKEN for internal QA.

const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ── Internal test token — bypasses Redis for dev ──────────
const TEST_TOKEN = 'RAISE-TEST-2026';
const TEST_USER  = {
  email:       'test@example.com',
  first_name:  'Alex',
  paid_at:     new Date().toISOString(),
  expires_at:  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  profile_hash: 'test-hash',
  assessment: {
    country:           'ca',
    company_situation: 'stable',
    last_raise:        '1_2_years',
    seniority:         'mid',
    company_size:      '250_1000',
  },
  final_range: { floor: 56, ceiling: 61 },
  access_token: TEST_TOKEN,
};
const TEST_PLAN = {
  headline_summary: 'You are in a solid mid-range position: stable employer, moderate tenure, and a reasonable window to make your case. The biggest single lever you have is building external leverage before the conversation — even a single recruiter conversation shifts your footing meaningfully.',
  amount_range: { low_pct: 8, high_pct: 14, explanation: 'Mid-level roles in stable companies with 1-2 years of tenure typically land in the 8-14% band for successful negotiated raises. The 14% end requires external leverage.' },
  top_3_blockers: [
    { blocker: 'No external leverage', why: 'Without a recruiter conversation or recent outreach, you have no counter-force to anchor against.', fix: 'Update LinkedIn to "Open to opportunities", respond to one recruiter this week, and capture the conversation in notes.' },
    { blocker: 'No quantified recent win', why: 'Your performance is solid but hasn\'t been converted into a specific business-impact number.', fix: 'Pick your best project from the last 6 months. Write down the revenue, cost, or time impact in one sentence. That becomes your anchor.' },
    { blocker: 'Timing ambiguity',       why: 'Your review is in 1-3 months — close enough to matter, far enough to miss if you don\'t schedule.', fix: 'Request a 30-minute career conversation with your manager in the next 2 weeks. Frame it as "planning for the review cycle," not as the ask itself.' },
  ],
  opening_script: {
    one_liner: "I'd like to schedule time to discuss my compensation ahead of the next review cycle.",
    full_opener: "I've been reflecting on where I'd like to take my work over the next year, and I'd like to discuss my compensation ahead of the review cycle. I have a clear view of what I've delivered and what the market looks like for my role — and I want us both to go into the review with the same information. Can we set aside 30 minutes in the next two weeks?",
  },
  pushback_responses: [
    { pushback: "There's no budget this cycle.",                           response: "I understand budget timing. What I want to agree now is the case and the number — so when the budget does open, we're ready. Can we lock that together?" },
    { pushback: "You just had your annual raise.",                         response: "I did, and that was for last year's work. I'm asking you to look at what's happened since and what the next 12 months look like — that's a different conversation." },
    { pushback: "Let's revisit this at the next formal review.",           response: "I'd rather we discuss it now so we're aligned going into the review — the review itself shouldn't be where either of us is surprised by a number." },
  ],
  timing_recommendation: 'Your review is in 1-3 months. Request the career conversation now, have the raise discussion 2-3 weeks before the formal review. Asking during the review itself is too late — decisions have been made.',
  email_template: {
    subject: 'Request: career + compensation conversation ahead of review',
    body: 'Hi [Manager],\n\nI\'d like to schedule a 30-minute conversation in the next two weeks to discuss my compensation ahead of the review cycle.\n\nOver the last year I\'ve [specific achievement with a number]. I\'ve also had time to reflect on how my role has evolved and where I want to focus next. Before the formal review, I\'d value the chance to walk you through where I think my contribution sits and what I\'d like to discuss on compensation — so the review itself is a confirmation rather than the first time we talk about it.\n\nWould [specific date option 1] or [specific date option 2] work for you?\n\nThanks,\n[Your name]',
  },
  '30_day_prep_plan': [
    { week: 1, actions: ['Quantify your top achievement in one sentence', 'Open 1 recruiter conversation', 'Send the meeting request email'] },
    { week: 2, actions: ['Have the career conversation', 'Test your opening script out loud 3 times', 'Capture manager\'s reactions'] },
    { week: 3, actions: ['Have the compensation conversation', 'Use role-play mode the day before', 'Document the outcome same day'] },
    { week: 4, actions: ['Follow up in writing', 'If answer was "not yet" — get the exact criteria and date for revisit', 'If yes — lock the effective date'] },
  ],
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { token, session_id } = req.query;

  // ── Test token bypass ──────────────────────────────────
  if (token === TEST_TOKEN) {
    return res.status(200).json({
      valid:     true,
      profile:   TEST_USER,
      plan:      TEST_PLAN,
      days_left: 30,
      is_test:   true,
    });
  }

  let accessToken = token;

  // ── Session ID → token lookup (post-checkout flow) ─────
  if (!accessToken && session_id) {
    try {
      const email = await redis.get(`raise:session:${session_id}`);
      if (email) {
        const userRaw = await redis.get(`raise:user:${email}`);
        if (userRaw) {
          const u = typeof userRaw === 'string' ? JSON.parse(userRaw) : userRaw;
          accessToken = u.access_token;
        }
      }
    } catch (e) {
      console.error('[raise-verify] session lookup failed:', e.message);
    }
  }

  if (!accessToken) {
    return res.status(400).json({ error: 'Token or session_id required' });
  }

  // ── Resolve token → email → user record ────────────────
  try {
    const email = await redis.get(`raise:token:${accessToken}`);
    if (!email) {
      return res.status(401).json({
        error:   'expired',
        message: 'This link has expired. Enter your email to resend your access link.',
      });
    }

    const userRaw = await redis.get(`raise:user:${email}`);
    if (!userRaw) {
      return res.status(401).json({
        error:   'expired',
        message: 'Your coaching window has ended. Enter your email to check status.',
      });
    }
    const user = typeof userRaw === 'string' ? JSON.parse(userRaw) : userRaw;

    // Plan (may be pending if webhook raced enrichment)
    let plan = null;
    try {
      const planRaw = await redis.get(`raise:user:${email}:plan`);
      if (planRaw) plan = typeof planRaw === 'string' ? JSON.parse(planRaw) : planRaw;
    } catch (e) { /* non-fatal */ }

    // Days left (from expires_at)
    const msLeft   = new Date(user.expires_at).getTime() - Date.now();
    const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));

    return res.status(200).json({
      valid:     true,
      profile:   user,
      plan,
      days_left: daysLeft,
      is_test:   false,
    });
  } catch (err) {
    console.error('[raise-verify] error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
