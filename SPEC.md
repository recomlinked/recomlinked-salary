# Salary Negotiation Coach — Assessment + Chat Spec

**Status:** Draft v1. Spec covers the full user path from landing page entry to paywall. Content below is tap-ready for implementation once signed off.

**Convention used in this document:**
- **LOCKED** = decided in prior rounds, do not change without discussion
- **DRAFT** = proposal in this document, open to your edits
- **TBD** = still undecided, flagged explicitly

---

## 0. Entry: Hero CTAs (context only)

LOCKED from prior rounds.

Landing page hero offers two CTAs:
1. "Prepare me for a raise at my current job" → `/raise/assessment`
2. "Prepare me for negotiating a new job offer" → waitlist form (email capture only)

This spec covers path 1. Path 2 is a waitlist until 20+ signups.

---

## 1. Assessment — 4 questions, ~25 seconds, tap only

### Q0 — Location

**Question:** "Where are you based?"

**Chips (single select):** `United States` · `Canada` · `United Kingdom` · `Australia` · `Other`

**Why it's first:** sets market norms (anchoring aggressiveness, typical raise %, legal protections, tax treatment of equity vs cash) and lets Claude phrase coaching with regional credibility. "Other" defaults to US-style coaching.

### Q1 — Company situation

**Question:** "How is your company doing right now?"

**Chips (single select):**
- Growing fast
- Stable
- Cutting or restructuring

**Why 3 not 4:** people can almost always pick one of these. Adding "not sure" invites the easiest answer and loses signal.

### Q2 — Last raise situation

**Question:** "When was your last raise?"

**Chips (single select):**
- Still under 1 year at this job
- Got my annual raise, want more
- 1–2 years since my last raise
- 2+ years since my last raise
- Never asked or received one

### Q3 — Seniority + company size (dual column, one tap each)

**Question:** "Tell us about your role."

**Left column — Seniority:**
- Junior (0–3 years)
- Mid-level (3–7 years)
- Senior (7+ years)
- Manager or Lead

**Right column — Company size:**
- Under 50
- 50–250
- 250–1,000
- 1,000–10,000
- 10,000+

**Submit** → save profile to `rl_raise_profile` in localStorage → instant redirect to `/raise/chat` (no loading screen).

---

## 2. Initial range calculation

The initial range comes out of the four assessment answers. It is calculated server-side in `raise-analyze.js` using deterministic rules, then passed to Claude to phrase the reason line. This keeps the math predictable and cheap.

### Tier 1 hard rules (applied in order)

| Condition | Effect |
|---|---|
| Q1 = Cutting | **Ceiling: 42%** |
| Q2 = Under 1 year | **Ceiling: 32%** (overrides Cutting if tighter) |
| Q2 = Got my annual raise, want more | **Range: 35–55%** baseline |
| Q2 = 2+ years since last raise | **Floor: +10pp** |
| Q1 = Growing fast | **Floor: 45%** |

### Baseline range (if no Tier 1 modifier hits)

**40–70%** (30pp wide)

### Seniority / company size modifiers (narrow bands, within caps)

These refine the baseline by a few points — they do not change Tier 1 caps.

- Senior / Manager + 1,000+ company: +3pp to floor (more structured raise processes)
- Junior + under 50: −3pp to ceiling (smaller companies have less standardized raise budgets at junior level)
- Mid-level + 250–1,000: neutral reference point

### Country modifier

- US: baseline (reference)
- Canada: ceiling −2pp (slightly more conservative norms)
- UK: ceiling −3pp (even more conservative raise culture)
- Australia: neutral
- Other: US defaults

### Examples

| Profile | Initial range |
|---|---|
| Cutting + under 1 year + Junior @ 250 + US | 15–32% |
| Cutting + 2+ years + Mid @ 1k + US | 25–42% |
| Growing + 2+ years + Senior @ 1k + US | 55–80% |
| Growing + annual raise + Mid @ 500 + CA | 45–58% |
| Stable + 1–2 years + Mid @ 500 + US | 42–65% |

### Colour coding (applied to the arc/bar)

- Range midpoint **< 40%** → red
- **40–60%** → amber
- **> 60%** → green

---

## 3. Chat page opening sequence

On chat page load, if `rl_raise_profile` exists, fire `raise-analyze.js` and show the thinking screen.

### Thinking screen — items typing/untyping one at a time

