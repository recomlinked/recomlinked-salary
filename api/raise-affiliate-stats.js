// api/raise-affiliate-stats.js
// Returns private stats for a creator affiliate by ref code.
// GET /api/raise-affiliate-stats?ref=hannah

const { Redis } = require('@upstash/redis');
const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

const COMMISSION = 0.40;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const ref = (req.query?.ref || '').toLowerCase().trim();
  if (!ref) return res.status(400).json({ error: 'Missing ref' });

  try {
    // Total stats — auto-create empty record on first visit so creator sees
    // their dashboard with zeros rather than an error page.
    let raw = await redis.get(`ref:${ref}`);
    if (!raw) {
      const empty = {
        source: ref, conversions: 0, raise_conversions: 0,
        total_earned: 0, pending_payout: 0,
        created_at: new Date().toISOString(),
      };
      await redis.set(`ref:${ref}`, JSON.stringify(empty), { ex: 60 * 60 * 24 * 365 });
      raw = JSON.stringify(empty);
    }
    const total = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Today's stats
    const todayRaw = await redis.get(`ref:${ref}:daily:${todayKey()}`);
    const today = todayRaw
      ? (typeof todayRaw === 'string' ? JSON.parse(todayRaw) : todayRaw)
      : { conversions: 0, earned: 0 };

    // Payment history (last 8 weeks)
    const weekKeys = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i * 7);
      weekKeys.push(`ref:${ref}:week:${d.toISOString().slice(0, 10)}`);
    }
    const weekRaws = await Promise.all(weekKeys.map(k => redis.get(k).catch(() => null)));
    const history = weekRaws
      .map((r, i) => {
        if (!r) return null;
        const w = typeof r === 'string' ? JSON.parse(r) : r;
        return { week: weekKeys[i].split(':week:')[1], ...w };
      })
      .filter(Boolean);

    return res.status(200).json({
      ref,
      total_sales:   total.raise_conversions || total.conversions || 0,
      total_earned:  total.total_earned || 0,
      today_sales:   today.conversions || 0,
      today_earned:  today.earned || 0,
      pending:       total.pending_payout || 0,
      commission:    COMMISSION,
      last_sale_at:  total.last_conversion_at || null,
      history,
    });
  } catch (e) {
    console.error('[raise-affiliate-stats]', e.message);
    return res.status(500).json({ error: 'Failed to load stats' });
  }
};
