// api/raise-webhook.js
// Salary Negotiation Coach — Stripe webhook (separate from FA webhook)
// Only processes events where metadata.product === 'raise'.
// Silently ignores all other events (including FA events, if Stripe sends them to this endpoint).
//
// On checkout.session.completed:
//   1. Create paid user record raise:user:{email}      (30-day TTL)
//   2. Store plan placeholder   raise:user:{email}:plan (30-day TTL)
//   3. Map session→email        raise:session:{session_id} (24h TTL)
//   4. Track affiliate credit   ref:{source}
//   5. Send welcome email with 30-day access link
//   6. Log PAID to Google Sheet
//
// Plan is generated on-demand via disc_insights (raise-coach.js).
// Obstacle is stored from Stripe metadata so coach + paid page can reference it.

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
  // VERSION: 2026-06-13-v4 (with console.log diagnostics)
  // CORS for browser session-logging requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);

// ── Session logging — forward RAISE_SESSION events to Google Sheets ──
  try {
    const peek = JSON.parse(rawBody.toString());
    if (peek && peek.event === 'RAISE_SESSION') {
      const stage = peek.stage || '';
      const product = peek.product || 'raise';

      console.log('[session-log] received:', product, stage);

      const RAISE_ALLOW = new Set([
        'sim_start', 'chips_seen', 'context_added',
        'paywall', 'checkout', 'pdf_download',
        'case_template_selected', 'case_resumed', 'case_paywall_shown',
        'sim_opening_picked', 'sim_reply_tapped',
      ]);

      const isOffer = product === 'offer';
      const isOfferAllowed = isOffer && (
        stage === 'disc_start' ||
        stage === 'offer_complete' ||
        stage === 'offer_verdict' ||
        stage === 'offer_paywall' ||
        stage === 'offer_dropped' ||
        stage === 'checkout' ||
        stage === 'pdf_download' ||
        stage === 'sim_opening_picked' ||
        stage === 'sim_reply_tapped' ||
        stage.startsWith('offer_q_')
      );
      const isRaiseAllowed = !isOffer && RAISE_ALLOW.has(stage);

      console.log('[session-log] product=' + product + ' stage=' + stage + ' sid=' + (peek.session_id||'?') + ' allowed=' + (isOfferAllowed || isRaiseAllowed));

      if (isOfferAllowed || isRaiseAllowed) {
        let body = rawBody.toString();
        if (isRaiseAllowed && stage === 'context_added' && peek.key === 'role') {
          const p = JSON.parse(body);
          p.role = p.value || '';
          body = JSON.stringify(p);
        }
        const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
        if (!webhookUrl) {
          console.error('[session-log] CAREER_SHEET_WEBHOOK not set!');
        } else {
          console.log('[session-log] forwarding to GAS...');
          const gasResp = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          const gasBody = await gasResp.text();
          console.log('[session-log] GAS response:', gasResp.status, gasBody.slice(0,200));
        }
      }
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    console.error('[session-log] error:', e.message);
    /* not JSON — continue to Stripe */
  }


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

  // ── Idempotency: reject duplicate Stripe events ──────────────────
  const eventKey = 'stripe_event:' + event.id;
  try {
    const already = await redis.get(eventKey);
    if (already) {
      console.log('[raise-webhook] duplicate event ignored:', event.id);
      return res.status(200).json({ received: true, duplicate: true });
    }
    await redis.set(eventKey, '1', { ex: 86400 }); // expire after 24h
  } catch(e) {
    console.warn('[raise-webhook] idempotency check failed:', e.message);
    // Continue processing — better to risk a duplicate than miss a payment
  }

  // ── Respond to Stripe immediately (prevents retries from timeout) ──
  res.status(200).json({ received: true });

  const session = event.data.object;
  const meta    = session.metadata || {};

  // CRITICAL: only process raise/offer product events — ignore FA events silently
  const product = meta.product || 'raise';
  if (product !== 'raise' && product !== 'offer') {
    return; // already responded
  }

  const email        = normalizeEmail(session.customer_email || session.customer_details?.email);
  const customerName = session.customer_details?.name || '';
  const firstName    = customerName.split(' ')[0] || '';
  const profileHash  = meta.profile_hash;

  if (!email) {
    console.error('[raise-webhook] no email in session', session.id);
    return; // already responded
  }
  if (!profileHash) {
    console.error('[raise-webhook] no profile_hash in metadata', session.id);
    return; // already responded
  }

  // Plan is generated on-demand via disc_insights — not pre-computed
  let plan = null;

  // Obstacle is embedded directly in Stripe metadata by raise-checkout.js
  const obstacleFromMeta = {
    code:      meta.obstacle_code      || '',
    label:     meta.obstacle_label     || '',
    free_text: meta.obstacle_free_text || '',
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
    product: product,
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
      // Week key = Monday of the current week (ISO), so all sales in the
      // same week accumulate into one record that the stats reader can find.
      const _d = new Date(); _d.setDate(_d.getDate() - _d.getDay() + (_d.getDay() === 0 ? -6 : 1));
      const weekKey    = _d.toISOString().slice(0, 10);

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
          product:       product,
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
      const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

      let emailSubject, emailText;

      if (product === 'offer') {
        const paidUrl = `${BASE_URL}/offer/chat/?paid_token=${accessToken}`;
        emailSubject = `Your Counter Kit is unlocked`;
        emailText = `${greeting}

Your Counter Kit is ready — your ask stack, counter email, pushback playbook, and unlimited recruiter practice for 30 days.

Here's your link:
${paidUrl}

Bookmark it — you have 30 days to practice the call, work through every pushback, and go into that conversation with nothing to surprise you.

A personal note:

I built this because countering an offer is one of the highest-ROI conversations in anyone's career, and almost nobody does it well the first time. If it works for you, I want to hear about it.

My personal email:
milad.b@recomlinked.com

Milad
Co-founder, Recomlinked`;
      } else {
        const paidUrl = `${BASE_URL}/raise/paid/?token=${accessToken}`;
        emailSubject = `Your raise plan is ready, ${firstName || 'there'}`;
        emailText = `${greeting}

Your raise plan is ready. Here's your link:
${paidUrl}

Bookmark it — you have 30 days to practice the conversation, work through pushback, and talk to your coach anytime.

A personal note:

I built this because I know too many people who deserve a raise and never ask for one. Not because they don't deserve it — because no one ever helped them get comfortable with the ask. If it works for you, I want to hear about it.

My personal email:
milad.b@recomlinked.com

Milad
Co-founder, Recomlinked`;
      }

      await resend.emails.send({
        from:    'Milad Bakhti <support@recomlinked.com>',
        reply_to: 'milad.b@recomlinked.com',
        to:      email,
        subject: emailSubject,
        text:    emailText,
      });
    }
  } catch (emailErr) {
    console.error('[raise-webhook] email send error:', emailErr.message || emailErr);
  }

  // ── Read checkout stash to get offer_context (only stored there, not in Stripe metadata) ──
  let offerCtx = null;
  if (product === 'offer' && accessToken) {
    try {
      const stashRaw = await redis.get(`raise:checkout:${session.id}`);
      const stash = stashRaw ? (typeof stashRaw === 'string' ? JSON.parse(stashRaw) : stashRaw) : null;
      if (stash && stash.offer_context) offerCtx = stash.offer_context;
    } catch(e) { console.warn('[raise-webhook] stash read failed:', e.message); }
  }

  // ── Store offer context immediately so email link works on any device ──
  if (product === 'offer' && offerCtx && accessToken) {
    try {
      await redis.set(`offer:ctx:${accessToken}`, JSON.stringify(offerCtx), { ex: 86400 * 30 });
      console.log('[raise-webhook] offer:ctx stored for', accessToken.slice(0,8));
    } catch(e) { console.warn('[raise-webhook] offer:ctx store failed:', e.message); }
  }

  // ── Generate full Counter Kit on payment (offer product only) ──
  if (product === 'offer' && offerCtx) {
    try {
      const BASE_URL2 = process.env.NEXT_PUBLIC_BASE_URL || process.env.BASE_URL || 'https://salary.recomlinked.com';
      fetch(BASE_URL2 + '/api/raise-coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'disc_insights',
          product: 'offer',
          part: 'full_kit',
          offer_ctx: offerCtx,
          blocker: offerCtx.blocker || 'other',
          answers: offerCtx.answers || {},
          dims: offerCtx.dims || {},
          levers: offerCtx.levers || [],
          weaks: offerCtx.weaks || [],
          _store_for: accessToken,
        })
      }).catch(function(e) { console.error('[raise-webhook] kit gen error:', e.message); });
    } catch(e) { console.error('[raise-webhook] kit gen error:', e.message); }
  }

  // Response already sent above
};
