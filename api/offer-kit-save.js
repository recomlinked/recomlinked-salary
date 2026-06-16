// Stores a client-generated kit in Redis so future visits load instantly
const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const { token, kit, offer_ctx } = req.body || {};
  if (!token || !kit) return res.status(400).json({ error: 'token and kit required' });
  try {
    await Promise.all([
      redis.set(`offer:kit:${token}`, kit, { ex: 86400 * 30 }),
      offer_ctx ? redis.set(`offer:ctx:${token}`, JSON.stringify(offer_ctx), { ex: 86400 * 30 }) : Promise.resolve(),
    ]);
    return res.status(200).json({ stored: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
