# Salary Negotiation Coach — GO-LIVE CHECKLIST

This is the complete deployment guide. Walk it top to bottom and you're live.

---

## The full file manifest

```
public/
└── raise/
    ├── index.html                     Landing + assessment (Session 2)
    ├── chat/
    │   └── index.html                 Free coaching chat + probability card (Session 2)
    ├── paid/
    │   └── index.html                 Paid dashboard + memory chat (Session 3)
    ├── enter/
    │   └── index.html                 Magic link re-entry (Session 3)
    └── waitlist/
        └── index.html                 Job offer waitlist (Session 3)

api/
├── raise-analyze.js                   Initial range (Session 1)
├── raise-exchange.js                  Per-exchange range update (Session 1)
├── raise-enrich.js                    Fire-and-forget plan generation (Session 1)
├── raise-checkout.js                  Stripe checkout creator (Session 1)
├── raise-webhook.js                   Stripe webhook — filters by metadata.product (Session 1)
├── raise-verify.js                    Token verification (Session 1)
├── raise-magic-link.js                Magic link sender (Session 1)
├── raise-coach.js                     Paid coach chat with memory (Session 1)
├── raise-notes-update.js              Background coach notes maintenance (Session 1)
├── raise-waitlist.js                  Waitlist email capture (Session 1)
├── raise-export.js                    User data export (GDPR) (Session 1)
└── raise-delete.js                    User data deletion (GDPR) (Session 1)

vercel.json                            Updated — preserves FA routes (Session 1)
```

All FA product files stay untouched.

---

## Step 1 — Merge into your repo

1. Unzip Session 1 (`salary-coach-session-1.zip`) — you already have this
2. Unzip the final bundle (`salary-coach-complete.zip` from this session)
3. Copy every `api/raise-*.js` into your `/api/` directory
4. Copy the entire `public/raise/` directory into your `/public/` directory
5. Replace `vercel.json` (the new one preserves all FA routes — review the diff)

**Do not modify any file starting with `career-` or anything under `/public/finance/` or `/public/result/`** — those are the FA product.

---

## Step 2 — Environment variables

Add these to your Vercel project settings (Production + Preview). All the FA ones stay as-is.

### New — required

| Variable | Value | Purpose |
|---|---|---|
| `STRIPE_RAISE_PRICE_ID` | `price_1...` | $49 one-time product price ID (Step 3) |
| `STRIPE_RAISE_WEBHOOK_SECRET` | `whsec_...` | Signing secret for the raise webhook (Step 4) |
| `RAISE_BASE_URL` | `https://salary.recomlinked.com` | Used in emails, redirects |

### New — recommended

| Variable | Value | Purpose |
|---|---|---|
| `RAISE_INTERNAL_KEY` | any 32-char random | Protects the internal notes-update endpoint from abuse |

### Reused from FA — no changes needed

- `ANTHROPIC_API_KEY`
- `KV_REST_API_URL`, `KV_REST_API_TOKEN`
- `STRIPE_SECRET_KEY`
- `RESEND_API_KEY`
- `CAREER_SHEET_WEBHOOK` (now also logs raise events with `product: 'raise'` tag)

---

## Step 3 — Stripe product

1. Stripe Dashboard → **Products** → Add product
2. Name: **Salary Negotiation Coach — Coaching Plan**
3. Pricing: **One-time**, **$49.00 USD**
4. Save → copy the **price ID** (starts with `price_`)
5. Paste into Vercel env var `STRIPE_RAISE_PRICE_ID`

---

## Step 4 — Stripe webhook

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**
2. Endpoint URL: `https://salary.recomlinked.com/api/raise-webhook`
3. Events to listen for: `checkout.session.completed` (only this one)
4. Save → copy the **signing secret** (starts with `whsec_`)
5. Paste into Vercel env var `STRIPE_RAISE_WEBHOOK_SECRET`

**Do not change your existing FA webhook.** Both webhooks will receive all events. The raise webhook ignores non-raise events; the FA webhook will see raise events and create orphan access tokens that harmlessly TTL out in 30 days. This is fine for V1.

Optional cleanup later: add one line to `api/stripe-webhook.js` after the event type check to skip raise events cleanly. The README from Session 1 has the exact one-liner.

