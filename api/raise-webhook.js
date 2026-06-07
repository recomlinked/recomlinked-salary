// api/raise-webhook.js
// Salary Negotiation Coach — Stripe webhook (separate from FA webhook)
// Only processes events where metadata.product === 'raise'.
// Silently ignores all other events (including FA events, if Stripe sends them to this endpoint).
//
// On checkout.session.completed:
//      → if missing, read checkout stash raise:checkout:{session_id} (Round 2)
//   2. Create paid user record raise:user:{email}      (30-day TTL)
//      Now includes `obstacle` from Round 2 metadata
//   3. Store plan        raise:user:{email}:plan       (30-day TTL)
//   4. Map session→email raise:session:{session_id}    (24h TTL)
//   5. Send welcome email with 30-day magic link
//   6. Log PAID to Google Sheet
//
// ── Round 2 updates ──────────────────────────────────────
// • Reads checkout stash (set by raise-checkout.js) when the primary enrich
//   key is missing. Gives us the profile/exchanges/obstacle needed to retry.
//   and-forget) — user record is created immediately, plan populates async.
// • Stores `obstacle` in user record so raise-coach.js and the paid page
//   can read it consistently.

module.exports.config = { api: { bodyParser: false } };

const Stripe    = require('stripe');
const { Redis } = require('@upstash/redis');
const { Resend }= require('resend');
const crypto    = require('crypto');

const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

const TTL_30_DAYS = 60 * 60 * 24 * 30;
const TTL_24_HRS  = 60 * 60 * 24;
const BASE_URL    = process.env.RAISE_BASE_URL || 'https://salary.recomlinked.com';

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function normalizeEmail(e) {
  return (e || '').trim().toLowerCase();
}

function mintToken() {
  // 32 hex chars — used as persistent access token (lives 30 days in Redis)
  return crypto.randomBytes(16).toString('hex');
}

