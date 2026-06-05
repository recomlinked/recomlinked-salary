// api/raise-checkout.js
// Salary Negotiation Coach — Stripe Checkout session creator
//
// Embeds the profile_hash in metadata so the webhook can retrieve the
// pre-computed enrichment plan and merge it into the paid user record.
// Supports 3 price tiers ($19 / $29 / $49) — all give identical access.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const BASE   = process.env.RAISE_BASE_URL || 'https://salary.recomlinked.com';

// Redis for stashing the checkout payload — webhook safety net.
let redis = null;
try {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url:   process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
} catch (e) {
  console.warn('[raise-checkout] redis not available — skipping session stash');
}

const CHECKOUT_STASH_TTL = 60 * 60 * 24 * 7; // 7 days

// Price ID map — set all three in your Vercel/Railway env vars.
// STRIPE_RAISE_PRICE_ID is kept as fallback for $29 (your existing price).
const PRICE_ID_MAP = {
  19: process.env.STRIPE_RAISE_PRICE_ID_19,
  29: process.env.STRIPE_RAISE_PRICE_ID_29 || process.env.STRIPE_RAISE_PRICE_ID,
  49: process.env.STRIPE_RAISE_PRICE_ID_49,
};

const VALID_PRICES = [19, 29, 49];

async function logToSheet(data) {
  try {
    const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
    if (!webhookUrl) return;
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
  } catch (e) { /* non-fatal */ }
}

function metaStr(v, max) {
  max = max || 500;
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.slice(0, max);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const {
    profile_hash,
    profile,
    final_range,
    obstacle,
    email,
    refSource,
    price,
  } = req.body || {};

  if (!profile_hash || !profile || !final_range) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Resolve selected price — default to $29 if not sent or invalid
  const selectedPrice = VALID_PRICES.includes(Number(price)) ? Number(price) : 29;
  const priceId = PRICE_ID_MAP[selectedPrice];

  if (!priceId) {
    return res.status(500).json({ error: `Price ID not configured for $${selectedPrice}` });
  }

  const obs = obstacle || { code: '', label: '', free_text: '' };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(email ? { customer_email: email } : {}),
      billing_address_collection: 'auto',
      payment_method_types: ['card'],
      line_items: [{
        price:    priceId,
        quantity: 1,
      }],
      allow_promotion_codes: true,
      success_url: `${BASE}/raise/paid/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE}/raise/chat/`,
      metadata: {
        product:      'raise',
        profile_hash: metaStr(profile_hash),
        country:      metaStr(profile.country),
        company_sit:  metaStr(profile.company_situation),
        last_raise:   metaStr(profile.last_raise),
        seniority:    metaStr(profile.seniority),
        company_size: metaStr(profile.company_size),
        final_floor:  metaStr(final_range.floor),
        final_ceil:   metaStr(final_range.ceiling),
        obstacle_code:       metaStr(obs.code),
        obstacle_label:      metaStr(obs.label, 480),
        obstacle_free_text:  metaStr(obs.free_text, 480),
        refSource:    metaStr(refSource),
        price_usd:    String(selectedPrice),
      },
    });

    // Stash in Redis for webhook safety net
    if (redis) {
      try {
        await redis.set(
          `raise:checkout:${session.id}`,
          JSON.stringify({
            profile_hash,
            profile,
            final_range,
            obstacle: obs,
            email:    email || '',
            refSource: refSource || '',
            price_usd: selectedPrice,
            created_at: Date.now(),
          }),
          { ex: CHECKOUT_STASH_TTL }
        );
      } catch (stashErr) {
        console.warn('[raise-checkout] stash failed:', stashErr.message);
      }
    }

    // Log CHECKOUT_STARTED
    await logToSheet({
      timestamp: new Date().toISOString(),
      event:     'CHECKOUT_STARTED',
      product:   'raise',
      email,
      profile_hash,
      final_floor:   final_range.floor,
      final_ceil:    final_range.ceiling,
      obstacle_code: obs.code || '',
      stripeSession: session.id,
      price_usd:     selectedPrice,
      refSource:     refSource || '',
      source:        'salary.recomlinked.com',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[raise-checkout] error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