Same animated arc SVG as FA product (colour set by calculated midpoint — red/amber/green). Bottom panel visible but dimmed at 0.35 opacity. Placeholder text: "Calculating your probability…"

**Proposed item list (DRAFT, 12 items, typing one at a time on a single line):**

1. Mapping your company situation
2. Factoring in your tenure and timing
3. Reading your regional market norms
4. Calibrating seniority and leverage
5. Weighing company-size effects
6. Checking industry hiring trends in your field
7. Setting your realistic probability floor
8. Setting your realistic probability ceiling
9. Identifying your structural tailwinds
10. Identifying your structural headwinds
11. Preparing your coaching questions
12. Building your personalised range

Purpose: previews the *breadth* of what the product considers. Users who didn't think of "regional market norms" or "industry hiring trends" as raise factors get their first hint of the product's completeness.

### Initial card state

First chat bubble is the **probability card** (not a text message):

- Range in large bold: e.g. "**45–70%**"
- Arc visual coloured per midpoint rule
- Small label: "Raise Probability"
- One-line context below: derived from the strongest Tier 1 factor
  - Examples:
    - "Your company's growth phase gives you a solid foundation to negotiate from."
    - "Recent company cuts limit what's possible, but the picture isn't finished yet."
    - "Two-plus years without a raise is a meaningful point in your favour."

### Opening coach message (types out character-by-character)

**DRAFT:**

> "That's your starting range based on the structural factors. To narrow it and find your specific leverage, I need to understand a few more things about your situation. Four quick questions — no typing required unless you want to add context."

---

## 4. Exchange 1 — Role and industry

### Coach question

**DRAFT:**

> "What's your job title and what kind of company do you work for? Just describe it naturally — like 'Senior FP&A Manager at a mid-stage fintech' or 'Marketing Lead at a retail chain'."

### Input

**Free text only.** No chips. This is the one exchange where we force typing — it's short, it's natural, and it's the richest unstructured-data moment in the funnel.

### What Claude extracts (into accumulated profile for raise-enrich.js)

```
job_title_normalised: string
function: Finance | Product | Engineering | Sales | Marketing | Ops | HR | Design | CS | Legal | Data | Other
industry: SaaS | Fintech | Healthcare | Retail | Manufacturing | Media | Consulting | Government | Nonprofit | Other
company_type: startup | scaleup | public | private-mid | government | nonprofit
seniority_signal_from_text: junior | mid | senior | lead | exec | unclear
```

### Range movement

- Tightens by ~5pp (30pp wide → 25pp wide, typically)
- Ceiling or floor shifts by up to 3pp based on industry heat
- Midpoint can drift ±2pp at most

### Reason line (Claude generates based on extracted function + industry + region)

Examples the prompt should aim for:

- "Engineering roles in SaaS are in a tight labour market right now — your range is tilting upward."
- "Marketing roles in retail face cost pressure — performance framing will matter more than market leverage."
- "Finance roles at public companies tend to have structured raise processes, which rewards prepared asks."
- "Operations in manufacturing is a stable hiring picture — expect the conversation to hinge on tenure and contribution."

---

## 5. Exchange 2 — Performance

### Coach question

**DRAFT:**

> "How would you describe your performance over the last 12 months?"

### Chips (single select, plus free text always available)

- Exceeded expectations
- Had a strong specific win
- Met expectations
- It's been a mixed year

### Free text handling

If user types instead of selecting, Claude classifies into one of the four buckets AND extracts the specific achievement for later use in the paid dashboard's email template and script.

### What Claude extracts

```
performance_rating: exceeded | specific_win | met | mixed
specific_achievements: string[] (if typed)
```

### Range movement

- Tightens by 5–7pp
- **Exceeded:** floor lifts 4–6pp, midpoint moves up, ceiling tightens toward current position
- **Strong specific win:** floor lifts 3pp, reason is about framing
- **Met expectations:** symmetric tighten, midpoint roughly holds
- **Mixed year:** ceiling drops 3–5pp, **floor holds** (see §9 rules), midpoint drifts down at most 2pp

### Reason line examples

- Exceeded: "Strong recent performance gives you a clear case and lifts your floor."
- Specific win: "One clear win often carries more weight than a year of 'good' — we'll centre the conversation on it."
- Met: "Meeting expectations is the baseline — from here, framing and timing do the work."
- Mixed: "A mixed year limits your upside — but the right framing still makes the ask reasonable."

---

