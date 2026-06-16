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

    // No kit AND no ctx → old token, nothing in Redis
    if (!kit && !ctx) return res.status(404).json({ ready: false });

    // Kit ready → return both
    if (kit) return res.status(200).json({
      ready: true,
      kit,
      offer_ctx: ctx ? (typeof ctx === 'string' ? JSON.parse(ctx) : ctx) : null,
    });

    // Ctx exists but kit still generating → return ctx so client can generate with correct data
    return res.status(200).json({
      ready: false,
      kit: null,
      offer_ctx: typeof ctx === 'string' ? JSON.parse(ctx) : ctx,
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