async function readCheckoutStash(sessionId) {
  try {
    const raw = await redis.get(`raise:checkout:${sessionId}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[raise-webhook] stash read failed:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  // CORS for browser session-logging requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);

  // ── Session logging — route RAISE_SESSION to Google Sheets ──
  try {
    const peek = JSON.parse(rawBody.toString());
    if (peek && peek.event === 'RAISE_SESSION') {
      const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rawBody.toString(),
        });
      }
      return res.status(200).json({ ok: true });
    }
  } catch (e) { /* not JSON or not a session event — continue to Stripe */ }

  // ── Stripe webhook handling ─────────────────────────────
  const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_RAISE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[raise-webhook] signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Acknowledge everything we don't care about
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored_type: event.type });
  }

  const session = event.data.object;
  const meta    = session.metadata || {};

  // CRITICAL: only process raise product events — ignore FA events silently
  if (meta.product !== 'raise') {
    return res.status(200).json({ received: true, ignored_product: meta.product || 'unknown' });
  }

  const email        = normalizeEmail(session.customer_email || session.customer_details?.email);
  const customerName = session.customer_details?.name || '';
  const firstName    = customerName.split(' ')[0] || '';
  const profileHash  = meta.profile_hash;

  if (!email) {
    console.error('[raise-webhook] no email in session', session.id);
    return res.status(200).json({ received: true, error: 'no_email' });
  }
  if (!profileHash) {
    console.error('[raise-webhook] no profile_hash in metadata', session.id);
    return res.status(200).json({ received: true, error: 'no_profile_hash' });
  }

  // Plan is generated on-demand via disc_insights — not pre-computed
  let plan = null;
  let stash = null;

  // Assemble obstacle from metadata — works even without stash
  const obstacleFromMeta = {
    code:      meta.obstacle_code      || (stash?.obstacle?.code || ''),
    label:     meta.obstacle_label     || (stash?.obstacle?.label || ''),
    free_text: meta.obstacle_free_text || (stash?.obstacle?.free_text || ''),
  };

  // ── Build paid user record ───────────────────────────────
  const accessToken = mintToken();
  const now         = new Date().toISOString();
  const expiresAt   = new Date(Date.now() + TTL_30_DAYS * 1000).toISOString();

  const userRecord = {
    email,
    first_name:    firstName,
    paid_at:       now,
    expires_at:    expiresAt,
    stripe_session: session.id,
    profile_hash:  profileHash,
    assessment: {
      country:           meta.country,
      company_situation: meta.company_sit,
      last_raise:        meta.last_raise,
      seniority:         meta.seniority,
      company_size:      meta.company_size,
    },
    final_range: {
      floor:   parseInt(meta.final_floor) || 0,
      ceiling: parseInt(meta.final_ceil)  || 0,
    },
    // Round 2 — persist obstacle so coach + paid dashboard can reference it
    obstacle: obstacleFromMeta,
    access_token: accessToken,
  };

  try {
    await Promise.all([
      redis.set(`raise:user:${email}`,         JSON.stringify(userRecord), { ex: TTL_30_DAYS }),
      redis.set(`raise:user:${email}:plan`,    plan ? JSON.stringify(plan) : JSON.stringify({ pending: true }), { ex: TTL_30_DAYS }),
      redis.set(`raise:token:${accessToken}`,  email,                     { ex: TTL_30_DAYS }),
      redis.set(`raise:session:${session.id}`, email,                     { ex: TTL_24_HRS  }),
    ]);
  } catch (e) {
    console.error('[raise-webhook] redis write failed:', e.message);
    // Don't fail the webhook — Stripe will retry if we 500, but data issues are not
    // recoverable via retry. Log and move on so the user can still reach /raise/paid/.
  }

  // ── Referral credit — tracks affiliate conversions in Redis ──
  if (meta.refSource) {
    try {
      const COMMISSION_RATE = 0.40;
      const salePrice  = session.amount_total / 100; // actual charged amount after any coupons/discounts
      const commission = parseFloat((salePrice * COMMISSION_RATE).toFixed(2));
      const todayKey   = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const weekKey    = todayKey; // index by week-start date

      // Total record
      const refRaw = await redis.get(`ref:${meta.refSource}`);
      const ref = refRaw
        ? (typeof refRaw === 'string' ? JSON.parse(refRaw) : refRaw)
        : { source: meta.refSource, conversions: 0, raise_conversions: 0, total_earned: 0, pending_payout: 0, created_at: now };
      ref.conversions       = (ref.conversions || 0) + 1;
      ref.raise_conversions = (ref.raise_conversions || 0) + 1;
      ref.total_earned      = parseFloat(((ref.total_earned || 0) + commission).toFixed(2));
      ref.pending_payout    = parseFloat(((ref.pending_payout || 0) + commission).toFixed(2));
      ref.last_conversion_at = now;
      ref.last_price_usd    = salePrice;

      // Daily record
      const dailyRaw = await redis.get(`ref:${meta.refSource}:daily:${todayKey}`);
      const daily = dailyRaw
        ? (typeof dailyRaw === 'string' ? JSON.parse(dailyRaw) : dailyRaw)
        : { conversions: 0, earned: 0 };
      daily.conversions = (daily.conversions || 0) + 1;
      daily.earned      = parseFloat(((daily.earned || 0) + commission).toFixed(2));

      // Weekly record
      const weekRaw = await redis.get(`ref:${meta.refSource}:week:${weekKey}`);
      const week = weekRaw
        ? (typeof weekRaw === 'string' ? JSON.parse(weekRaw) : weekRaw)
        : { conversions: 0, earned: 0, paid: false };
      week.conversions = (week.conversions || 0) + 1;
      week.earned      = parseFloat(((week.earned || 0) + commission).toFixed(2));

      await Promise.all([
        redis.set(`ref:${meta.refSource}`,                          JSON.stringify(ref),   { ex: TTL_30_DAYS * 12 }),
        redis.set(`ref:${meta.refSource}:daily:${todayKey}`,        JSON.stringify(daily), { ex: 60 * 60 * 48 }),
        redis.set(`ref:${meta.refSource}:week:${weekKey}`,          JSON.stringify(week),  { ex: TTL_30_DAYS * 3 }),
      ]);
    } catch (e) { /* non-fatal */ }
  }

  // ── Log to Google Sheet ──────────────────────────────────
  try {
    const sheetUrl = process.env.CAREER_SHEET_WEBHOOK;
    if (sheetUrl) {
      await fetch(sheetUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          timestamp:     now,
          event:         'PAID',
          product:       'raise',
          email,
          first_name:    firstName,
          country:       meta.country,
          seniority:     meta.seniority,
          company_size:  meta.company_size,
          company_sit:   meta.company_sit,
          last_raise:    meta.last_raise,
          final_floor:   meta.final_floor,
          final_ceil:    meta.final_ceil,
          obstacle_code: meta.obstacle_code || '',
          amountPaid:    `$${(session.amount_total / 100).toFixed(2)} ${session.currency?.toUpperCase()}`,
          price_usd:     meta.price_usd || (session.amount_total / 100),
          stripeSession: session.id,
          refSource:     meta.refSource || '',
          source:        'salary.recomlinked.com',
        }),
      });
    }
  } catch (e) { /* non-fatal */ }

  // ── Send welcome email with 30-day access link ──────────
  try {
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const paidUrl = `${BASE_URL}/raise/paid/?token=${accessToken}`;
      const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

      await resend.emails.send({
        from:    'Milad Bakhti <support@recomlinked.com>',
        reply_to: 'milad.b@recomlinked.com',
        to:      email,
        subject: `Your raise plan is ready, ${firstName || 'there'}`,
        text: `${greeting}

Your raise plan is ready. Here's your link:
${paidUrl}

Bookmark it — you have 30 days to practice the conversation, work through pushback, and talk to your coach anytime.

A personal note:

I built this because I know too many people who deserve a raise and never ask for one. Not because they don't deserve it — because no one ever helped them get comfortable with the ask. If it works for you, I want to hear about it.

My personal email:
milad.b@recomlinked.com

Milad
Co-founder, Recomlinked`,
      });
    }
  } catch (emailErr) {
    console.error('[raise-webhook] email send error:', emailErr.message || emailErr);
  }

  return res.status(200).json({ received: true, processed: true });
};
