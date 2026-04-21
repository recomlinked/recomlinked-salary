// api/raise-magic-link.js
// Salary Negotiation Coach — Magic link resend
// Used by the /raise/enter page when a returning paid user needs a new link
// (lost localStorage, different device, bookmark expired while still within 30-day window).
//
// Flow:
//   1. POST { email } → look up raise:user:{email}
//   2. If valid paid user with time remaining → generate short-lived link token
//      storing it in raise:magic:{token} with 15 min TTL → email it to them
//   3. On click, /raise/enter verifies via /api/raise-verify which resolves the token
//
// Security:
//   - Never discloses whether an email is registered (same response for valid/invalid)
//   - Rate limited per email: 1 send per 2 minutes

const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');
const crypto     = require('crypto');

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const MAGIC_TTL       = 15 * 60;        // 15 minutes
const RATE_LIMIT_TTL  = 2  * 60;        // 2 minutes between sends per email
const BASE_URL        = process.env.RAISE_BASE_URL || 'https://salary.recomlinked.com';

function normalizeEmail(e) { return (e || '').trim().toLowerCase(); }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const email = normalizeEmail(req.body?.email);
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  // ── Rate limit ─────────────────────────────────────────
  try {
    const recent = await redis.get(`raise:magic:ratelimit:${email}`);
    if (recent) {
      // Mirror the 200 "sent if eligible" response — don't leak rate-limit existence
      return res.status(200).json({ sent: true });
    }
    await redis.set(`raise:magic:ratelimit:${email}`, '1', { ex: RATE_LIMIT_TTL });
  } catch (e) { /* non-fatal */ }

  // ── Lookup paid user ───────────────────────────────────
  let user;
  try {
    const raw = await redis.get(`raise:user:${email}`);
    if (!raw) {
      // Always return success to avoid email enumeration
      return res.status(200).json({ sent: true });
    }
    user = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return res.status(200).json({ sent: true });
  }

  // ── Mint magic token ───────────────────────────────────
  const magic = crypto.randomBytes(24).toString('hex');

  try {
    // Magic token maps directly to access token for speed; verify endpoint handles either.
    // We also store token→email in same pattern as access tokens so verify can resolve it.
    await redis.set(`raise:token:${magic}`, email, { ex: MAGIC_TTL });
  } catch (e) {
    console.error('[raise-magic-link] redis set failed:', e.message);
    return res.status(500).json({ error: 'Failed to generate link' });
  }

  // ── Send email ─────────────────────────────────────────
  try {
    if (!process.env.RESEND_API_KEY) {
      // Dev fallback: return the link directly (never do this in prod)
      if (process.env.NODE_ENV !== 'production') {
        return res.status(200).json({ sent: true, dev_link: `${BASE_URL}/raise/paid/?token=${magic}` });
      }
      return res.status(500).json({ error: 'Email not configured' });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const link   = `${BASE_URL}/raise/paid/?token=${magic}`;
    const name   = user.first_name || '';
    const greeting = name ? `Hi ${name},` : 'Hi,';

    await resend.emails.send({
      from:    'Milad Bakhti <support@recomlinked.com>',
      to:      email,
      subject: 'Your Salary Negotiation Coach — sign-in link',
      text: `${greeting}

Here's your sign-in link. It's valid for the next 15 minutes:
${link}

Once you click, you're back in your coaching session with all your history and notes. Your 30-day window continues from where you left off.

If you didn't request this, you can ignore this email — the link will expire and nothing will happen.

Milad Bakhti
Recomlinked`,
    });

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('[raise-magic-link] send error:', err.message);
    return res.status(500).json({ error: 'Failed to send link' });
  }
};