---

## Step 5 — Domain

1. Vercel → Project → **Settings → Domains → Add**
2. Enter: `salary.recomlinked.com`
3. Follow DNS instructions Vercel provides (CNAME or A record)
4. Wait for SSL cert issuance (usually 1–2 minutes)
5. Verify: `https://salary.recomlinked.com/raise/` should load the landing page

---

## Step 6 — Smoke test

Walk these in order. Each should pass before the next.

### 6a. Landing page loads
Visit `https://salary.recomlinked.com/raise/`
- ✓ Hero renders with two CTAs
- ✓ Animated sample plays after scroll
- ✓ FAQ expands on click
- ✓ Page scores 90+ on Lighthouse mobile

### 6b. Assessment → chat flow
Click "Prepare me for a raise at my current job" (opens new tab)
- ✓ New tab opens at `/raise/?start=1`
- ✓ Assessment Q0-Q3 tap through works
- ✓ Submit redirects to `/raise/chat/` without a loading screen
- ✓ Chat page shows thinking animation for ~3 seconds
- ✓ Probability card renders with a range, colour-coded
- ✓ Coach message types out character-by-character
- ✓ Exchange 1 (free text) accepts input, range tightens
- ✓ Exchanges 2–3 (chips) work, range re-renders with each
- ✓ Exchange 4 (dual chips) submits when both rows picked
- ✓ Paywall appears after Ex4 with the $49 CTA

### 6c. Test token access
Visit `https://salary.recomlinked.com/raise/paid/?token=RAISE-TEST-2026`
- ✓ Dashboard loads with a test plan (no Stripe needed)
- ✓ Summary card shows 56–61% range
- ✓ All 7 plan sections populate with real-looking content
- ✓ Copy buttons work for scripts and email
- ✓ Coach chat sends messages and receives replies
- ✓ Salary prompt appears on first visit, saves to localStorage

### 6d. Waitlist
Visit `https://salary.recomlinked.com/raise/waitlist/`
- ✓ Form submits without errors
- ✓ Success state shows
- ✓ Email arrives (check your inbox for the "You're on the list" message)
- ✓ Redis `SCARD raise:waitlist:set` returns 1 (+ however many tests you do)

### 6e. Magic link flow
Visit `https://salary.recomlinked.com/raise/enter/`
- ✓ Form accepts email, returns success state
- ✓ No enumeration: try a random email that's NOT paid — same success page

### 6f. Live Stripe test
Use Stripe's test mode first: switch `STRIPE_SECRET_KEY` and `STRIPE_RAISE_PRICE_ID` to test-mode values.
- ✓ Finish an assessment → chat → paywall → click CTA
- ✓ Redirected to Stripe Checkout
- ✓ Complete with test card `4242 4242 4242 4242`
- ✓ Redirected to `/raise/paid/?session_id=...`
- ✓ Dashboard loads with real generated plan (not test fallback)
- ✓ Welcome email arrives within 30 seconds
- ✓ Welcome email contains a working 30-day link
- ✓ Clicking the link from email reloads the dashboard

**When live: switch back to live Stripe keys and do one real $49 purchase yourself as final validation. Refund yourself afterwards.**

---

## Step 7 — Google Ads setup

Once all of Step 6 passes, go live with ads. From the context doc:

**Start with these 3 keywords** (highest volume, low competition):
- `how to ask for a raise` — 18,100/mo
- `how to negotiate salary` — 14,800/mo
- `salary negotiation` — 5,400/mo (+317% trending)

**Add negative keywords immediately:**
`job offer`, `new job`, `job search`, `hiring`, `interview`, `entry level`, `template`

**Landing page for ads:** `https://salary.recomlinked.com/raise/`

**Ad copy starters:**
- "Find out your exact raise probability — free, 60 seconds"
- "Most salary advice is generic. This is built around your situation."
- "What are your real chances of getting a raise? Answer 4 questions."

**Budget:** start at CA$50/day for 5 days. Watch conversion rate. Scale to CA$5k/month if per-sale economics clear.

---

## Step 8 — Rotate the test token before real traffic

