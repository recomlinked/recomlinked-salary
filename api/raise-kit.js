// Fetch pre-generated Counter Kit for a paid user
const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const [kit, ctx] = await Promise.all([
      redis.get(`offer:kit:${token}`),
      redis.get(`offer:ctx:${token}`),
    ]);
    if (!kit) return res.status(404).json({ ready: false });
    return res.status(200).json({
      ready: true,
      kit,
      offer_ctx: ctx ? JSON.parse(ctx) : null,
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