## 6. Exchange 3 — Market position and external leverage

### Coach question

**DRAFT:**

> "Do you have a sense of how your salary compares to market rate — and has anyone approached you about other opportunities lately?"

### Chips (single select, plus free text)

- I know I'm underpaid for my role
- I have a competing offer
- I'm being actively recruited
- No external leverage right now

### What Claude extracts

```
market_position: underpaid | at_market | overpaid | unsure
external_leverage: competing_offer | actively_recruited | underpaid_evidence | none
leverage_detail: string (if typed — company names, offer specifics, recruiter frequency)
```

### Range movement

- Tightens by 5–6pp
- **Competing offer:** floor lifts 6–8pp (strongest single variable in negotiation)
- **Actively recruited:** floor lifts 3–5pp
- **Underpaid:** mostly tightens, slight floor lift of 2pp if typed evidence is credible
- **No leverage:** ceiling drops 3pp, **floor holds**

### Reason line examples

- Competing offer: "A competing offer is the single strongest variable in any negotiation — your floor lifts significantly."
- Actively recruited: "Consistent recruiter interest is real leverage, even without a written offer."
- Underpaid: "Market-rate evidence validates the ask even without an external offer — we'll build the data case in the paid plan."
- No leverage: "Without external signal, your case rests on performance and timing. The paid plan shows you how to build leverage in under two weeks."

---

## 7. Exchange 4 — Manager relationship + timing (combined)

This is where we fold timing in. Two short rows of chips on one screen — the user taps one from each. Keeps it to 4 exchanges total.

### Coach question

**DRAFT:**

> "Last one. How's your relationship with whoever decides your salary — and when's your next review or raise cycle?"

### Chips (two rows, one tap each)

**Row 1 — Relationship:**
- Strong — they advocate for me
- Professional but not close
- It's complicated
- Haven't asked before

**Row 2 — Review timing:**
- Review in the next month
- Review in 1–3 months
- Review in 3–6 months
- No set review cycle
- Review just happened

Plus free text (useful for nuance like "my manager was just replaced" or "I'm on a PIP").

### What Claude extracts

```
manager_relationship: strong | professional | complicated | never_asked
review_timing: imminent | soon | distant | none | just_happened
context_detail: string (free text signals)
```

### Range movement — combinatorial

The range tightens to **final 5pp width** at this step. Direction of shift depends on the pair:

| Relationship × Timing | Effect on range |
|---|---|
| Strong + Imminent (1m) | Best case: floor +4pp, ceiling held, tight upper range |
| Strong + Soon (1–3m) | Floor +3pp, tight upper range |
| Strong + No cycle | Floor +1pp, reason = "you'll create the moment" |
| Professional + Soon | Neutral tighten |
| Complicated + Soon | Ceiling −3pp, tight mid range |
| Complicated + Just happened | Ceiling −5pp, floor held |
| Any + Just happened | Ceiling −4pp — hardest timing |
| Never asked + Soon | Floor +2pp (untapped leverage), tight mid |

### Reason line examples

- Strong + imminent: "Good relationship in an upcoming review window is near-optimal timing — your range is at its tight upper end."
- Strong + no cycle: "You'll need to create the moment, but your relationship gives you permission to do that."
- Complicated + soon: "The timing is there but the relationship adds friction — strategy matters more than usual here."
- Any + just happened: "Just after a review cycle is the hardest moment to re-open the conversation. The paid plan covers the specific play that still works here."

---

## 8. Paywall

### Probability card final state

5pp-wide range, e.g. "**56–61%**" — colour by midpoint rule — one-line summary: "That's your realistic probability range with a well-prepared negotiation."

### Paywall message (types out as coach bubble)

**DRAFT:**

> "You're at [X–Y]%. The difference between that and 75%+ almost always comes down to 2–3 specific moves made before the conversation — the exact number to ask for, the opening words, how to handle the three pushbacks you're most likely to hear.
>
> For $49 one-time, you unlock:
> - Your specific raise amount range, with supporting market data
> - The 3 factors holding your probability back — and exactly how to fix each
> - A ready-to-send email template and a spoken opening script, personalised to your situation
> - Role-play mode — practice the conversation with me before you have it
> - 30 days of follow-up coaching as you prepare and execute
>
> This takes 10 minutes of your time and is built around YOUR situation — not generic advice from a Forbes article."

### CTA button

Gold button: **Get My Coaching Plan · $49 →**

