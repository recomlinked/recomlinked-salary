// api/raise-checkout.js
// Salary Negotiation Coach — Stripe Checkout session creator
// Called when user clicks "Get My Coaching Plan · $49" on the paywall.
//
// Embeds the profile_hash in metadata so the webhook can retrieve the
// pre-computed enrichment plan and merge it into the paid user record.
// Uses STRIPE_RAISE_PRICE_ID env var for the $49 price — separate from the FA product.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const BASE   = process.env.RAISE_BASE_URL || 'https://salary.recomlinked.com';

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const {
    profile_hash,    // required — links to enrichment plan in Redis
    profile,         // assessment + exchanges summary (goes to metadata for resilience)
    final_range,     // { floor, ceiling } — displayed in metadata for debugging
    email,           // optional — Stripe will prompt if missing
    refSource,       // referral tracking
  } = req.body || {};

  if (!profile_hash || !profile || !final_range) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!process.env.STRIPE_RAISE_PRICE_ID) {
    return res.status(500).json({ error: 'Raise price not configured' });
  }

  try {
    // Stripe metadata values must be strings <=500 chars each.
    // We keep only the identifiers here — the full plan lives in Redis keyed by profile_hash.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(email ? { customer_email: email } : {}),
      billing_address_collection: 'auto',
      payment_method_types: ['card'],
      line_items: [{
        price:    process.env.STRIPE_RAISE_PRICE_ID,
        quantity: 1,
      }],
      success_url: `${BASE}/raise/paid/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE}/raise/chat/`,
      metadata: {
        product:      'raise',
        profile_hash,
        country:      profile.country          || '',
        company_sit:  profile.company_situation|| '',
        last_raise:   profile.last_raise       || '',
        seniority:    profile.seniority        || '',
        company_size: profile.company_size     || '',
        final_floor:  String(final_range.floor),
        final_ceil:   String(final_range.ceiling),
        refSource:    refSource || '',
      },
    });

    // Log CHECKOUT_STARTED
    await logToSheet({
      timestamp: new Date().toISOString(),
      event:     'CHECKOUT_STARTED',
      product:   'raise',
      email,
      profile_hash,
      final_floor:  final_range.floor,
      final_ceil:   final_range.ceiling,
      stripeSession: session.id,
      refSource: refSource || '',
      source:    'salary.recomlinked.com',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[raise-checkout] error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
