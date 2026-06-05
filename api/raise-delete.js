// api/raise-delete.js
// Salary Negotiation Coach — GDPR/CCPA compliance
//
// POST { token, confirm: 'yes' }  — right to erasure (delete all user data)
// GET  ?token=xxx                  — right to data portability (export all user data)

const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const parse = r => r
  ? (typeof r === 'string' ? (r.startsWith('{') || r.startsWith('[') ? JSON.parse(r) : r) : r)
  : null;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ?token=xxx — data export ─────────────────────────
  if (req.method === 'GET') {
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

      const payload = {
        email,
        exported_at: new Date().toISOString(),
        profile: parse(userRaw),
        plan:    parse(planRaw),
        chat:    parse(chatRaw),
        notes:   parse(notesRaw),
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="salary-coach-export-${email}.json"`);
      return res.status(200).send(JSON.stringify(payload, null, 2));
    } catch (err) {
      console.error('[raise-delete/export] error:', err.message);
      return res.status(500).json({ error: 'Export failed' });
    }
  }

  // ── POST { token, confirm: 'yes' } — data deletion ───────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, confirm } = req.body || {};
  if (!token)            return res.status(400).json({ error: 'Token required' });
  if (confirm !== 'yes') return res.status(400).json({ error: 'Must confirm deletion' });

  try {
    const email = await redis.get(`raise:token:${token}`);
    if (!email) return res.status(401).json({ error: 'Invalid or expired token' });

    await Promise.all([
      redis.del(`raise:user:${email}`),
      redis.del(`raise:user:${email}:plan`),
      redis.del(`raise:user:${email}:chat`),
      redis.del(`raise:user:${email}:notes`),
      redis.del(`raise:token:${token}`),
    ]);

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
