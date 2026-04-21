// api/raise-webhook.js
// Salary Negotiation Coach — Stripe webhook (separate from FA webhook)
// Only processes events where metadata.product === 'raise'.
// Silently ignores all other events (including FA events, if Stripe sends them to this endpoint).
//
// On checkout.session.completed:
//   1. Load enrichment plan from raise:enrich|{profile_hash}
//   2. Create paid user record raise:user:{email}      (30-day TTL)
//   3. Store plan        raise:user:{email}:plan       (30-day TTL)
//   4. Map session→email raise:session:{session_id}    (24h TTL — for paid page to resolve)
//   5. Send welcome email with 30-day magic link
//   6. Log PAID to Google Sheet

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
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

  // ── Load pre-computed enrichment plan ────────────────────
  let plan = null;
  try {
    const raw = await redis.get(`raise:enrich|${profileHash}`);
    if (raw) plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('[raise-webhook] plan fetch failed:', e.message);
  }
  // Non-fatal — paid page will trigger regeneration if plan is missing.

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

  // ── Referral credit (reuses FA referral infra if refSource present) ──
  if (meta.refSource) {
    try {
      const refRaw = await redis.get(`ref:${meta.refSource}`);
      if (refRaw) {
        const ref = typeof refRaw === 'string' ? JSON.parse(refRaw) : refRaw;
        ref.conversions = (ref.conversions || 0) + 1;
        ref.raise_conversions = (ref.raise_conversions || 0) + 1;
        await redis.set(`ref:${meta.refSource}`, JSON.stringify(ref), { ex: TTL_30_DAYS * 3 });
      }
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
          amountPaid:    `$${(session.amount_total / 100).toFixed(2)} ${session.currency?.toUpperCase()}`,
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
        to:      email,
        subject: 'Your Salary Negotiation Coach is ready — 30 days of coaching starts now',
        text: `${greeting}

Your coaching plan is ready, and your coach has been briefed on your specific situation.

Open your plan and start coaching:
${paidUrl}

This link is personal to you and valid for 30 days. Bookmark it — your coach remembers every conversation within this window, so come back as often as you need while you prepare.

Here's the arc I'd suggest:
Week 1 — read your plan, practise your opening with role-play mode, build your evidence.
Week 2 — have informal check-ins with your manager, test the waters.
Week 3 — have the actual conversation.
Week 4 — follow up, counter if needed, lock in the outcome.

A personal note.

I built this because most people I know who deserve a raise don't get one — not because they don't deserve it, but because they never get comfortable asking. If it works for you, I want to know. If something falls flat, I want to know that more.

Reply to this email and I'll read it personally.

Milad Bakhti
Co-founder, Recomlinked

Recomlinked Technologies Inc. · 407 9th Ave SE, Calgary, AB, Canada`,
      });
    }
  } catch (emailErr) {
    console.error('[raise-webhook] email send error:', emailErr.message || emailErr);
  }

  return res.status(200).json({ received: true, processed: true });
};
