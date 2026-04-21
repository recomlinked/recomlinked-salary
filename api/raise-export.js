// api/raise-export.js
// Salary Negotiation Coach — User data export (GDPR/CCPA compliance)
// Authenticated by access token. Returns all data we hold about the user in JSON.

const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    const email = await redis.get(`raise:token:${token}`);
    if (!email) return res.status(401).json({ error: 'Invalid or expired token' });

    const [userRaw, planRaw, chatRaw, notesRaw] = await Promise.all([
      redis.get(`raise:user:${email}`),
      redis.get(`raise:user:${email}:plan`),
      redis.get(`raise:user:${email}:chat`),
      redis.get(`raise:user:${email}:notes`),
    ]);

    const parse = r => r ? (typeof r === 'string' ? (r.startsWith('{') || r.startsWith('[') ? JSON.parse(r) : r) : r) : null;

    const payload = {
      email,
      exported_at: new Date().toISOString(),
      profile:     parse(userRaw),
      plan:        parse(planRaw),
      chat:        parse(chatRaw),
      notes:       parse(notesRaw),
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="salary-coach-export-${email}.json"`);
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[raise-export] error:', err.message);
    return res.status(500).json({ error: 'Export failed' });
  }
};