In `api/raise-verify.js` and `api/raise-coach.js`, search for `RAISE-TEST-2026` and either:
- Change to a longer random string that only you know, OR
- Wrap the test-token check in `if (process.env.VERCEL_ENV !== 'production')` to disable in prod

Leaving `RAISE-TEST-2026` active in prod means anyone who guesses it can get a free test dashboard. Not a security disaster (no real data is leaked), but clean to rotate.

---

## Monitoring after launch

### What to watch — first 48 hours

- Vercel function logs for `raise-*` endpoints — any 500s, any unusual latency?
- Stripe Dashboard → successful payments
- Redis key counts (via Upstash console):
  - `SCARD raise:waitlist:set` — waitlist growth
  - `GET raise:waitlist:total` — cumulative sign-ups
  - Count of `raise:user:*` keys — paid users
- Google Sheet (if configured) — all events flowing through
- Resend dashboard — welcome emails sending, no bounces

### What to watch — ongoing

- Conversion funnel in GA4:
  - Page view → `assessment_completed` → paywall view → Stripe redirect → `PAID` event
- Waitlist count — if it hits 20, you said you'll build the job-offer path in a day
- Refund rate — if above 5%, the paid plan quality needs work

---

## If something breaks

### Landing page loads but assessment submit does nothing
- Check browser console for errors
- Confirm `rl_raise_profile` is being written to localStorage
- Confirm `/raise/chat/` route exists in `vercel.json`

### Chat page shows thinking screen but never renders card
- Check Vercel function logs for `raise-analyze.js` errors
- Confirm `ANTHROPIC_API_KEY` is set
- Test the endpoint directly with curl (see README Session 1 for test commands)

### Paywall CTA doesn't reach Stripe
- Check Vercel logs for `raise-checkout.js`
- Confirm `STRIPE_RAISE_PRICE_ID` is set and correct
- Confirm `STRIPE_SECRET_KEY` is set

### Payment completed but dashboard shows "expired"
- Check `raise-webhook.js` logs for the specific Stripe session
- Confirm `STRIPE_RAISE_WEBHOOK_SECRET` matches what Stripe is sending
- In Stripe Dashboard → Webhooks → check for failed deliveries and retry

### Coach chat says "expired" for a paid user
- Their 30 days is up, OR
- Redis TTL expired (should match the 30-day window)
- Tell them to email support; you can manually extend `raise:user:{email}` TTL via Upstash console

---

## What's intentionally NOT in V1

Per your "ship first, iterate live" philosophy, these are deferred:

- Job offer negotiation path (waitlist threshold: 20)
- A/B testing infrastructure
- Referral program
- Multi-device sync for coaching state
- Voice input for chat
- Calendar integration ("remind me to follow up")
- Settings page with account details
- Admin dashboard
- SMS reminders

When each of these becomes worth building depends on usage. Ship V1, watch the funnel, prioritise from real data.

---

## Timeline to live

Assuming the codebase is otherwise healthy:

- Step 1 (merge): 10 minutes
- Step 2 (env vars): 5 minutes
- Step 3 (Stripe product): 2 minutes
- Step 4 (webhook): 3 minutes
- Step 5 (domain + DNS): 5–30 minutes (DNS propagation)
- Step 6 (smoke test): 30–60 minutes if careful
- Step 7 (ads): 15 minutes to launch first campaign

**First paying customer possible within 2 hours of starting.**

First 20 waitlist signups trigger building the job offer path — which is a one-day build since the infrastructure is done.

---

## Final sanity check before you hit deploy

- [ ] All 12 API files in `/api/`
- [ ] All 5 HTML files in `/public/raise/` (index, chat, paid, enter, waitlist)
- [ ] New `vercel.json` deployed (verify FA routes still work after deploy)
- [ ] 4 new env vars set in Vercel (production + preview)
- [ ] Stripe product created with correct price ID
- [ ] Stripe webhook pointing at `/api/raise-webhook` with correct signing secret
- [ ] `salary.recomlinked.com` resolves and serves HTTPS
- [ ] Step 6 smoke test passes end-to-end
- [ ] Test token bypassed or rotated before public launch

Once that checklist is green, you're live.

Good luck.
