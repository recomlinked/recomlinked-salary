// api/raise-delete.js
// Salary Negotiation Coach — User data deletion (GDPR/CCPA right to erasure)
// Authenticated by access token. Requires ?confirm=yes to guard against accidents.
// Removes the user record + plan + chat history + notes + token.
// Does NOT refund Stripe — that's handled manually.

const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { token, confirm } = req.body || {};
  if (!token)             return res.status(400).json({ error: 'Token required' });
  if (confirm !== 'yes')  return res.status(400).json({ error: 'Must confirm deletion' });

  try {
    const email = await redis.get(`raise:token:${token}`);
    if (!email) return res.status(401).json({ error: 'Invalid or expired token' });

    // Delete all user-specific keys
    await Promise.all([
      redis.del(`raise:user:${email}`),
      redis.del(`raise:user:${email}:plan`),
      redis.del(`raise:user:${email}:chat`),
      redis.del(`raise:user:${email}:notes`),
      redis.del(`raise:token:${token}`),
    ]);

    // Log the deletion (for audit trail)
    try {
      const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            timestamp: new Date().toISOString(),
            event:     'DATA_DELETION',
            product:   'raise',
            email,
          }),
        });
      }
    } catch (e) { /* non-fatal */ }

    return res.status(200).json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[raise-delete] error:', err.message);
    return res.status(500).json({ error: 'Deletion failed' });
  }
};