### Trust row

Stripe · Secure · One-time payment · No subscription

### What fires on paywall view

- `raise-enrich.js` fires in background (fire-and-forget), generates paid dashboard content using the full accumulated profile, stores in Redis keyed by `raise:enriched:{profile_hash}`
- By the time user completes Stripe checkout, their dashboard is already pre-computed and loads instantly

---

## 9. Range movement rules — canonical

These are the rules Claude must follow for every range update. Centralised here so we can reference them in the API prompt without ambiguity.

**Core principle:** The range **tightens** with each exchange. The **midpoint drifts slowly**. The **ceiling** represents upside (what's achievable with great execution). The **floor** represents foundation (what the structural situation supports).

**Rules:**

1. Initial range width: 20–30pp (set by Tier 1 logic)
2. Each exchange narrows width by 5–7pp
3. Final range width at paywall: **5pp exactly**
4. **The floor never drops below its initial Tier 1 value.** Coaching-fixable weaknesses (mixed performance, no external leverage) cannot lower the foundation — they limit upside instead.
5. Ceiling *can* drop based on weak signals — this represents genuine upside loss.
6. Strong factor signals lift the floor. Weak factor signals drop the ceiling. Mixed signals tighten symmetrically.
7. Midpoint may drift but no more than ±3pp per exchange.
8. Colour (red/amber/green) is set by **current midpoint**, recomputed each update.
9. If any rule would push the midpoint below the initial Tier 1 floor, clamp to the Tier 1 floor.
10. Rounding: always display integer percentages. Internal math in floats, rounded at display time.

**Why this matters:** the user's emotional arc through the free chat should be *"my picture is getting clearer"*, not *"oh no, it's getting worse."* Weak factors get reframed as "the paid plan fixes this" — they never tank the number.

---

## 10. Extraction schema — accumulated profile

Each exchange appends to a single profile object kept in `rl_raise_result`. At paywall, the full object is sent to `raise-enrich.js`.

```json
{
  "assessment": {
    "country": "CA",
    "company_situation": "growing",
    "last_raise": "2_plus_years",
    "seniority": "mid",
    "company_size": "250_1000"
  },
  "range_history": [
    { "step": "initial", "range": [55, 80], "reason": "..." },
    { "step": "ex1", "range": [58, 78], "reason": "..." },
    { "step": "ex2", "range": [60, 75], "reason": "..." },
    { "step": "ex3", "range": [62, 70], "reason": "..." },
    { "step": "ex4", "range": [64, 69], "reason": "..." }
  ],
  "exchanges": {
    "ex1": { "job_title": "...", "function": "...", "industry": "...", "company_type": "..." },
    "ex2": { "performance_rating": "...", "specific_achievements": ["..."] },
    "ex3": { "market_position": "...", "external_leverage": "...", "leverage_detail": "..." },
    "ex4": { "manager_relationship": "...", "review_timing": "...", "context_detail": "..." }
  },
  "final_range": [64, 69]
}
```

---

## 11. What's NOT in this spec (deliberately)

- **Current salary input.** Paid-tier only, asked inside the paid dashboard on first load, not in free chat.
- **Specific dollar amounts.** Paid-tier only.
- **Paid dashboard content sections.** Separate spec — drafted after this is signed off.
- **Landing page copy.** Separate document — drafted after this is signed off.
- **Magic-link re-entry flow for 30-day memory.** Separate spec — drafted after core build is working.
- **Job-offer path.** Waitlist only until threshold hit.

---

## 12. Open items flagged TBD

1. **Exact initial range formula when multiple Tier 1 conditions stack** (e.g., Cutting + 2+ years). Current spec gives directional guidance; I'd like to produce a full lookup table before building `raise-analyze.js` so the math is deterministic and testable. **Can produce this on request.**
2. **Whether Exchange 4's dual-chip UI is one screen or two.** Current spec says one screen, two rows. Worth confirming this doesn't break the existing chip component from FA.
3. **Free-text handling fallback.** If the user types nonsense or something unparseable into Exchange 1, what does Claude do? Proposal: ask once for clarification, then proceed with whatever is extractable.

---

## 13. Build sequence after sign-off

Once you approve this spec, the downstream sequence is:

1. Draft landing page copy (H1, subhead, two CTAs, below-fold sections)
2. Draft paywall copy (currently DRAFT in §8 — may refine after landing page voice is set)
3. Specify `raise-analyze.js` API — deterministic math + Claude for reason line
4. Specify `raise-exchange.js` API — Claude generates range update, reason line, next question, with full profile context
5. Specify `raise-enrich.js` API — paid dashboard generation at paywall
6. Adapt the existing FA assessment HTML page to this spec
7. Adapt the existing FA chat page HTML to support the probability card re-render
8. Adapt `vercel.json` routes
9. Test end-to-end with a handful of profiles
10. Deploy to `salary.recomlinked.com`

Each of those is a discrete task I can produce complete files for.

---

## 14. Implementation status and locked contracts (added post-build)

### V1 — SHIPPED (all three sessions)

- **Session 1 — Backend:** 12 API files + `vercel.json` + README. Syntax validated. Redis key consistency verified across files.
- **Session 2 — Landing + Chat frontends:** `public/raise/index.html` (1,075 lines) + `public/raise/chat/index.html` (1,173 lines). All tags balanced, all enum values match backend contract.
- **Session 3 — Paid + Enter + Waitlist frontends:** `public/raise/paid/index.html` (1,144 lines) + `public/raise/enter/index.html` (246 lines) + `public/raise/waitlist/index.html` (302 lines). All API contracts verified.
- **Final bundle:** `salary-coach-complete.zip` — 20 files, 97KB.
- **Deployment guide:** `GO-LIVE.md` — 8-step checklist from unzip to first paying customer.

### URL finalized

**Production domain:** `salary.recomlinked.com` (not `raise.`)

**Page routes (served from `public/raise/`):**
| Path | Page | Status |
|---|---|---|
| `/raise` | Landing + assessment (merged like FA) | **Built (1,075 lines)** |
| `/raise/chat` | Chat with probability card | **Built (1,173 lines)** |
| `/raise/paid` | Paid dashboard (post-Stripe) | **Built (1,144 lines)** |
| `/raise/enter` | Magic link re-entry | **Built (246 lines)** |
| `/raise/waitlist` | Job offer waitlist | **Built (302 lines)** |

### Assessment enum contract (frontend must send these exact strings)

Session 1 backend validates these exact values. The landing page in Session 2 must emit these strings to `/api/raise-analyze`.

| Field | Allowed values |
|---|---|
| `country` | `us` · `ca` · `uk` · `au` · `other` |
| `company_situation` | `growing` · `stable` · `cutting` |
| `last_raise` | `under_1_year` · `annual_raise_want_more` · `1_2_years` · `2_plus_years` · `never_asked` |
| `seniority` | `junior` · `mid` · `senior` · `lead` |
| `company_size` | `under_50` · `50_250` · `250_1000` · `1000_10000` · `10000_plus` |

### Chat exchange enum contract (Session 3 chat page must send these)

**Exchange 2 (performance) chip values:** `exceeded` · `specific_win` · `met` · `mixed`

**Exchange 3 (market) chip values:** `underpaid` · `competing_offer` · `actively_recruited` · `none`

**Exchange 4 row 1 (relationship):** `strong` · `professional` · `complicated` · `never_asked`

**Exchange 4 row 2 (timing):** `imminent` · `soon` · `distant` · `none` · `just_happened`

**Ex4 submission format:** `{ relationship: "strong", timing: "soon", free_text: "" }`

### localStorage keys (frontend contract)

| Key | Contents | Lifetime |
|---|---|---|
| `rl_raise_profile` | `{ country, company_situation, last_raise, seniority, company_size, savedAt }` | Written on assessment submit, read by chat page |
| `rl_raise_state` | `{ floor, ceiling, color, initial_floor, exchanges: {ex1:{...}, ex2:{...}}, range_history: [...], current_exchange }` | Running state during free chat |
| `rl_raise_access_token` | 32-char hex token (for returning paid users on same device) | Written after Stripe success |

### API contracts (summary — see source files for full)

| Endpoint | Method | Triggered by | Input | Output |
|---|---|---|---|---|
| `/api/raise-analyze` | POST | Chat page load (fresh profile) | Assessment fields | `{ floor, ceiling, color, context_line, first_coach_message, exchange_next }` |
| `/api/raise-exchange` | POST | After each of 4 exchanges | `{ exchange, answer, profile, current_range, initial_floor, accumulated_exchanges }` | `{ floor, ceiling, color, reason_line, extracted, signal, next_question, is_final }` |
| `/api/raise-enrich` | POST | On paywall view (fire-and-forget) | `{ profile, exchanges, final_range, profile_hash }` | `202 { ok: true }` |
| `/api/raise-checkout` | POST | On paywall CTA click | `{ profile_hash, profile, final_range, email?, refSource? }` | `{ url }` (redirect to Stripe) |
| `/api/raise-webhook` | POST | Stripe (automated) | Stripe event | `200` |
| `/api/raise-verify` | GET | Paid page load | `?token=` or `?session_id=` | `{ valid, profile, plan, days_left }` |
| `/api/raise-magic-link` | POST | Enter page submit | `{ email }` | `{ sent: true }` (always, to prevent enumeration) |
| `/api/raise-coach` | POST | Paid chat messages | `{ token, message }` | `{ reply, capped }` |
| `/api/raise-waitlist` | POST | Waitlist email submit | `{ email, context?, refSource? }` | `{ ok: true }` |
| `/api/raise-export` | GET | Data export button | `?token=` | JSON file download |
| `/api/raise-delete` | POST | Account deletion | `{ token, confirm: "yes" }` | `{ ok, deleted }` |

### Profile hash (used for enrichment caching)

The frontend computes a stable hash from `country|company_situation|last_raise|seniority|company_size|ex1_signal|ex2_signal|ex3_signal|ex4_signal` and passes it to both `raise-enrich` and `raise-checkout`. Same hash = same profile = same pre-computed plan.

Simple implementation for the chat page:
```js
function profileHash(p, exchanges) {
  const s = `${p.country}|${p.company_situation}|${p.last_raise}|${p.seniority}|${p.company_size}`
          + `|${exchanges.ex1?.signal || ''}|${exchanges.ex2?.signal || ''}`
          + `|${exchanges.ex3?.signal || ''}|${exchanges.ex4?.signal || ''}`;
  return btoa(s).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
}
```

### Test tokens (for QA — rotate before real traffic)

- **`RAISE-TEST-2026`** — bypasses Stripe. Works on `/api/raise-verify` and `/api/raise-coach`. Returns a fully populated test user + test plan.

### Stripe products registered in env

- `STRIPE_RAISE_PRICE_ID` — $49 USD one-time
- Webhook endpoint URL: `/api/raise-webhook`
- `STRIPE_RAISE_WEBHOOK_SECRET` — from Stripe dashboard after adding webhook
- Both webhooks (FA + raise) receive all events; raise webhook filters by `metadata.product === 'raise'`

### Visual system (reused from FA — do not redesign)

- Background: `#07090f`
- Gold accent: `#c9a84c`
- Teal accent: `#00c4a0`
- Red: `#e05555`
- Text: `#e8eaf2` / muted `#8a90a8` / subtle `#454d60`
- Cards on chat page: white `#ffffff` with `#07090f` score card inside
- Font: `-apple-system, 'Segoe UI', sans-serif`
- `shared.js` loaded on every page for footer + GA4 + Clarity (deferred)

### Locked positioning

- **Product name:** Salary Negotiation Coach
- **Tagline:** Sales coach for non-sleazy people
- **Price:** $49 USD one-time, 30-day coaching window
- **Hero CTAs:** two buttons, parallel format
  - "Prepare me for a raise at my current job" → assessment (opens in new tab)
  - "Prepare me for negotiating a new job offer" → waitlist (opens in new tab)
- **Waitlist threshold to build path two:** 20 signups

---

## 15. Frontend implementation details (Sessions 2 & 3)

Decisions that emerged during the build. Anything in this section overrides the original spec sections above where they conflict.

### `public/raise/index.html` — Landing + Assessment (merged)

**Mode switching via URL param:**
- `/raise/` → shows landing content (hero, sample, how-it-works, value cards, FAQ, bottom CTA)
- `/raise/?start=1` → hides landing, shows assessment directly
- Same file, two modes. Both CTAs open the assessment mode in a new tab.

**Hero:**
- Pill above H1: "A sales coach for non-sleazy people"
- H1 uses gold accent on "getting paid what you're worth"
- Two stacked CTAs. Primary (gold solid): raise path. Secondary (teal outlined): job offer path → waitlist.
- Badges on CTAs: "LIVE" on raise, "SOON" on offer
- Trust line: "FREE TO START · NO EMAIL REQUIRED · 60 SECONDS"

**Animated sample card** (the "watch your range narrow" preview):
- 4 frames cycling every ~2.8s
- Frame 1: 45–65% / Starting point
- Frame 2: 48–62% / Role & industry
- Frame 3: 52–60% / Performance
- Frame 4: 54–58% / Final range (turns teal)
- Starts on IntersectionObserver fire (doesn't burn LCP)
- Color transitions: gold → teal at frame 4

**Sections (below fold):**
1. How it works (3 steps)
2. Free vs Paid value cards (side by side desktop, stacked mobile)
3. "Why this is different" — 5-row old-vs-new comparison table
4. Pitch callout — the "sales coach for non-sleazy people" framing
5. FAQ — 7 items, collapsible
6. Repeat CTA at bottom

**Assessment:**
- Q0 (country) → Q1 (company situation) → Q2 (last raise) → Q3 (seniority + company size, dual column)
- Progress bar above
- Back/Continue navigation
- On submit: writes `rl_raise_profile` to localStorage, redirects to `/raise/chat/` instantly
- Mobile: dual column in Q3 becomes stacked

### `public/raise/chat/index.html` — Chat + Probability Card

**State machine** (`state.current_exchange`):
- `0` → pre-analyze (thinking screen)
- `1` → ex1 active (free text only)
- `2` → ex2 active (chips + free text)
- `3` → ex3 active (chips + free text)
- `4` → ex4 active (dual chips + free text)
- `5` → paywall shown

**Thinking screen:**
- Minimum duration 2.8s (even if API returns faster)
- 12 items from spec § 3, typing in 22ms/char, pause 650ms, typing out 10ms/char
- Arc SVG with color cycle (gold → teal → red → gold) as items progress
- Arc dashoffset shrinks as progress increases
- Bottom input bar dimmed to 0.35 opacity, placeholder "Calculating your probability…"

**Probability card:**
- First bubble, stays in place throughout chat
- Range text (e.g. "56–61%") in 44px bold, colored red/amber/green by midpoint
- Verdict pill next to range: `red=Uphill`, `amber=In play`, `green=Favourable`
- Fill bar below (width = ceiling%), same color as range
- One-line reason below (fades out at opacity 0.2 during update, fades back in)
- 4 pips at bottom (one per exchange), fill gold as each exchange completes

**Card C re-render sequence (on each exchange):**
1. Range text opacity → 0.15, translateY(-4px) for 320ms
2. Swap text, color classes, fill width
3. Fade back to opacity 1
4. Pip for completed exchange fills gold
- Total transition time: ~1.2s

**Exchange UX:**
- Ex1: free text only, no chips. Input placeholder: "Describe your role…"
- Ex2/3: chips + free text both available. Chips fade out (260ms) on selection before user bubble appears
- Ex4: two rows of chips (Relationship / Timing). Auto-submits 240ms after second row selected
- Free text submission path always works — Claude classifies unstructured input

**Paywall:**
- Dark bubble with range readout and 6-bullet value list
- Gold CTA with arrow animation
- Trust row: Stripe · Secure · One-time · No subscription
- On render: fires `/api/raise-enrich` with `keepalive: true` (fire-and-forget)
- On CTA click: calls `/api/raise-checkout`, redirects to Stripe URL

**Error handling:**
- Red-bordered error bubble with "Retry" button
- Analyze fails → retry reruns init
- Exchange fails → retry re-runs same exchange call
- Checkout fails → shows support@recomlinked.com email

**State persistence:**
- `rl_raise_state` saved after every action
- Stores: profile, current_range, current_exchange, accumulated exchange data, initial_floor
- Rehydrates on reload BUT does not fully restore transcript (V1 limitation — user sees current question fresh, card restored)

### `public/raise/paid/index.html` — Paid Dashboard

**Token resolution priority:**
1. `?token=X` in URL (from welcome email or bookmark)
2. `?session_id=X` in URL (post-Stripe redirect)
3. `localStorage.rl_raise_access_token` (returning visitor, same device)
4. Redirect to `/raise/enter/` if none

URL is cleaned (history.replaceState to `/raise/paid/`) after resolving to avoid ugly query strings on bookmarks.

**Plan loading:**
- If verify returns `plan.pending === true`, enters polling state
- Polls `/api/raise-verify` every 2.2s for up to ~33s (15 attempts)
- If still pending after that, shows "Plan is taking longer than usual" message

**Dashboard layout (single scrollable page, not tabs):**
1. **Summary card** (dark, always expanded): probability range, amount range, days left, headline summary
2. **§01 — Top 3 blockers** — each has blocker name, why, and a "Fix" subsection with teal accent
3. **§02 — Opening script** — one-liner + full opener with Copy buttons, plus "Practise this with your coach →" button
4. **§03 — Pushback responses** — 3 cards with quote-styled pushback + response
5. **§04 — Timing recommendation** — gold-tinted callout box
6. **§05 — Email template** — subject row + body card, both copyable
7. **§06 — 30-day prep plan** — 4 week cards with action checklists
8. **§07 — Coach chat** — bubbles + uses sticky input at page bottom
- All sections expandable via accordion header; default expanded

**Salary prompt (first visit):**
- Modal card that appears above Summary card on first load if `rl_raise_salary` not set
- Currency selector: USD / CAD / GBP / AUD / EUR
- Integer amount input
- Skip button available
- On save: stores `{ amount, currency, savedAt }` to localStorage, re-renders Summary
- Salary converts raise percentages into actual money values in Summary card

**Copy buttons:**
- Small button in section header of each copyable item
- On click: uses `navigator.clipboard.writeText` with `document.execCommand('copy')` fallback
- Shows "Copied ✓" in teal for 1.6s, then reverts

**Role-play button (§02):**
- Sends pre-composed message to coach: *"Let's role-play the actual negotiation conversation. You play my manager. Start by opening the meeting naturally, and I'll respond."*
- Coach system prompt handles role-play mode (asks who to play, stays in character until user says "out")

**Coach chat:**
- White bubbles on light grey for coach, navy bubbles for user
- Typing dots indicator while API call in flight
- Expires gracefully if token TTL expires mid-session
- Auto-scrolls to last message when new message appears
- Auto-expands §07 section when user sends a message from input bar

**Settings menu (⋮ top right):**
- Export my data → `/api/raise-export?token=X` opens in new tab (JSON download)
- Update salary → reopens the salary prompt
- Delete my data → shows confirmation overlay, then calls `/api/raise-delete`, clears all localStorage keys, redirects to `/raise/`

**Days-left pill:** top right header, gold background, shows "28 days left" etc.

### `public/raise/enter/index.html` — Magic Link Re-entry

- Single card with email input and submit button
- Security: always shows success state regardless of whether email is registered (prevents enumeration)
- Success state: "If that address has an active coaching window, we've sent a link"
- "Try again" link to re-request with different email
- Footer link: "Haven't started yet? → /raise/"
- Magic link valid 15 minutes (enforced server-side)
- Rate limit 2 minutes between sends per email (enforced server-side)

### `public/raise/waitlist/index.html` — Job Offer Waitlist

- Pill: "COMING SOON"
- H1: "Job Offer Negotiation Coach"
- Explains what's different: counter-offers, equity, sign-on, levelling
- 4-item value list
- Email input (required) + context textarea (optional, 500 char limit)
- Teal CTA (not gold) to differentiate from raise path
- Success state: warm confirmation, mentions Milad personally reads replies
- Footer: prominent link back to raise path for users who landed here by mistake

---

## 16. V1 status — shipped and ready to deploy

- All code written, syntax-validated, contract-aligned.
- Total deliverable: 20 files, ~6,000 lines of new code.
- Deployment checklist: `GO-LIVE.md` (8 steps, 2 hours to first paying customer).
- Next tranche only triggers on real data: funnel metrics, waitlist count, conversion feedback.

### Iteration playbook after launch

1. **Day 1–3:** Watch Vercel logs hourly. Fix any 500s. No copy changes yet.
2. **Day 4–14:** Watch GA4 funnel. Identify biggest drop-off step. Iterate that one step's copy/UX, keep everything else stable.
3. **Day 14+:** If waitlist ≥ 20, build job offer path (one-day build).
4. **Month 2+:** If unit economics clear, expand to UK + Australia (content tweaks only, stack is ready).
5. **Month 3+:** If retention signal exists (users active day 15+), consider subscription pricing for ongoing coaching.

### What to NOT change without a fresh discussion

- Any enum values in `raise-analyze.js` or `raise-exchange.js` (breaks the frontend contract)
- Redis key schema (breaks returning users)
- Stripe metadata fields (breaks webhook)
- localStorage key names (breaks returning users)

Everything else — copy, colors, animation timing, FAQ content, thinking screen items, paywall wording, pushback framing, 30-day plan structure — is safe to iterate live.
