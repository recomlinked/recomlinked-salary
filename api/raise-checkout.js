// api/raise-checkout.js
// Salary Negotiation Coach — Stripe Checkout session creator
// Called when user clicks "Practice every scenario · $19" on the paywall.
//
// Embeds the profile_hash in metadata so the webhook can retrieve the
// pre-computed enrichment plan and merge it into the paid user record.
// Uses STRIPE_RAISE_PRICE_ID env var for the price.

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

// Informational — actual price is in Stripe via STRIPE_RAISE_PRICE_ID.
const PRICE_USD = 19;

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
  } = req.body || {};

  if (!profile_hash || !profile || !final_range) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!process.env.STRIPE_RAISE_PRICE_ID) {
    return res.status(500).json({ error: 'Raise price not configured' });
  }

  const obs = obstacle || { code: '', label: '', free_text: '' };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(email ? { customer_email: email } : {}),
      billing_address_collection: 'auto',
      payment_method_types: ['card'],
      line_items: [{
        price:    process.env.STRIPE_RAISE_PRICE_ID,
        quantity: 1,
      }],
      allow_promotion_codes: false,
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
      price_usd:     PRICE_USD,
      refSource:     refSource || '',
      source:        'salary.recomlinked.com',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[raise-checkout] error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
