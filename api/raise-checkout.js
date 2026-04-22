// api/raise-checkout.js
// Salary Negotiation Coach — Stripe Checkout session creator
// Called when user clicks "Get my coaching plan · $39" on the paywall.
//
// Embeds the profile_hash in metadata so the webhook can retrieve the
// pre-computed enrichment plan and merge it into the paid user record.
// Uses STRIPE_RAISE_PRICE_ID env var for the price — separate from the FA product.
//
// ── Round 2 updates ──────────────────────────────────────
// • `obstacle` now passed through to Stripe metadata (code + label + free_text)
//   for cohort analysis later (which obstacle converts best / refunds most).
// • Stashes the full checkout payload in Redis under `raise:checkout:{session_id}`
//   with a 7-day TTL, so the webhook can re-run enrichment if the fire-and-forget
//   enrich call from the chat page failed for any reason.
// • Price constant PRICE_USD is informational here (Stripe holds truth via
//   STRIPE_RAISE_PRICE_ID). Keep this in sync with the frontend + coach for
//   logging clarity.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const BASE   = process.env.RAISE_BASE_URL || 'https://salary.recomlinked.com';

// Redis for stashing the checkout payload — webhook safety net.
// If @upstash/redis isn't available in this runtime for some reason, we
// fall back to skipping the stash (non-fatal — enrich from chat page is
// still the primary path).
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

// Informational — actual price is in Stripe. Keep in sync with
// /raise/chat/index.html `PRICE_USD` and api/raise-coach.js `PRICE_USD`.
const PRICE_USD = 39;

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

// Stripe metadata values must be strings and <=500 chars each.
// Helper to safely stringify + trim anything we shove into metadata.
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
    profile_hash,    // required — links to enrichment plan in Redis
    profile,         // assessment + exchanges summary
    final_range,     // { floor, ceiling }
    obstacle,        // { code, label, free_text?, user_phrase_echo?, coach_line? } — Round 2
    email,           // optional — Stripe will prompt if missing
    refSource,       // referral tracking
  } = req.body || {};

  if (!profile_hash || !profile || !final_range) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!process.env.STRIPE_RAISE_PRICE_ID) {
    return res.status(500).json({ error: 'Raise price not configured' });
  }

  // Normalise obstacle — may be null/undefined (user could bypass obstacle
  // question in edge cases, e.g. legacy state). Default to empty shape.
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
        // Round 2 — obstacle attribution for cohort analysis
        obstacle_code:       metaStr(obs.code),
        obstacle_label:      metaStr(obs.label, 480),
        obstacle_free_text:  metaStr(obs.free_text, 480),
        refSource:    metaStr(refSource),
      },
    });

    // ── Stash full checkout payload in Redis — webhook safety net ────
    // If the fire-and-forget enrich from the chat page didn't complete
    // (tab closed, network blip), the webhook can read this and retry.
    // Non-fatal if Redis is unavailable or this write fails.
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
