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
  9.5: process.env.STRIPE_RAISE_PRICE_ID_950,
  19:  process.env.STRIPE_RAISE_PRICE_ID_19,
  29:  process.env.STRIPE_RAISE_PRICE_ID_29 || process.env.STRIPE_RAISE_PRICE_ID,
  39:  process.env.STRIPE_RAISE_PRICE_ID_39,
  49:  process.env.STRIPE_RAISE_PRICE_ID_49,
};

const VALID_PRICES = [9.5, 19, 29, 39, 49];

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
    product,
    free_offer,   // NEW — true for the "50% off, help others trust it works" path (1-week test)
  } = req.body || {};

  if (!profile_hash || !profile || !final_range) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const isFreeOffer = free_offer === true;

  // Resolve selected price — default to $29 if not sent or invalid.
  // Free-offer sessions still ring up against the real $29 price object
  // (so Stripe reporting/catalog stays honest) — the promotion code below
  // is what brings it to $14.50 (50% off), not a separate discounted price.
  const selectedPrice = isFreeOffer ? 29 : (VALID_PRICES.includes(Number(price)) ? Number(price) : 29);
  const productCode = product === 'offer' ? 'offer' : 'raise';
  const priceId = PRICE_ID_MAP[selectedPrice];

  if (!priceId) {
    return res.status(500).json({ error: `Price ID not configured for $${selectedPrice}` });
  }

  // The "Feedback50" promotion code's resolved Stripe ID (1-week 50%-off
  // test). Overridable via env var if the code is ever rotated/replaced in
  // the Dashboard, without needing a code change.
  const FEEDBACK_PROMOTION_CODE_ID = process.env.FEEDBACK_PROMOTION_CODE_ID || 'promo_1TsAtiK8c4f41ExBLbNuEGsA';

  if (isFreeOffer && !FEEDBACK_PROMOTION_CODE_ID) {
    // Fail loud rather than silently falling back to full price —
    // someone who tapped "50% off" should never get charged the full $29.
    console.error('[raise-checkout] FEEDBACK_PROMOTION_CODE_ID not configured');
    return res.status(500).json({ error: 'Free offer is not configured' });
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
      // discounts and allow_promotion_codes are mutually exclusive in the
      // Stripe API — free-offer sessions auto-apply the promotion code
      // server-side so the customer never has to find/type it themselves;
      // everyone else keeps the manual promo-code field for one-off cases.
      ...(isFreeOffer
        ? { discounts: [{ promotion_code: FEEDBACK_PROMOTION_CODE_ID }] }
        : { allow_promotion_codes: true }),
      success_url: productCode === 'offer'
        ? `${BASE}/offer/chat/?session_id={CHECKOUT_SESSION_ID}`
        : `${BASE}/raise/paid/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: productCode === 'offer' ? `${BASE}/offer/chat/` : `${BASE}/raise/chat/`,
      metadata: {
        product:      productCode,
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
        price_usd:    isFreeOffer ? '14.5' : String(selectedPrice),
        feedback_program: isFreeOffer ? 'yes' : 'no',   // NEW — lets the webhook trigger the ~1 week follow-up
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
            price_usd: isFreeOffer ? 14.5 : selectedPrice,
            feedback_program: isFreeOffer,
            product: productCode,
            offer_context: req.body.offer_context || null,
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
      product:   productCode,
      email,
      profile_hash,
      final_floor:   final_range.floor,
      final_ceil:    final_range.ceiling,
      obstacle_code: obs.code || '',
      stripeSession: session.id,
      price_usd:     isFreeOffer ? 14.5 : selectedPrice,
      refSource:     refSource || '',
      source:        'salary.recomlinked.com',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[raise-checkout] error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
