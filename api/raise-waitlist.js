// api/raise-waitlist.js
// Salary Negotiation Coach — Job offer negotiation waitlist
// Captures email addresses for the second product path (new job offer negotiation).
// Sends a confirmation email. Stores in Redis with 90-day TTL.
// When count hits 20+ we build path two; this list becomes the launch list.

const { Redis }  = require('@upstash/redis');
const { Resend } = require('resend');

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TTL_90_DAYS = 60 * 60 * 24 * 90;

function normalizeEmail(e) { return (e || '').trim().toLowerCase(); }

async function logToSheet(payload) {
  try {
    const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
    if (!webhookUrl) return;
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        timestamp: new Date().toISOString(),
        event:     'WAITLIST_SIGNUP',
        product:   'raise_offer_waitlist',
        source:    'salary.recomlinked.com',
        ...payload,
      }),
    });
  } catch (e) { /* non-fatal */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const email    = normalizeEmail(req.body?.email);
  const context  = (req.body?.context || '').toString().slice(0, 500); // optional: what situation they're in
  const refSource= (req.body?.refSource || '').toString().slice(0, 64);

  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const entry = {
    email,
    context,
    refSource,
    signed_up_at: new Date().toISOString(),
  };

  // ── Store individual entry + increment counter ─────────
  try {
    await Promise.all([
      redis.set(`raise:waitlist:${email}`, JSON.stringify(entry), { ex: TTL_90_DAYS }),
      redis.sadd('raise:waitlist:set', email),     // set for counting unique
      redis.incr('raise:waitlist:total'),          // cumulative counter
    ]);
  } catch (e) {
    console.error('[raise-waitlist] redis set failed:', e.message);
    // Continue — we still want to try the email and log
  }

  // ── Log ────────────────────────────────────────────────
  logToSheet(entry);

  // ── Confirmation email ─────────────────────────────────
  try {
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:    'Milad Bakhti <support@recomlinked.com>',
        to:      email,
        subject: "You're on the list — Job Offer Negotiation Coach",
        text: `Thanks for signing up.

We're building a dedicated coaching tool for negotiating a new job offer — specifically the dynamics that don't apply to raise negotiations: counter-offering between competing offers, negotiating equity and sign-on, getting the level bumped, timing the final yes.

You'll hear from us in the next couple of weeks when it's ready.

In the meantime — if you're currently in a live offer negotiation and want to talk it through, reply to this email directly. I'll read every one.

Milad Bakhti
Co-founder, Recomlinked`,
      });
    }
  } catch (e) {
    console.error('[raise-waitlist] email send failed:', e.message);
  }

  return res.status(200).json({ ok: true });
};
