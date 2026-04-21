# recomlinked-salary

Salary Negotiation Coach — `salary.recomlinked.com`

A free AI-powered assessment that predicts a user's probability of getting a raise, narrows that probability through a live coaching conversation, and unlocks a personalised negotiation plan for $49 USD one-time.

## Stack

- Static HTML/JS on Vercel
- Claude API (Sonnet) for scoring and coaching
- Upstash Redis for session and plan caching
- Stripe for one-time $49 payment
- Resend for transactional email

## Structure

```
api/                 Backend endpoints (12 files)
public/
  index.html         Root redirect to /raise/
  raise/
    index.html       Landing + 4-question assessment
    chat/            Free coaching chat with probability card
    paid/            Paid dashboard with 30-day coaching
    enter/           Magic link re-entry
    waitlist/        Job offer negotiation waitlist
  shared.js          Footer + analytics shim

vercel.json          Routes and function configs
package.json         Dependencies
SPEC.md              Full product spec (reference)
GO-LIVE.md           Deployment checklist
```

## Deploy

See `GO-LIVE.md` for the complete 8-step deployment guide. The short version:

1. Connect this repo to a new Vercel project.
2. Add 4 env vars (`STRIPE_RAISE_PRICE_ID`, `STRIPE_RAISE_WEBHOOK_SECRET`, `RAISE_BASE_URL`, `RAISE_INTERNAL_KEY`) plus the shared ones (Anthropic, Upstash Redis, Stripe secret, Resend).
3. Create the $49 Stripe product and a webhook pointing at `/api/raise-webhook`.
4. Point `salary.recomlinked.com` at the Vercel project.
5. Smoke test with `RAISE-TEST-2026` token at `/raise/paid/?token=RAISE-TEST-2026`.

## License

Proprietary. © Recomlinked Technologies Inc.
