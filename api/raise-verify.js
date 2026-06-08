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
// Minimal test plan — matches current disc_insights format (canvasBlocks, not structured plan)
const TEST_PLAN = { pending: false, generated_via: 'test' };


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
