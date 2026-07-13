# FamilyOS — Roadmap Build TODO

**Goal:** Ship every roadmap feature below at **100% fully developed** and **100% wired to
Supabase** (real family-scoped tables + RLS, no mock data). This file is the single source of
truth for the build — work top to bottom, keep it in sync, and don't mark a feature `DONE`
until every box under it is checked.

Companion docs: `docs/FRICTION_BACKLOG.md` (what to fix next) and
`docs/EXPERIENCE_SCORECARD.md` (journey health).

**Definition of "done" per feature (the checklist each one must pass):**
- [ ] **Schema** — additive, idempotent migration with family-scoped RLS via `public.is_family_member`, validated on PG16.
- [ ] **Types** — hand-maintained rows added to `lib/database.types.ts` (`T<Row,Insert,Update>`).
- [ ] **Server lib** — pure/tested logic + Supabase reads/writes (no mock data anywhere in the path).
- [ ] **UI module** — production component, optimistic where sensible, undo/confirm on destructive.
- [ ] **Route** — `app/(app)/dashboard/<feature>/page.tsx` using `requireUserContext()`.
- [ ] **Nav** — entry in `lib/constants/navigation.ts` + Navigation Choices catalog.
- [ ] **Verified** — `tsc`, `eslint`, `vitest`, `next build` all green.

Legend: ☐ open · ◐ partial (scaffolding exists) · ☑ done

---

## 🔒 SECURITY AUDIT — status & remaining items (2026-07-10) — READ FIRST

A dedicated adversarial audit ran over Marketplace, Payments/Stripe, Auth/OAuth, and AI/concierge.
**All identified items are now fixed** (Marketplace authz + PAY-1/PAY-2 in round 1; AUTH-1, PAY-3,
AI-1, PAY-4/5, AI-2 in round 2 — this session). The only remaining action is human-owned: **apply the
coupled migrations `0154`/`0155`/`0156` to prod with the deploy.** **Do not** re-audit from scratch.

**✅ Fixed & merged**
- **Marketplace object-level authz** (SEC-1/SEC-2/REL-1/REL-3/RACE-1/RACE-2, A11Y, img) — PR #281 →
  migration **`0154_marketplace_ownership.sql`** (per-member RLS + ownership-checked RPCs + offer
  hold trigger + unique open-offer index). Item-detail offer inbox #283.
- **PAY-1 — card-authorization overspend** (concurrent auths approved against the same balance).
  Fixed: atomic `wallet_reserve_card_auth` RPC (per-child lock + sufficient-funds check + `processing`
  hold keyed by auth id) → migration **`0155_wallet_auth_holds.sql`**; holds released on capture /
  reversal in `lib/stripe/webhook.ts`. PG16-verified (2nd concurrent auth declined; capture reconciles).
- **PAY-2 — dropped financial events**: money webhook recorded events *before* handling then 200'd on
  error, so a failed capture was never retried. Now `recordEvent` is replay-safe (processing→processed;
  errored/unfinished events reprocessable) and the route returns 500 on handler error so Stripe retries.

**⚠️ Coupled prod migrations — apply with the deployed code** (see `docs/PENDING_PROD_MIGRATIONS.md`):
`0154_marketplace_ownership.sql`, `0155_wallet_auth_holds.sql`, **and `0156_rate_limits.sql`**. Until
applied: marketplace owner accept/withdraw/complete error, card auth holds don't reserve, and the
durable AI rate-limit fails open (in-memory limiter still caps per instance).

**✅ Fixed & merged — round 2 (2026-07-10, this session)** — all remaining audit items closed:
- **AUTH-1 (High)** ✅ — Google Calendar OAuth is now CSRF-safe: `auth/route.ts` issues a random,
  single-use, opaque `state` in an **httpOnly cookie**; `callback/route.ts` verifies `state` against
  the cookie (constant-time) and derives the connected user from the **session** (`getUser()`), never
  from `state`. Closes the calendar-link hijack. (`app/api/google/calendar/auth|callback/route.ts`.)
- **PAY-3 (Med)** ✅ — `app/api/billing/checkout/route.ts` now gates on `isAdmin(ctx.active.role)`
  (only a parent can start a subscription), matching change-plan/cancel.
- **AI-1 (Med)** ✅ — the scam classifier (`lib/guardian/scam-ai.ts`) is prompt-injection-hardened:
  instructions live in the **system** role; untrusted transcript + family context are wrapped in a
  **random-nonce fence** the model is told to treat strictly as data (injection attempts = a scam
  signal, never commands); output is **strictly validated** against known enums so the model can never
  emit an off-list recommendation/scamType/confidence — it only informs the pipeline. `ai-screen.ts`
  got the same defense-in-depth rule. Test `tests/guardian-scam-ai.test.ts` (6) proves the validator.
- **PAY-4 (Low)** ✅ — `/api/webhooks/stripe` (subscription webhook) now dedups by Stripe event id via
  the replay-safe `recordEvent`/`markEventProcessed`/`markEventError` store (reused from PAY-2), and
  returns 500 on handler error so Stripe retries instead of silently dropping. (`markReferralConverted`
  was already idempotent — only acts on `status = 'signed_up'`.)
- **PAY-5 (Low)** ✅ — billing success/return URLs now build from the trusted `NEXT_PUBLIC_APP_URL`
  first, not the caller-controlled `Origin` header (checkout, change-plan, portal).
- **AI-2 (Low)** ✅ — durable, cross-instance rate limiting: **`0156_rate_limits.sql`**
  (`rate_limits` + `rate_limit_hit()` RPC) + `lib/server/rate-limit-db.ts` (fail-open), wired into
  `/api/ai/gift` alongside the per-instance in-memory gate. PG16-verified.
- Verified: tsc · eslint · **vitest (56 existing + 6 new)** · `next build` (218 pages); `0156`
  applied twice on PG16 (idempotent) and exercised.

- Full report + evidence: see session notes. No cross-tenant (cross-family) breach was found; RLS
  isolates families. External AI `fetch`es all target fixed provider hosts (no SSRF).

**Release posture:** card-spend/Issuing safe to ship once `0155` is applied; **AUTH-1 is fixed**, so
Google Calendar linking is safe to expose. Apply `0154`/`0155`/`0156` with the deploy.

---

## 👤 VISITOR INTELLIGENCE / LEAD CAPTURE — coverage matrix (2026-07-11)

Audited the "privacy-first visitor intelligence + lead capture" brief against the codebase. **Most of
it already exists**; the one central gap (consent) is now closed. Honest status below — **not** a
17-phase greenfield build. Pick up the ☐ items directly; don't rebuild the ☑ ones.

| Capability | Status | Where |
|---|---|---|
| Anonymous visitor spine (CDP) | ☑ exists | `mkt_visitors` (0058) + `/api/mkt/track` |
| Session + attribution (source/medium/campaign/landing) | ☑ exists | `mkt_sessions`, `mkt_touchpoints` (0058) |
| Multi-touch + conversion attribution | ☑ exists | `mkt_touchpoints.kind` |
| CRM / marketing contacts | ☑ exists | `crm_contacts`, `crm_deals`, marketing_* |
| Lead capture forms + submissions | ☑ exists | `marketing_forms`, `marketing_form_submissions`, `/api/forms/submit` |
| Segments / suppressions | ☑ exists | `marketing_segments`, `marketing_suppressions` |
| Exit-intent | ☑ exists | `marketing_exit_intent`, `components/marketing/exit-intent.tsx`, `/api/exit-intent/*` |
| Personalization rules | ☑ exists | `marketing_personalization_rules`, `lib/marketing/personalization.ts` |
| A/B experiments | ☑ exists | `ab_experiments`, `ab_events`, `lib/marketing/ab.ts`, `/api/ab/track` |
| Admin marketing intelligence page | ☑ **NEW** | `/admin/marketing/intelligence` + a dedicated **`/admin/marketing/visitor-intelligence`** funnel dashboard (visitors → identified → profiled → scored → hot/qualified) with consent posture + lead-band distribution; `lib/marketing/visitor-funnel.ts` (6 tests) |
| **Granular consent (necessary/analytics/personalization/marketing) + GPC + revocation** | ☑ **NEW** | `mkt_consent_events` (0160), `lib/marketing/consent.ts`, `/api/mkt/consent` |
| **Consent-gated tracking** | ☑ **NEW** | `/api/mkt/track` gates on analytics consent |
| Identity linking (anon → contact) | ☑ **NEW** | `lib/marketing/identity.ts` — on signup/login stitches `mkt_visitors.contact_id` → `crm_contacts` (dedup by email, non-downgrading), carries consent forward (`mkt_consent_events.contact_id`), forks on shared-device 2nd user (rotates anon id). Hooked from login/signup forms + `auth/callback`. 6 tests (`identity-stitch.test.ts`) |
| Progressive profiling UI | ☑ **NEW** | `crm_contact_profile` (0171) + `lib/marketing/progressive-profile.ts` (one-question-at-a-time engine, 10 tests) + `ProfileNudge` card on `/dashboard/settings`; saves role/priority/household/kids/interests, remembers skips |
| Consent banner / preference-center UI | ☑ **NEW** | `components/marketing/consent-manager.tsx` — banner (Accept all / Reject / Manage) + granular preference center wired to `/api/mkt/consent`; anon-id + GPC + local cache in `lib/marketing/visitor.ts`; fires the analytics touch to `/api/mkt/track`; re-openable from the footer |
| **Client visitor spine (anon-id + first-party touch)** | ☑ **NEW** | `lib/marketing/visitor.ts` — durable `bubaly_vid` cookie/localStorage; GPC detect; one consent-gated `/api/mkt/track` touch per session (was: endpoints had no client caller) |
| Lead scoring | ☑ **NEW** | `crm_lead_scores` (0172) + `lib/marketing/contact-score.ts` (0–100 score + itemized ledger, 7 tests) + `contact-score-compute.ts` (gathers sessions/recency/conversions/demo/consent/profile/lifecycle); admin `/admin/marketing/lead-scores` — ranked, expandable "why" ledger, Recompute |
| Abandoned-journey recovery | ☑ **NEW** | beyond checkout: `/api/cron/journey-recovery` sweeps stalled onboarding (`onboarding_abandoned`) + non-converting demo leads (`demo_abandoned`) and fires the follow-up workflow; `lib/marketing/journey-recovery.ts` (windowed selection, 8 tests) + 2 new automation triggers/copy |

**☐ Next (privacy-safe, priority order)**
- ☑ **DONE (2026-07-12)** — Client **consent banner + preference center** (`consent-manager.tsx` +
  `visitor.ts`) calling `/api/mkt/consent`, feeding the resolved analytics flag + GPC to
  `/api/mkt/track`. Marketing never pre-checked; GPC honored silently; 6 tests (`consent-ui.test.ts`).
- ☑ **DONE (2026-07-12)** — Identity stitch on signup/login (`lib/marketing/identity.ts`): sets
  `mkt_visitors.contact_id`, carries consent forward (`mkt_consent_events.contact_id`), dedupes the
  contact by email (non-downgrading), and **forks** (rotates the anon id) rather than merge a second
  person on a shared device. Hooked from the login/signup forms + `auth/callback` (covers password /
  OAuth / magic-link / email-confirm). 6 tests.
- ☑ **DONE (2026-07-12)** — Progressive-profiling capture, one field at a time (`crm_contact_profile`
  0171 + `progressive-profile.ts` engine + `ProfileNudge` on `/dashboard/settings`). ⚠️ apply `0171`.
- ☑ **DONE (2026-07-12)** — Dedicated **`/admin/marketing/visitor-intelligence`** funnel dashboard
  (acquisition funnel + consent posture + lead-score bands), `visitor-funnel.ts` engine (6 tests).
  **The visitor-intelligence / lead-capture lane is now fully ☑.**

**Privacy invariants (already enforced — keep them):** no fingerprinting; no PII from anonymous
visitors; `necessary` always on + non-revocable; `analytics` = first-party legitimate interest (on
until denied/GPC); `personalization`+`marketing_*` strict opt-in; consent is append-only, timestamped,
versioned, revocable (`mkt_consent_events`). **⚠️ Apply `0160_visitor_consent.sql` to prod with the deploy.**

**☑ NEW (2026-07-11) — Demo email gate + upgrade exit (lead capture on the demo):** the one-click
**Test Account** demo now opens behind a **blurred email-capture pop-up**; the 5-minute clock only
starts once the visitor enters an email (stamped on `demo_sessions.email` — an identified-lead
signal). When the clock runs out the app blurs again behind an **upgrade pop-up** (Free 5-day /
Family Basic / Family+ → routes into signup). Files: `components/demo/demo-experience.tsx`,
`app/(marketing)/demo/actions.ts` (`startDemoClockAction`, `choosePlanAfterDemoAction`),
`lib/demo/session.ts` (deferred clock + abandoned-session reaping). **⚠️ Apply
`0161_demo_session_email_gate.sql` to prod with the deploy** (nullable `expires_at` + `email`).
Follow-up (◐): stitch the captured demo email into `crm_contacts` / `mkt_visitors` for real lead flow.

**☑ NEW (2026-07-11) — Demo is now ONE shared "Bubaly Demo" account (supersedes the throwaway-user
model above).** Owner directive: *"a Single Demo User, no other Demo Users, called Bubaly Demo; use
all the seed data for this single account."* Implemented (commits `f942a28`, `4139d89`, `e9dbebc`,
`dc02676` on `main`):
- **Single account, not per-visitor users.** `lib/demo/session.ts` rewritten: `ensureDemoAccount()`
  get-or-creates exactly **one** auth user `demo@demo.bubaly.app` (`full_name`/family name = **"Bubaly
  Demo"**), found by the stable family name so it's **reused, never duplicated**. Family+ subscription +
  owning member + active-family pref set on first run only. **No new migration** — reuses the existing
  `demo_sessions` schema (`0138` + `0161`).
- **Fresh every login.** `resetDemoData()` wipes the seed-scoped tables (`SEED_TABLES`, children-first)
  and re-seeds via `seedDemoFamily()` on each `startDemoAction`, so every visitor lands on a pristine,
  fully-seeded demo (self-heals the shared account).
- **Seed expanded to ~200 rows.** `lib/demo/seed.ts` now populates every Family+ surface (calendar 24 ·
  transactions 24 · bills 12 · reminders 14 · pantry 20 · goals 10 · documents 10 · maintenance 8 ·
  family_facts 12 · budgets/accounts · meals+plans+votes · groceries · chores · polls · marketplace
  listings+saves+reviews · autopilot/approvals/agent activity). Column choices mirror the PG16-validated
  `seed_demo_account.sql`; every insert best-effort (schema-drift safe). *(Previously the one-click demo
  seeded only ~30 rows → empty Home. Fixed.)*
- **No teardown.** `endDemoSession()` no longer deletes anything — it only clears the `demo_sessions`
  row (`expires_at`/`email` → null) so the next visitor gets a fresh email gate; the cron
  (`/api/cron/demo-cleanup` → `cleanupExpiredDemoSessions`) does the same for expired clocks. Sign-in
  rotates a random password per login with a one-shot retry (`rotateDemoPassword`) to absorb a
  concurrent-login race — **no stored secret**.
- **Email gate + 5-min countdown + upgrade pop-up (#292) unchanged.** Trade-off (by design): concurrent
  visitors share the one account's live data between re-seeds; the old per-tester isolation is gone.
- **Pricing card** (`app/(marketing)/pricing/pricing-content.tsx`): renamed **"Test Account" →
  "Demo Account"**, dropped the inaccurate **"No email"** copy → *"No card needed — logs you straight
  into full Family+."*, and **floated the card to the LEFT of the hero title** (single 3-col grid
  `[card | hero+toggle | spacer]`, card vertically centered; stacks on mobile).
- **Docs:** `docs/demo-mode.md` rewritten to describe the single-account model.
- ⚠️ **Left-over cleanup (owner, optional):** old ephemeral `demo-<token>@demo.bubaly.app` auth users
  from the previous model may still linger in Supabase Auth — harmless, bulk-deletable.
- ⚠️ **Coordination note for other bots:** a parallel session has an **unmerged branch** reworking the
  pricing hero layout (`pricing-content.tsx`). If it lands it will likely conflict with `dc02676` on
  that file — reconcile carefully (keep the "Demo Account" copy + card-left-of-hero layout).

**☑ NEW (2026-07-11) — Demo DEEP DIVE: seed expanded to ~350 rows + two silent-empty surfaces fixed
(`claude/demo-deepdive`).** Turned over every rock in the Bubaly demo. Findings + fixes:
- **BUG (fixed): Tasks + Groceries surfaces were silently EMPTY.** `todo_items`/`grocery_items` require
  a parent list (`list_id NOT NULL`) that the seed never created, so every best-effort insert failed
  silently → two empty modules for every demo visitor. Now seed a parent `todo_lists` / `grocery_lists`
  first and stamp `list_id`; `todo_lists.created_by` correctly targets `family_members.id` (not
  `auth.users`) via the owning member.
- **Coverage went from ~30 → ~52 tables (~350 rows).** Added health (medications · appointments ·
  health_visits · immunizations), kids/school (homework · classes · teams · wishlist · screen_time ·
  journal), home (pets · vehicles · home_warranties), trips (vacations · trips), relationship_dates,
  notes, reminder_lists, and family economy (currency + rewards). Every table/column verified against
  `lib/database.types.ts`; enums validated on PG16 so no more silent drift.
- `SEED_TABLES` (`lib/demo/session.ts`) rewritten in strict child-before-parent delete order so the
  per-login reset wipes the new tables cleanly (items before lists, rewards before currency).
- Now a demo visitor can exercise **the whole platform**, not a third of it. tsc clean.

**☑ NEW (2026-07-11) — Payment is now ONE TAP from the demo (account creation + payment super easy).**
The demo→upgrade→signup→billing path used to **drop the plan the visitor already chose**: picking
"Family+" in the end-of-demo pop-up sent them to `/dashboard/billing?view=manage` where they had to
re-find and click the plan. Now the choice is carried the whole way and checkout opens automatically:
- `choosePlanAfterDemoAction` builds `redirect=/dashboard/billing?view=manage&checkout=<plan>` (was
  just `view=manage`), so the plan survives signup (works across email · phone · Google · Apple — the
  signup form + `/auth/callback` both honor `next`/`redirect` verbatim).
- `BillingModule` reads `?checkout=basic|plus`: once the auto-provisioned family + subscription load and
  the family is still on Free, it fires `changePlan(<tier>_monthly)` **once** (admin-only) → Stripe
  Checkout opens straight away. New accounts get a family auto-provisioned by `requireUserContext`, so
  the order signup→billing→Stripe just works. Falls back to a highlighted, scrolled-to plan card if
  auto-checkout can't run (non-admin / already subscribed). tsc + eslint clean.

**☑ NEW (2026-07-11) — Demo deep-dive pass 2: five more surfaces that read live tables but had no seed.**
Found by cross-referencing every module's `.from()` reads against the seed. Added (columns verified
against migrations + `database.types.ts`; FK targets checked so nothing silently fails):
- **chore_assignments** — chores are now *assigned to kids* with a status spread (todo→approved), so the
  Chores board shows who's doing what (was: chores existed but looked unclaimed). `chores` insert made
  capturing to get ids.
- **savings_goals** — 5 goals so Finances → **Savings** tab isn't empty (distinct from the Goals module).
- **routine_templates** (+ **routine_template_items**) — Morning & Bedtime routines with 4 steps each, so
  the Routines panel renders a real day.
- **family_memories** (6) + **family_milestones** (4) — the grandparent-portal / planning memory surfaces.
- `SEED_TABLES` extended in child-before-parent order (chore_assignments before chores,
  routine_template_items before routine_templates). tsc + eslint clean.

---

## 🚀 INDUSTRY-FIRST CAPABILITIES — gap matrix vs. the codebase (owner directive, 2026-07-12)

Owner shared 10 "features no competitor offers" and asked: capture them, gap-audit each against the
project, and build what's missing (Supabase-wired, 500-row seed, world-class, AI-driven, mobile-first).
Audited the routes — **9 of 10 already have a real surface**; depth varies. **The one true greenfield
gap is #10 (Family App Store).** Build order below; keep each slice small + verified (PG16 seed + tsc/
eslint/vitest/next build), ship to `main`.

| # | Industry-first capability | Status | Where it lives / gap |
|---|---|---|---|
| 1 | AI **completes** life administration (not just reminds) | ◐ partial | `/dashboard/agents`, `/dashboard/concierge`, `/dashboard/decisions`, `/dashboard/prep-plans`, `agent_activity`. Autonomous *execution* (vs. surfacing) is the deepen target. |
| 2 | **One phone # + one family email** managed by AI | ☑ exists | `/dashboard/front-desk`, `app/api/concierge-calls`, guardian inbound SMS/voice/WhatsApp (Twilio-verified), `/dashboard/inbox`. |
| 3 | AI **negotiates** appointments / bookings / schedule changes | ◐ partial | Concierge surface exists; true agentic negotiation loop is the deepen target (needs the outbound-call/agent tooling). |
| 4 | AI handles **forms / paperwork / insurance / school packets / registrations** | ☑ **DONE** (2026-07-12) | **Paperwork Inbox** `/dashboard/paperwork` (`0169_paperwork_items`, RLS): capture → **triage** (`lib/paperwork/triage.ts`, pure, 9 tests: kind/dates/amount/actions/urgency) → **one-tap materialize** each action into a real `calendar_events` / `family_reminders` row (idempotent, auditable) → status lifecycle. Mobile-first module + composer; wired into front-desk + inbox; seed `seed_paperwork.sql` (500). **NEW: AI draft-reply** — `draftPaperworkReplyAction` (key-gated via `isAIConfigured`, grounded only in captured text, honest fallback) drafts a ready-to-send reply the parent can copy/edit ("AI fills it out for you"), stored on `meta.draft_reply`. |
| 5 | Unified **household CRM** for every relationship (schools, doctors, contractors, clubs) | ◐ partial | `/dashboard/connections` (`family_connections`), `family_contacts`, `/dashboard/relationship`. Not yet a first-class relationship-CRM with per-entity timelines. |
| 6 | **Verified buy/sell/borrow/rent marketplace** in family workflows | ☑ **DONE** | `/marketplace` — hardened + world-class this session (photos, item detail, storefronts, trust, offers, RLS ownership). |
| 7 | **AI family chief of staff** coordinating specialized AI agents | ☑ exists | `/dashboard/agents`, chief-of-staff via `/dashboard/graph` + reasoning, `agent_activity` orchestration. |
| 8 | **Household financial copilot** integrated with scheduling + life events | ◐ partial | Wallet/Finances (`/dashboard/billing?view=manage`), `app/api/ai/wallet`, `life_event_plans`. Tighter schedule↔money↔life-event linkage is the deepen target. |
| 9 | **Predictive family planning** — identify problems before they occur | ☑ exists | `/dashboard/family-signals`, `daily_insights`, `/dashboard/family-digital-twin`, `/dashboard/prep-plans`. |
| 10 | Open **"Family App Store"** for AI-powered extensions | ☑ **DONE** (2026-07-12) | `/dashboard/app-store` — catalog (`family_apps`) + `family_app_installs` (RLS), `lib/appstore/catalog.ts` (+8 tests), install/uninstall/toggle actions, mobile-first grid + "Recommended for your family" rail + Installed section. Migration `0165`, seed `seed_family_apps.sql` (500 apps, 12 categories) in `SEED_ALL.sql`. PG16-verified. **Nav:** not added to the global sidebar (standing rule — owner to add `/dashboard/app-store` if desired). |

**▶ #10 Family App Store — build spec (start here, next session):**
- **Schema** (new migration, additive/idempotent, family-scoped RLS via `is_family_member`):
  `family_apps` (catalog: slug, name, tagline, description, category, icon/emoji, publisher, capabilities[],
  is_official, status) + `family_app_installs` (family_id, app_id, installed_by, enabled, config jsonb, Stamps).
  Catalog readable by any signed-in user; installs family-scoped.
- **Types** in `lib/database.types.ts`; **pure lib** `lib/appstore/*` (catalog filter/rank, install-state) + tests.
- **Route** `/dashboard/app-store` (browse catalog, categories, install/uninstall, "installed" tab) — mobile-first,
  AI-driven (each app declares AI capabilities; feature a "recommended for your family" rail off signals).
  Server actions `installApp`/`uninstallApp`/`toggleApp`. Wire installed apps into a launcher/nav rail.
- **Seed** `seed_family_apps.sql` — **500** catalog entries across categories (calendar, meals, chores, school,
  sports, health, finance, travel, safety, AI-agents…), each with real metadata so the store renders at volume;
  add to `SEED_ALL.sql`. PG16-verify.
- Verify gate + ship. Then loop back to deepen the ◐ partials (execution loop for #1/#3, paperwork inbox #4,
  relationship-CRM timelines #5, schedule↔money linkage #8).

---

## ★ NORTH STAR — The Family Operating Layer (category-defining, 2026-07-05)

> **Thesis:** today's products (ours included, so far) are **systems of record** — they
> store calendars, lists, notes. Bubaly's category-defining move is to become a **system of
> execution**: an AI-native operating layer that actively helps families *get things done* and
> **measurably reduces time spent on family administration**. The defining metric is NOT daily
> active users — it's **hours of coordination/decision effort removed**. Don't compete
> feature-for-feature; define the category others chase.

---

## ★★ STRATEGIC ALIGNMENT — MOATS OVER FEATURES (owner directive, 2026-07-07) — READ FIRST

> **Owner directive (verbatim intent):** *"I would not pursue more features next. I would pursue
> platform moats. Anyone can copy features in 6–18 months; it's much harder to copy the underlying
> intelligence and infrastructure that makes those features work."*
>
> **This section now governs the roadmap.** The competitive review confirms it: Bubaly's public
> feature matrix already **out-covers Cozi / FamilyWall / OurHome** on nearly every row — more
> features is NOT the gap. The gap is the **moat underneath** and making the highest-value surfaces
> *findable and coordinated*. **Freeze net-new feature modules.** New work must deepen one of the five
> ownable layers below or it doesn't ship.

**The five layers to OWN (this is the scoring rubric for any proposed work):**
1. **Own the data model** — the Family Knowledge Graph (the brain).
2. **Own the intelligence layer** — the Family Reasoning Engine.
3. **Own the experience** — intent-based, AI-first journeys ("one assistant coordinates the rest").
4. **Own the ecosystem** — orchestrate the services families already use (don't duplicate them).
5. **Own the category** — measure success in **reduced mental load / time saved**, not app time.

### ▣ Honest audit — what's BUILT vs. the real GAP (as of 2026-07-07)

| Strategy layer | Built (this is real) | The moat gap that must close |
|---|---|---|
| **1. Knowledge Graph** | `0129` `graph_entities`/`graph_edges`, `lib/graph/reason.ts` (16 tests), twin projector, `/dashboard/graph`. | **The graph is a standalone page, not the brain.** Only **4 files** touch `lib/graph` (the graph page/module, the projector, one agent helper). FOI, Concierge, Briefing, Playbook, Calm, Decisions, Prep-Plans, Outcomes, Moments all still read **isolated tables**. The graph must become the substrate every capability reasons over. |
| **2. Reasoning Engine** | FOI + orchestrator questions, agents roster, decisions, prep-plans, autopilot — good *engines*, individually tested. | **No single reasoning engine.** ~8 engines each answer part of "what matters / what's likely forgotten / highest-impact / auto-completable / who needs help / what next" from their own inputs. Consolidate into ONE `lib/reasoning/*` core that reads the graph + snapshot and every surface consumes. |
| **3. Experience (one assistant)** | 26 AI/reasoning routes: assistant, agents, concierge, command-center, calm, graph, decisions, prep-plans, intelligence, outcomes, operating-index, moments, briefing, autopilot, front-desk, inbox, readiness, next-best-actions, weekly-briefing, family-ai-assistant, family-digital-twin, family-memory, knowledge, family-knowledge-graph, playbook… | **This is the biggest misalignment.** The strategy is *"users interact with ONE assistant; it coordinates the rest."* We shipped 26 separate destinations — with **duplicates** (two knowledge-graphs, two assistants, two memory pages). Consolidate into **one Chief-of-Staff front door**; demote the rest to internal capabilities it calls. |
| **4. Ecosystem** | `0128` connections hub, 11-provider registry, Connect/Disconnect CRUD, `/dashboard/connections`. | Hub + model are ready but **no live OAuth/token exchange or two-way sync** — it's a directory, not an orchestrator. Needs provider keys (owner) + per-provider sync adapters (agent). |
| **5. Category metric** | FOI measures household *functioning*; journey/onboarding telemetry exists. | **The North-Star metric isn't in the product.** No surfaced "time saved / decisions handled for you / mental load reduced." Only marketing copy says it. Instrument + surface it. |
| **Family Intelligence** | Playbook learns favorite meals/grocery staples/favorites/traditions/travel. | Strategy wants the *harder* signals: **which reminders get ignored, when the family is most stressed, which chores create conflict, which routines actually work, communication style.** Expand the learning surface (transparent + editable). |
| **Moments** | `lib/moments/*` engines + `/dashboard/moments`. | Moments is **one page among 70 modules**, not the organizing principle. Strategy: *"organize by moments, not modules"* (Morning · School · Dinner · Vacation · Birthday · Moving · Holiday · New Baby · Graduation · Emergency · Weekend). Elevate to a first-class organizing layer. |
| **Chief of Staff** | Autopilot (≥90%-conf auto-exec), Calm digest, agents. | ✅ **CLOSED (2026-07-12, `f03500f`)** — Home now IS the assembled front door: greeting → AskBar → FrontDoorHero with **one-tap Approve/Decline in place** (canonical `decideApprovalAction`: multi-approver, audit-logged, auto-executes approved payloads; manager-only, optimistic) and "done for you" merging autopilot auto-executions (undoable) **with specialist-agent completions** (`mergeHandled`, pure + tested) → time-saved metric → time-of-day focus. |

### ▶ THE REALIGNMENT BACKLOG (do these INSTEAD of new features — priority order)

**◆ LIVE STATUS ROLL-UP (updated 2026-07-09) — 22 of 22 backlog items shipped. R9's buildable-now slice (the adapter contract) is done; live Microsoft/Apple sync flips on when the owner provisions provider OAuth keys (B3).**

| # | Item | Phase | Status | Migration | Seed |
|---|------|-------|--------|-----------|------|
| R1 | `lib/reasoning/context.ts` — one graph-backed context loader | P1 | ✅ Shipped | — | `seed_reasoning_context.sql` |
| R2 | Re-point existing engines at the graph | P1 | ✅ Shipped | — | — |
| R3 | Auto-maintain the graph on-dirty | P1 | ✅ Shipped | `0134` | `seed_model_dirty.sql` |
| R4 | Consolidate 26 surfaces → one Chief-of-Staff home | P2 | ✅ Shipped | — | — |
| R5 | The proactive front door | P2 | ✅ Shipped | — | `seed_front_door.sql` |
| R6 | Intent-based entry (Home AskBar) | P2 | ✅ Shipped | — | — |
| R7 | **Unify the reasoning engine (one core, six Qs)** | P3 | ✅ **Shipped 07-08** | `0149` | `seed_reasoning_snapshots.sql` |
| R8 | Deepen twin simulation (full activity projection) | P3 | ✅ Shipped 07-08 | `0147` | `seed_twin_simulations.sql` |
| R9 | Per-provider sync adapters (OAuth two-way) | P4 | ✅ **Contract shipped 07-09** (live sync key-gated, B3) | — | `seed_sync_microsoft.sql` |
| R10 | Family Intelligence — the hard signals | X-cut | ✅ Shipped | `0142` | `seed_family_signals.sql` |
| R11 | The category metric — "time saved / mental load" | X-cut | ✅ Shipped | — | `seed_time_saved.sql` |
| R12 | Moments as an organizing layer | X-cut | ✅ Shipped 07-08 | `0148` | `seed_moment_activations.sql` |
| T1 | Value-first onboarding re-sequence | P1 | ✅ Shipped | `0138` | (import-driven) |
| T2 | First-run "instant briefing" builder | P1 | ✅ Shipped | `0139` | `seed_meal_ideas.sql` |
| T3 | New-family home = outcome, never empty | P1 | ✅ Shipped | `0140` | `seed_home_briefs.sql` |
| T4 | Insight-of-the-day | P1 | ✅ Shipped | `0141` | `seed_daily_insights.sql` |
| T5 | Partner-tone pass | P1 | ✅ Shipped | — | `seed_notifications.sql` |
| T6 | AI-facilitated group decisions | P2 | ✅ Shipped | `0142*` | `seed_group_decisions_one_family.sql` |
| T7 | "Why this?" everywhere | P2 | ✅ Shipped | `0143` | `seed_ai_feedback_one_family.sql` |
| T8 | Premium-consistency sweep (Experience Scorecard) | P2 | ✅ Shipped | `0144` | `seed_experience_audits_one_family.sql` |
| T9 | "What Bubaly has learned" + life-event templates | P3 | ✅ Shipped | `0145` | `seed_life_events_one_family.sql` |
| T10 | TTFV metric (signup→first outcome) | Instr. | ✅ Shipped | `0146` | `seed_activation_events.sql` |

> **All 22 backlog items are now built.** R9's engineering slice — the provider-agnostic adapter
> contract, the generic two-way engine, the Google + Microsoft adapters, the registry, and the
> `/api/sync/run` wiring — shipped 07-09. What remains is **owner-only**, not code: provisioning the
> per-provider OAuth client keys/secrets (see §B / decision B3) flips live Microsoft (and, once its
> adapter drops in, Apple/CalDAV) sync on. All migrations `0138–0149` are ⚠️ **pending apply to prod**
> — see `docs/PENDING_PROD_MIGRATIONS.md`.

**P1 — Make the Knowledge Graph the brain (Phase 1; 6–12mo moat).**
- [x] **R1. `lib/reasoning/context.ts`** ✅ — one graph-backed context loader every AI surface calls.
  `loadFamilyContext(supabase, familyId)` → graph (entities + edges) + live household snapshot +
  operating index, assembled by a pure, DB-free core (`assembleFamilyContext` + `entityForRow` row→node
  join, `relatedTo`, `impactFrom`, `contextSummary`; **10 tests**). Shared `loadFamilyGraph` now backs
  the Agents/Chief-of-Staff page (replacing its inline graph load) and a new reasoning-summary strip on
  `/dashboard/graph`. Seed `seed_reasoning_context.sql` (500 entities + members, ~520 edges, hub +
  chain + orphans, ref-linked mirrors). Next: **R2** re-points the other engines at this loader.
- [x] **R2. Re-point existing engines at the graph** ✅ — FOI, Concierge, Briefing, Playbook, Calm,
  Decisions, Prep-Plans, Outcomes read graph relationships (Emma→Soccer→Field→Weather→Dinner) instead
  of isolated `.from()` calls. No new tables; rewire reads. Shipped one engine at a time behind tests.
  **Started:** pure `lib/reasoning/insights.ts::reasoningInsights(ctx)` (hub / ripple = graph × snapshot /
  coverage; **4 tests**) built on R1's `FamilyContext`, and **Calm re-pointed** — the one prioritized
  inbox now folds a `graph` source (relationship insights) alongside agents/autopilot/FOI/approvals/
  reminders. Seed `seed_reasoning_insights.sql` (named hub + 500 entities + ~540 edges + orphans).
  **+ Agents / Chief of Staff re-pointed** onto the SAME shared engine (`loadFamilyContext` +
  `reasoningInsights`), retiring the bespoke `lib/agents/graph-insight.ts` (dedup) and gaining the
  graph×snapshot ripple insight. Two engines now share one relationship-reasoning core.
  **+ Daily Briefing re-pointed** — the morning briefing renders a graph-backed "Relationships"
  section (`components/reasoning/relationship-insights.tsx`, server-computed via `reasoningInsights`,
  passed into `BriefingModule` like `recap`). **+ Concierge + Outcomes re-pointed** — both server
  pages render the shared `RelationshipInsights` card above their module via one `loadFamilyContext`
  call. **+ Decisions + Prep-Plans + Playbook re-pointed** (same shared card). **+ FOI re-pointed** via
  `graphReasoningInsights(graph, band)` — a lean second entry point that reuses FOI's already-computed
  band (no double `buildSnapshot`); `reasoningInsights(ctx)` and it share one rule set. **DONE: all 9
  surfaces** reason over the graph through one core (Calm · Chief of Staff · Briefing · Concierge ·
  Outcomes · Decisions · Prep-Plans · Playbook · FOI). Next: **R3** (auto-maintain the graph on-dirty).
- [x] **R3. Auto-maintain the graph** ✅ — the `family_model_dirty` trigger (`0134`) flags changes;
  the graph now re-projects itself with no manual "Rebuild". Two layers: (1) the `model-refresh` cron
  already re-projects dirty families twice daily (backstop); (2) **new on-read auto-refresh** — every
  graph read (`loadFamilyGraph`, now used by all 9 R2 surfaces) checks the dirty flag and, if dirty past
  a cooldown, re-projects the twin in the BACKGROUND via Next `after()` (post-response, no page
  slowdown) then clears the flag. Pure throttle `shouldAutoRefreshGraph` (dirty AND cooled-down; 4
  tests); server `lib/reasoning/auto-refresh.ts` (fire-and-forget dynamic import keeps `context.ts`
  test-pure). Seed `seed_model_dirty.sql` (500 `family_places` → fires the trigger → materialize on next
  read). tsc/eslint/**2065 tests**/build green.

**P2 — One assistant / AI Operating Layer (Phase 2; 6–12mo, category-defining).**
- [x] **R4. Consolidate the 26 surfaces into ONE Chief-of-Staff home** ✅ — a single assistant that
  *coordinates* the specialist engines (agents/FOI/concierge/prep-plans/calm) behind one interface.
  The others become tabs/capabilities it routes to, not top-level nav. **De-duplicate first**
  (merge graph+family-knowledge-graph, assistant+family-ai-assistant, knowledge+family-memory).
  **De-dup DONE:** `family-ai-assistant` → `assistant` (literal dupe); `family-knowledge-graph` →
  `graph` (second view of the same graph tables); `family-memory` → `memories` (its family_memories
  journal + milestones already surface on grandparent-portal/planning, so non-lossy). All removed from
  nav / feature-catalog / service-categories. `knowledge` (family_facts) intentionally kept — it's
  facts, a genuinely distinct surface, not a memory dup (the roadmap's "knowledge+family-memory"
  grouping was imprecise). **Front door + intent entry** delivered separately (R5 + R6). Remaining R4:
  demoting specialist reasoning surfaces from top-level nav is **owner-settled** (§A: default rail
  stays curated; specialists live in All Services + Navigation Choices) — no further change.
- [x] **R5. The proactive front door** ✅ — the Home hero now leads with "I already handled N
  things — M need your OK." Pure `lib/home/front-door.ts::buildFrontDoor` (7 tests) folds recent
  **auto-executed** autopilot actions (reversible → link to Autopilot to undo) + **pending**
  approval_requests (most-urgent first → link to the inbox) into one proactive summary;
  `components/home/front-door-hero.tsx` renders it above the Focus strip. Transparent (every item
  named + linked) and reversible. Best-effort loads (hidden hero on a drifted DB). Seed
  `seed_front_door.sql` (300 auto-executed + 250 pending = 550 records). tsc/eslint/**2072 tests**/build.
- [x] **R6. Intent-based entry** ✅ — a prominent NL **AskBar** at the top of Home routes through the
  same pure `routeCommand` the ⌘K bar uses: a recognized goal jumps straight to its reasoning engine,
  a page name navigates, anything else hands to the assistant. Extended `detectIntent` with the two
  missing goals from the brief — **`check_availability`** ("who's free Saturday" → Calendar) and
  **`plan_event`** ("plan Emma's party" → Prep Plans) — with tests. `components/home/ask-bar.tsx`
  (+ suggestion chips). Intent entry is now the primary, visible way in on the default landing.
  Pure/tested; no new data surface. tsc/eslint/**2074 tests**/build.

**P3 — Digital Twin / Reasoning Engine depth (Phase 3; 12–18mo differentiation).**
- [x] **R7. Unify the reasoning engine** ✅ SHIPPED (2026-07-08). One core in `lib/reasoning/engine.ts`
  (`answerFamilyQuestions`, pure + deterministic, 8 tests) answers the six questions every surface
  consumes — **what matters most · what's likely forgotten · what to decide next · what Bubaly can
  just handle · who needs help · what's next** — by *composing* the existing engines: the FOI
  orchestrator, the graph reasoning insights (R2), the hard signals (R10), and ranked next-actions.
  Server `lib/reasoning/engine-server.ts` (`loadReasoningReport` / `loadAndSnapshotReasoning`)
  assembles them from live family data best-effort (any failing source → calm) and persists one
  snapshot per day to **`reasoning_snapshots`** (`0149`, family-scoped RLS). Surface
  `/dashboard/reasoning` (nav: Family Reasoning) renders the six answers + all-clear state. Seed
  `seed_reasoning_snapshots.sql` (500 days, calm/attention mix; in `SEED_ALL.sql`). Verified:
  tsc · **vitest (8 reasoning)** · migration + seed validated on PG16 (500 rows, both idempotent).
  ⚠️ apply `0149` to prod (see `docs/PENDING_PROD_MIGRATIONS.md`).
- [x] **R8. Deepen twin simulation** ✅ SHIPPED (2026-07-08). Pure `projectActivity` added to
  `lib/twin/simulate.ts` (7 tests) — the full "if Emma joins travel soccer, what has to move?"
  projection across **schedule · travel · cost · family time · homework · meals · vacation**, each a
  scored dimension with an overall verdict + weekly-hours. Additive (existing commitment/spend
  simulator untouched; 10 tests still green). Server `projectActivityAction` assembles the real
  household (member events + budgets w/ period spend + `vacations` windows) and runs it — a safe
  no-write what-if; `saveSimulationAction`/`deleteSimulationAction` persist kept scenarios to
  **`twin_simulations`** (`0147`, family-scoped RLS). UI `components/twin/activity-projection.tsx`
  mounted on `/dashboard/family-digital-twin` (form → per-dimension ripple → Save; saved-scenario
  list). Seed `seed_twin_simulations.sql` (500 rows, verdict spread; in `SEED_ALL.sql`). Verified:
  tsc · eslint · **vitest (17 twin)** · `next build`; migration + seed validated on PG16 (500 rows,
  idempotent). *(Reads the family's real linked model — events/budgets/vacations; deeper graph-entity
  wiring can layer on later.)*

**P4 — Ecosystem orchestration (Phase 4; 18–24mo network effects).**
- [x] **R9. Per-provider sync adapters** ✅ SHIPPED (2026-07-09). Two complementary layers landed
  (parallel work streams), both key-gated per B3 — no engineering left, only owner OAuth keys:
  - **Sync-engine contract (the real two-way engine).** `lib/sync/adapter.ts` (`SyncProviderAdapter` +
    normalized event/task/calendar types + `SyncApiError`) abstracts OAuth + the calendar/task API + the
    pure mappers so ONE engine drives any provider. `lib/sync/engine/generic.ts` (`runProviderSync`) is
    that engine — the proven Google pull/push/conflict/mapping loop, now driven purely through the
    contract. `providers/google-adapter.ts` conforms the battle-tested Google client (zero behavior
    change); `providers/microsoft.ts` is a real **Microsoft Graph** adapter (Outlook Calendar + To Do,
    OAuth v2.0, fully-tested pure Graph mappers, key-gated on `MICROSOFT_SYNC_*`). `lib/sync/registry.ts`
    + shared `lib/sync/hash.ts` (every adapter yields the SAME digest — proven by test). Wired via
    `POST /api/sync/run`. Seed `seed_sync_microsoft.sql` (connected Outlook account + 500 synced events +
    mappings; in `SEED_ALL.sql`). 17 adapter tests + 13 google-map (no regression); tsc · eslint · build;
    seed PG16-validated + idempotent. No migration — `microsoft` was already in the `sync_provider` enum
    (0018).
  - **Connections-hub contract (the higher-level directory→sync abstraction).** `lib/connections/adapter.ts`
    (`SyncAdapter`, normalized `NormalizedEvent`/`NormalizedMessage`, `AdapterContext`, pure `planSync`
    decision core: blocks on `needs_setup`/`not_connected`/`unsupported`, full→incremental once a cursor
    exists). Reference adapters `lib/connections/adapters/` — `google-calendar` + `gmail` — inert until
    `GOOGLE_OAUTH_*` keys land. Registry `adapterFor`/`syncableProviderIds`. 12 tests; tsc · eslint · build.
  - **Remaining (owner-only):** provision provider OAuth keys → live Microsoft/Gmail/Calendar sync; the
    next provider (Apple/CalDAV) drops into the same contract with no engine change.

**Cross-cutting moat work (start now, threads through all phases):**
- [x] **R10. Family Intelligence — the hard signals.** ✅ SHIPPED (2026-07-07). Four pure detectors in
  `lib/intelligence/hard-signals.ts` (11 tests): **ignored-reminder** (same reminder overdue-without-
  done ≥3×, grouped by normalized title), **stress windows** (events×4 + clashes×12 + overdue×6 bucketed
  by day-type × part-of-day → the peak crunch window), **chore friction** (rejections×2 + disputes×3 +
  hand-offs, per chore), **routine adherence** (expected weekday occurrences vs actual completions →
  flags routines under 60%). Service core `hard-signals-server.ts` (`runSignalDetection`) maps live
  rows (family_reminders/calendar_events/chore_assignments/routine_templates) to the engines and upserts
  into **`family_signals`** (`0142`, family-scoped RLS) — **preserving dismissals**. Transparent +
  editable surface at **`/dashboard/family-signals`** (evidence chips + Acknowledge/Dismiss/Restore +
  Refresh) + nav entry. Runs on demand AND in the **model-refresh cron** (always-learning, non-fatal).
  Seed `seed_family_signals.sql` (500 rows, status spread; in `SEED_ALL.sql`).
  Verified: tsc · eslint · **vitest (11)** · `next build`; migration + seed validated on PG16 (500 rows,
  idempotent). Feeds the Playbook/reasoning layer (family_signals is now a readable substrate).
  - [x] **5th detector — budget drift ✅ SHIPPED (2026-07-10).** `detectBudgetDrift` (pure, +5 tests)
    flags a budget **category over its cap this period**, scored by overspend ratio and boosted when the
    **prior period was over too** (a real drift pattern, not FOI's single number). Reuses FOI's
    period-window math; `runSignalDetection` now also loads `budgets` + this-year expense `transactions`.
    Migration **`0157_family_signals_budget_drift.sql`** widens the `kind` check with `budget_drift`
    (additive/idempotent, PG16-validated); the Family Intelligence surface renders it (Wallet icon,
    spent/cap/"2 periods" evidence chips). Seed extended to 5 kinds (100 budget_drift rows). Verified:
    tsc · eslint · **vitest (16 hard-signals)** · `next build`. ⚠️ apply `0157` to prod.
- [x] **R11. The category metric — surface "time saved / mental load."** ✅ Pure
  `lib/metric/time-saved.ts::computeTimeSaved` (4 tests) turns this week's system-handled actions —
  autopilot auto-executions (5 min), assistant-handled items (4 min), reminders delivered (2 min) —
  into a real "≈ N hours saved this week · M things handled for you" figure with a transparent
  breakdown. Server loader `time-saved-server.ts` (best-effort 7-day counts); `TimeSavedBanner`
  rendered on **Home** (under the front door) and atop the **Experience Scorecard**. Seed
  `seed_time_saved.sql` (250 autopilot + 150 agent + 150 reminders = 550 → ~35.8h). The thesis metric
  is now IN the product, not just marketing copy. tsc/eslint/**2078 tests**/build.
- [x] **R12. Moments as an organizing layer** ✅ SHIPPED (2026-07-08). Pure `lib/moments/organizer.ts`
  (`activeMoments`, 9 tests) defines the 10 canonical life moments (Morning · School · Dinner · Homework
  · Bedtime · Weekend · Vacation · Birthday · Holiday · Emergency), each orchestrating the handful of
  capabilities it needs, and decides which are LIVE now from the clock + family signals (upcoming
  birthday/trip/holiday, homework due tomorrow) — episodic-near outranks the daily rhythm; Emergency
  always reachable. `/dashboard/moments` now OPENS with a "Right now" organizing band (server-computed,
  deep-linked capability chips, dismiss-for-the-day) above the existing event-prep view — organize by
  moment, not by hunting 70 modules. Durable **`moment_activations`** (`0148`, family-scoped RLS) logs
  surfaced/engaged/dismissed per day (engagement signal for the reasoning layer); `dismissMomentAction`/
  `engageMomentAction`. Seed `seed_moment_activations.sql` (500 rows, every moment × ~50 days, status
  spread; in `SEED_ALL.sql`). Verified: tsc · eslint · **vitest (9)** · `next build`; migration + seed
  validated on PG16 (500 rows, idempotent). Additive — the event-prep MomentsView is untouched.

### ⛔ What to STOP
- **No net-new feature modules.** The matrix is saturated; more rows don't move the moat and add
  surface area to maintain. Every new PR should cite which of R1–R12 (or a moat layer) it advances.
- **Stop adding standalone AI pages** — new AI capability goes *through* the one assistant, not as a
  27th destination.
- Marketing/nav polish (findability of Shopping, AI Inbox, Smart Imports, Kitchen Mode, etc.) is fine
  and cheap, but it is **positioning, not moat** — don't confuse it with the work above.

---

## ★★★ TIME-TO-FIRST-VALUE — the 24-hour transformation (owner directive, 2026-07-07) — READ FIRST

> **Owner directive (verbatim intent):** *"The next level is to make Bubaly feel indispensable within
> the first 24 hours… invert the experience: deliver obvious value immediately, then let the platform
> learn over time. Help Bubaly build an understanding of the household from information users already
> have, then immediately solve a real problem. The biggest bet: **reduce time to first meaningful
> value.**"* Directly serves the mission — **Less Managing Life. More Living It.**

> **How this section relates to the MOATS directive above:** that section is about what to *own* (the
> graph, the reasoning engine, the one assistant). This section is about *when the user first feels it*
> — the **first-run funnel**. They are complementary: the moat is the engine; TTFV is the ignition.
> The honest finding of this audit is that Bubaly has **already built the destinations** (outcome
> dashboards, operating index, next-best-actions, chief-of-staff pieces) but still makes users
> **configure a household before any of it lights up**. Closing that gap is mostly *wiring existing
> capabilities into the first session*, not building new features — which is exactly aligned with
> "moats/UX over new modules."

### ▣ Honest audit — what's BUILT vs. the TTFV gap (grounded in the code, 2026-07-07)

| Owner's area | Built today (real) | The gap that blocks day-one value |
|---|---|---|
| **1. Unforgettable first session** | ICS calendar import **exists** (`app/api/calendar/sync/route.ts` hand-rolled RFC-5545 parser + `api/cron/calendar-feeds`); conflict detection (`/dashboard/conflicts`); dinner suggestions (meals engines); outcomes/next-best-actions engines. | **None of it runs during onboarding.** The 6-step wizard (`profile→family→about→members→pin→done`, `lib/onboarding/flow.ts`) is **configuration-first** and `done` delivers a "Welcome" screen, **not a built timeline / conflicts / dinner ideas / action list**. The import is buried in settings. **This is the #1 gap.** |
| **2. Outcomes over dashboards** | `AiHomeDashboard` is the **default** home; `/dashboard/outcomes`, `/family-operating-index`, `/readiness`, `/weekly-briefing`, `/next-best-actions` all exist and are outcome-framed. | Mostly **DONE** — but the outcome framing ("Your week is 92% prepared") isn't the onboarding payoff, and empty/new-family states show scaffolding, not an outcome. Ensure a brand-new family sees an outcome, not an empty widget. |
| **3. One daily "wow"** | Calm digest, agents, autopilot, moments engines produce insights. | No **single, ranked, proactive "insight of the day"** surfaced above everything else. Today it's *many* small items (the thesis's anti-pattern). Need one hero insight/day (traffic+weather, grocery savings, unacknowledged homework). |
| **4. Collaborative AI** | `/dashboard/voting` + `/dashboard/decisions` + `family_polls` + decision engine (options/scoring) exist. | Voting/decisions are **standalone pages**, not an AI-facilitated group flow ("meal voting with budget+dietary constraints", "vacation planning balancing availability"). The AI doesn't yet *drive the group to agreement*. Wire the reasoning engine into the voting/decision surfaces. |
| **5. Switching costs (accumulated context)** | Playbook (favorite meals/staples/traditions), knowledge graph, digital twin, routines, long-term FOI history. | The accumulated context isn't **surfaced back as felt value** ("Bubaly knows your family now"). Add life-event templates + a visible "what Bubaly has learned" surface so the moat is *felt*, and make it editable (ties to R10). |
| **6. Onboarding as guided transformation** | Wizard is clean, 6 steps, a11y-announced, draft-persisted. | It guides through **settings**, not **outcomes**. Each step should end in visible value ("Let's make tomorrow easier" → shows tomorrow's timeline). Re-sequence: value FIRST (import → show), household-building SECOND/deferred. |
| **7. Trust & transparency** | Informed-consent preview (network), `/dashboard/trust`, autopilot approvals, undo patterns. | Not **consistent across every AI action**. Every recommend/automate should carry *why + inputs used + adjust/undo* inline. Standardize a "why this?" affordance on AI outputs (partly R5). |
| **8. Premium feeling** | a11y pass (skip-link/WCAG), `MiniEmpty` empty states, toasts, optimistic updates in many modules. | Inconsistent: not every module has helpful empty states / error recovery / motion. Needs a **consistency sweep** (perf budget, predictable transitions, empty+error states everywhere) — measurable, not vibes. |
| **9. Compounding value** | Connections hub + graph make cross-domain links *possible*; twin links calendar↔meals↔budget. | The cross-service wins (Calendar+Weather→travel, Shopping+Budget→savings, Health+Calendar→med timing) aren't **shipped as visible insights**. This IS moat-work **R2** (re-point engines at the graph) surfaced as day-one wins. |
| **10. Partner tone** | Copy is warm in places; Calm digest is reassuring. | Notification/label voice is still **count-based** in modules ("17 notifications") rather than **partner-framed** ("You're in good shape — 3 quick approvals finish tomorrow"). Tone pass across surfaced counts/badges. |

**Verdict:** ~6 of 10 areas are *substantially built as destinations*; the value is trapped behind a
config-first first-run. **Highest-leverage change = make the first session deliver a concrete outcome
before asking the user to build anything.**

### ▶ THE TTFV BACKLOG (priority order — most is *wiring existing engines into the first run*)

**MEASUREMENT (2026-07-12): Onboarding time-to-value audit ✅ (backlog #9).** `lib/onboarding/ttv-audit.ts`
(pure `analyzeOnboarding` — step funnel, completion + activation rates, TTV median/p90, **% reaching value
≤ 90s**, and where incomplete runs stall; **11 tests**) rendered at **`/admin/onboarding`** (super-admin, in
`ADMIN_NAV`): TTV stat tiles, an on/below-target callout, the step-completion funnel with per-step drop-off,
and a "where runs stall" chart — so the first-run funnel is measurable and the friction is visible to trim.
Reads the existing `onboarding_progress` table; no migration/seed (read-only audit over auth-linked
operational data). tsc/eslint/build green.

**P0 — The "magic first session" (the single biggest conversion/retention bet).**
- [x] **T1. Value-first onboarding re-sequence.** ✅ SHIPPED (2026-07-07). New flow order
  `profile → family → value → about → members → pin → done` — the `value` step comes right after the
  two required inputs, and everything after it is optional/deferrable. In the value step the user
  **pastes their calendar (.ics)** or **tries a sample family week**; we parse it purely
  (`lib/onboarding/ics.ts`, 7 tests) and compute an instant **first brief** — today's timeline ·
  clashes · action list · time-saved (`lib/onboarding/first-brief.ts`, 9 tests) — shown BEFORE any
  configuration. Server: `previewCalendarImportAction` (parse+brief, **no DB write**);
  `finalizeOnboardingAction` persists the imported events into `calendar_events` and records the
  first-value moment in **`onboarding_imports`** (`0138`, family-scoped RLS, PG16-validated) — the
  seed of the TTFV metric (T10). Flow engine extended + retested (imported events kept OUT of
  sessionStorage for quota safety). Seed `seed_onboarding_imports.sql` (500 rows, all 4 sources,
  idempotent; wired into `SEED_ALL.sql`). Verified: tsc · eslint · **vitest (73 onboarding)** ·
  `next build`. *(OAuth "Connect your calendar" stays owner-gated per R9/B3 — paste + sample deliver
  the value moment with zero external keys.)*
- [x] **T2. First-run "instant briefing" builder.** ✅ SHIPPED (2026-07-07). `lib/onboarding/first-brief.ts`
  produces today's timeline · likely conflicts · prioritized action list · **time-saved opportunities**
  · **3 dinner ideas**. Dinner ideas come from a curated, family-agnostic catalog **`meal_ideas`**
  (`0139`, reference data, PG16-validated) via the pure, deterministic `lib/onboarding/dinner-ideas.ts`
  (`pickDinnerIdeas` — quick meals on busy days, involved on weekends, rotates daily; 6 tests). The
  brief is now **rendered as the celebration/done screen** (`finalizeOnboardingAction` computes it
  server-side — with dinner ideas — and returns it; `DonePanel` shows headline · time-saved · today ·
  clashes · dinner ideas instead of the old generic "Welcome"), and also inline in the value step.
  Seed `seed_meal_ideas.sql` (500 dishes × cuisine × effort, idempotent; in `SEED_ALL.sql`, now 26).
  Verified: tsc · eslint · **vitest (80 onboarding)** · `next build`. *(Deferred: rendering the brief
  on the AiHome empty state is T3; dinner ideas draw from the curated catalog, not yet the family's own
  learned tastes — that's a Playbook/R10 follow-up.)*
- [x] **T3. New-family home = outcome, never empty.** ✅ SHIPPED (2026-07-07). When `AiHomeDashboard`
  would otherwise show the bland "You're all caught up / Capture something" empty card (nothing needs
  you + nothing today), it now renders an **outcome hero**: a week-readiness % + progress bar, the
  next best **getting-started steps** (Fill your week · Plan dinners · Invite family · Grocery list ·
  Chores — each marked done from the family's real state, unfinished first), and **3 dinner ideas**.
  Pure engine `lib/home/home-brief.ts` (`buildHomeBrief`, 6 tests) reuses the T1/T2 first-brief engine
  so home + first-run tell the same story. Persists a daily snapshot to **`home_briefs`** (`0140`,
  family-scoped RLS, one row/family/day — the "never empty" substrate + home-side TTFV signal),
  idempotent upsert on read (mirrors the FOI pattern). Seed `seed_home_briefs.sql` (500 daily
  snapshots, readiness trend, idempotent; in `SEED_ALL.sql`, now 27). Verified: tsc · eslint ·
  **vitest (home + onboarding)** · `next build`. *(One ranked hero "insight of the day" is the
  separate T4; this ships the outcome + steps + dinners.)*

**P1 — One daily "wow" + partner tone.**
- [x] **T4. Insight-of-the-day.** ✅ SHIPPED (2026-07-07). The home surfaces exactly ONE ranked,
  proactive insight above the fold (right under the Ask bar) instead of a pile of notifications. Pure
  ranker `lib/home/insight-of-day.ts` (`buildInsightCandidates` + `rankInsights`/`topInsight`, 9 tests)
  scores candidates by impact and picks the best; supports **leave-earlier (traffic+weather)**,
  **unacknowledged homework due tomorrow**, **grocery/meal savings**, plus conflicts · approvals ·
  overdue reminders · renewals · documents · autopilot. Wired into `AiHomeDashboard` from live signals
  (added homework-due-tomorrow + planned-dinner queries) and persisted to **`daily_insights`** (`0141`,
  family-scoped RLS, one row/family/day/kind). Dismissible via `InsightHero` + `dismissInsightAction`
  (the ✕ marks the row dismissed and the **next-best** insight surfaces). Seed `seed_daily_insights.sql`
  (500 rows, every kind × ~56 days, status spread; in `SEED_ALL.sql`, now 28). Verified: tsc · eslint ·
  **vitest (insight + home + onboarding)** · `next build`. *(The traffic+weather source for the
  leave-earlier insight is owner-gated on a Maps/weather key per B3 — the ranker + seed exercise the
  kind; it goes live when the key lands.)*
- [x] **T5. Partner-tone pass.** ✅ SHIPPED (2026-07-07). Centralized phrasing helper
  `lib/tone/partner-phrasing.ts` (18 tests) turns raw counts into partner voice: `notificationsLine`
  ("You're all caught up" → "3 quick things to glance at" → a full-inbox triage offer), `bellLabel`
  (spoken-friendly aria), `partnerStatus` (one "where you stand" line — "You're in good shape — 3 quick
  approvals and tomorrow's set"; surfaces the single most pressing signal), `badgeCount` (capped). Wired
  into the **notification bell** (aria + title + badge) and the **Notifications page** header (live
  partner line from the unread count) — deliberately left `ai-home-dashboard` to the in-flight T-work to
  avoid a collision. Seed `seed_notifications.sql` (500 rows, all 10 types, ~40 unread; in `SEED_ALL.sql`,
  PG16-validated + idempotent). Verified: tsc · eslint · vitest · `next build`. (Area 10.)

**P2 — Collaboration, transparency, premium consistency.**
- [x] **T6. AI-facilitated group decisions.** ✅ Group Voting (`/voting`) now facilitates consensus:
  every poll carries a **category** (meal/vacation/shopping/activity), an optional **budget cap**, and
  **required tags** (e.g. dietary needs); each option carries real **cost / travel / tags**. Pure
  `lib/voting/consensus.ts` (`facilitateConsensus`, **14 tests**) blends the democratic signal (votes)
  with the shared Decision Engine's objective fit (cost/travel + hard budget/dietary vetoes), then
  surfaces a **recommendation**, a **consensus level**, and explicit **vote-vs-fit conflicts** ("the
  favorite is over budget", "votes lean X but Y fits better"). Reasoning context is real: the module
  pulls the family's **budgets** and funds the cap via `budgetCapForCategory` when a poll omits one.
  Migration `0142_poll_facilitation.sql` (additive, idempotent, PG16-validated — no new tables so 0078
  RLS already governs it) + types. Seed `seed_group_decisions_one_family.sql` (100 polls / 400 options /
  ~800 votes = ~1,300 rows) biases favorites over budget so conflicts fire. tsc/eslint/**1990 tests**/build. (Area 4.)
- [x] **T7. "Why this?" everywhere.** ✅ Reusable `components/ai/why-this.tsx` — one consistent inline
  disclosure showing **reason + inputs used** (factors) + confidence + **Helpful/Not-helpful** feedback.
  Pure `lib/ai/explanation.ts` (`explainAutopilot`/`explainInsight`/`explainAgentActivity`/`explainConsensus`,
  **9 tests**) shapes each engine's output into a consistent `Explanation`. Consumed by **insight-of-day**
  (InsightHero), **autopilot** (SuggestionRow), **agents** (recent activity) and **voting** (T6 consensus).
  Feedback persists via `recordAiFeedbackAction` → **`ai_feedback`** (`0143`, append-only, family-scoped
  RLS, PG16-validated) — the learning loop a future model-refresh can weigh. Seed
  `seed_ai_feedback_one_family.sql` (600 rows across all 6 surfaces × 5 signals). tsc/eslint/**1999 tests**/build. (Area 7.)
- [x] **T8. Premium-consistency sweep.** ✅ Made **measurable**: a Supabase-backed Experience Scorecard
  grades every surface (module/journey) on the six premium dimensions (empty state, error recovery,
  transitions, performance, accessibility, consistency), tracked over time. Pure
  `lib/experience/scorecard.ts` (`scoreAudit`/`gradeFor`/`rollUpScorecard`, **13 tests**) — weighted
  composite → letter grade, worst-first ordering, per-dimension averages, trend vs previous audit,
  "needs work" (<70) flags. Table `experience_audits` (`0144`, family-scoped RLS, one audit/surface/day,
  PG16-validated) + types. Live `/dashboard/experience` module (realtime). `docs/EXPERIENCE_SCORECARD.md`
  extended to document the live system (closes the doc's own "make it measurable" gap). Seed
  `seed_experience_audits_one_family.sql` (540 rows / 30 surfaces × 18 dates) with an upward trend +
  4 surfaces below the bar. tsc/eslint/**2012 tests**/build. *(Route not added to global nav per the
  standing rule — reachable at `/dashboard/experience`; add a nav entry on request.)* (Area 8.)
  (Area 8.)

**P3 — Felt switching cost (compounding context).**
- [x] **T9. "What Bubaly has learned" surface + life-event templates.** ✅ New `/dashboard/life-events`
  ("Life & Milestones") with two halves: (1) **What Bubaly has learned** — accumulated preferences/
  routines/traditions (reuses `family_facts`), fully editable inline (add/edit/pin/delete); (2)
  **Life-event playbooks** — 6 one-tap templates (New Baby, Moving, School Start, Vacation, New Pet,
  New Job) that materialize a real **dated checklist** via pure `lib/life-events/templates.ts`
  (`buildPlanItems`, **10 tests**). Launch is atomic (`launchLifeEventAction`: plan + items, rolls back
  orphans). Plans/items in `life_event_plans` + `life_event_plan_items` (`0145`, family-scoped RLS,
  PG16-validated) + types; realtime module with progress bars, checkable items, complete/archive. Seed
  `seed_life_events_one_family.sql` (44 plans / ~493 items / 30 learned facts). tsc/eslint/**2022 tests**/build.
  *(Route not in global nav per the standing rule — reachable at `/dashboard/life-events`.)* (Areas 5 + 6.)

**Instrumentation (proves the bet):**
- [x] **T10. TTFV metric.** ✅ Instrumented **time-from-signup-to-first-outcome-viewed** (median + p90)
  and **session-1 activation rates** (calendar imported / first briefing / first outcome). New
  `activation_events` table (`0146`, mirrors onboarding-telemetry RLS: insert-own, select-own,
  service-role aggregates) + pure `lib/analytics/activation.ts` (`summarizeActivation`, `sessionIndexFromMs`,
  `percentile`, **8 tests**). Wired live: `<ActivationBeacon>` on **Outcomes** (first_outcome_viewed) and
  **Briefing** (first_brief_viewed), and a server record on **calendar-feed add** (calendar_imported),
  all deduped to "first value". Surfaced on `/dashboard/onboarding-funnel` **next to the step funnel**
  (TTFV median/p90, activation rate, session-1 tiles, per-milestone reach). Seed `seed_activation_events.sql`
  (~820 rows / 220 cohorts). tsc/eslint/**2030 tests**/build.

**Alignment note:** T1–T3 + T8 are pure UX/wiring of existing capabilities (no new modules — consistent
with the freeze). T4/T6/T9 route *through* the reasoning engine/graph (advance R2/R4/R5/R10/R12), not
new standalone destinations. T10 is the missing half of the category metric (R11).

---

## ⚑ OPEN ITEMS & DECISIONS — single source of truth (2026-07-06)

> ### ▣ EVERYTHING STILL OPEN — consolidated (as of 2026-07-06, evening)
>
> The agent-doable **code** backlog is essentially drained; what genuinely
> remains is **owner / external** action. Shipped this session on top of the
> merged reasoning + moat layer: onboarding→marketing wiring + **child logins
> without email** (#235), role-tailored **nav gating** (#236), marketing header
> text size (#237), role-based **Focus-strip density** (#238), **Kid-Logins nudge**
> on the onboarding Done screen (#239), and screen-reader **progress bars** —
> onboarding (#240) + **app-wide** (#241).
>
> **OPEN — owner / external (NOT code; the agent cannot execute these):**
> 1. **Apply pending prod migrations** — `supabase db push` (incl. `0105_child_logins`
>    + `0118`→`0135`, or paste `supabase/APPLY_PENDING_0118-0135.sql`). **THE blocker:**
>    child logins, the whole reasoning layer (FOI, playbook, agents, graph, decisions,
>    prep plans), and network consent silently no-op in prod until applied.
> 2. **Set prod env vars** — `CHILD_LOGIN_SECRET` (child username+PIN sign-in) and
>    `CRON_SECRET` (`model-refresh` + `network-aggregate` crons).
> 3. **Provider keys** — each lights up an already-built path: **VAPID/FCM** (push) ·
>    **Maps/ETA** (Friction #6 travel buffer) · **GIF provider** (Messages/photos picker) ·
>    **Stripe Issuing** (real Wallet card balances) · **CI Supabase login** (authed e2e).
> 4. **Activate the `onboarding_completed` marketing workflow** so onboarding fires it.
> 5. **Intelligence Network launch gate** — insights only surface at **≥100** consenting families.
>
> **OPEN — agent-doable follow-ups (small, no blocker; do when directed):**
> - [x] **Role density/tone, broader rollout ✅ (2026-07-10)** — the role-tailored greeting
>   (`roleGreeting`, tone-matched per role: parents formal · adults casual · kids a warm emoji line)
>   now leads the **personal dashboard** too, not just Home — extending the Friction #8 treatment
>   (Home focus strip density/`focusMax`/headline + greeting) to a second primary surface. Reuses the
>   pure `lib/ui/role-surface.ts` (already 10 tests); tsc · eslint · build.
> - [x] **Instrument real journey medians ✅ (2026-07-10, code side)** — the ubiquitous **QuickAdd**
>   flow (`components/family/quick-add.tsx`, used across every module) now emits `journey_events` via
>   `useJourney('quick_add')` (start on open · complete on save · abandon on cancel), so the
>   already-live per-family medians at `/dashboard/journeys` (pure `summarizeJourneys`, real data — no
>   estimates) now cover the app-wide add flow alongside capture / add-memory / voice / next-actions.
>   **Residual (owner/infra, not agent-doable here):** the Playwright "taps to complete" CI harness +
>   a cross-family service-role aggregate — both need a running app + auth this sandbox lacks.
> - **Friction #6 travel buffer** — code-ready; needs the Maps/ETA key (owner item 3 above).
> - [x] **Twin projector — care providers ✅ (2026-07-10).** The cross-domain projector now links
>   **health providers** (doctors / dentists / specialists) from `health_providers` as `org` nodes the
>   member "sees" (`Emma → Dr. Lee (Pediatrics)`), so the graph + reasoning layer can reason over health
>   relationships. Pure `projectTwin` extension (+1 test; family-level + dangling providers make a node
>   but no edge); `runTwinProjection` loads the extra table. No migration (reuses `graph_entities/edges`).
>   tsc · eslint · **vitest (17 twin-project)** · build. *(Smart-home entities still deferred — no
>   device domain has landed yet.)*
> - **GIF picker** (Messages/photos) — code path exists; needs the provider key (owner item 3).
> - [x] **Backend production hardening (2026-07-07, reasoning/network lane)** ✅ — Intelligence
>   Network aggregation hardened (write-side granular-consent `filterMetricsByScopes`, atomic
>   upsert-then-prune republish, **per-family try/catch isolation** in the nightly cron); prod audits
>   all clean (11/11 crons `CRON_SECRET`-guarded; `vercel.json` ↔ cron routes match 1:1); Knowledge
>   Graph path-finder `<Select>` a11y labels. **Cron N+1 scalability fixes:** `model-refresh`
>   skip-decision batched to **1 query** (was 2/family) via the dirty table's `refreshed_at`;
>   `network-aggregate` contribute phase batched to **4 queries** (was 4/family) via `.in(family_ids)`
>   — both now scale past thousands of families without hitting the 60s cron limit. Privacy-invariant
>   regression test added (noised count never leaks true cohort size). tsc/eslint/**1916 tests**/build green.
> - [x] **Social share cards (OpenGraph / Twitter)** ✅ (#245) — `app/opengraph-image.tsx` +
>   `app/twitter-image.tsx` render a brand-gradient 1200×630 card (Bubaly wordmark + tagline)
>   via `next/og`, shared from `lib/og/social-image.tsx`. Fully self-contained (wordmark
>   inlined from disk, no network fetch). Fixes the previously-blank `summary_large_image`
>   preview on iMessage/Slack/X/Facebook. Build-verified (both routes generate).
> - [x] **JSON-LD + canonical SEO (2026-07-07)** ✅ (#246) — (a) JSON-LD structured data
>   (`components/marketing/structured-data.tsx`: Organization + WebSite + SoftwareApplication on
>   the homepage, FAQPage on `/faq`) for Google/Bing rich results — honest data only; (b)
>   self-referential canonical URLs (`alternates.canonical: './'` in the root layout resolves
>   per-route — verified home→`/`, `/pricing`→`/pricing`, `/faq`→`/faq`), preventing duplicate
>   indexing of www/non-www/trailing-slash/preview-domain variants. Build- and server-verified.
> - [x] **HSTS security header (2026-07-07)** ✅ (#247) — `Strict-Transport-Security:
>   max-age=63072000; includeSubDomains` added to the global header block in `next.config.mjs`
>   (no `preload` — avoids the irreversible preload-list commitment). Rounds out the existing
>   X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy set.
> - [x] **Skip-to-content link, WCAG 2.4.1 (2026-07-07)** ✅ (#248) — `components/a11y/skip-link.tsx`
>   (sr-only until focused) rendered first in the marketing layout AND app shell; each `<main>` given
>   `id="main-content"`. Keyboard/SR users can bypass the nav on every page. Build-verified.

### A. Decisions only the owner can make
- [x] **Intelligence Network aggregation** ✅ — decisions signed off + pipeline **built**
  (`0135_network_aggregates.sql`, `lib/network/aggregate.ts` +9 tests, `network-aggregate` cron,
  real insights on `/dashboard/intelligence`). Approved defaults: K=20, low DP noise (Laplace 1.5),
  cohort = kids-band × household-size, **no** geography, launch gate **≥100 families**.
  Seed `seed_network_aggregates.sql`. (`docs/INTELLIGENCE_NETWORK_DESIGN.md` now marked SIGNED OFF + BUILT.)
- [x] **Global nav entries added this session** ✅ CONFIRMED (owner 2026-07-06): keep the left
  navigation as-is and keep all four — Reasoning Graph, Decision Engine, Prep Plans, Intelligence
  Network (all `minLevel: 0`). They live in **All Services + the Navigation Choices catalog** (users
  pin/add them); **deliberately NOT promoted into the default `PRIMARY_NAV` rail** — the default rail
  stays curated. No further change.

### B. Operational — prod go-live (owner action, not code)
- [ ] **Apply migrations 0125→0135 to prod** (`supabase db push`, or paste `supabase/APPLY_PENDING_0118-0135.sql`).
  THE blocker — everything reads these; silently no-ops until applied.
- [ ] **Set `CRON_SECRET` in prod** → activates the `model-refresh` + `network-aggregate` crons.
- [ ] Keys that light up already-built paths: **VAPID/FCM** (push) · **Maps/ETA** (travel buffer) ·
  **GIF provider** (Messages picker) · **Stripe Issuing** (Wallet card balances).

### C. Genuinely-open product items (agent-doable)
- [x] **FOI financial dimension** ✅ — already wired: `countOverspentBudgets` (real budgets vs
  this-period expenses) + real accounts-below-zero in `lib/operating-index/server.ts`. (Stale entry — verified done.)
- [x] **Onboarding pre-family telemetry** ✅ — `0133_onboarding_events.sql` + `lib/analytics/onboarding.ts`
  (11 tests) + `onboarding-track.ts` wired into the wizard + super-admin `/dashboard/onboarding-funnel`
  + `seed_onboarding_events.sql` (550 events). Validated on PG16.
- [x] **AI Concierge write-back** ✅ — already wired: create plans, update status
  (planning/completed/cancelled), delete, and convert a plan → real `calendar_events`. (Stale entry — verified done.)
- [x] **Twin auto-refresh trigger** ✅ — `0134_model_dirty.sql`: `family_model_dirty` flag +
  SECURITY DEFINER trigger on every cross-domain source table; `needsRefresh()` (dirty wins, else TTL,
  3 tests); the `model-refresh` cron prioritizes dirty families + clears the flag. Now event-driven.
- [ ] **Messages GIF picker** — blocked on the provider key. *(external key — not agent-doable)*
- [x] **Kid-login brute-force hardening** ✅ (2026-07-07) — the no-email child sign-in (username +
  4-digit PIN) had NO throttle, so a guessable username + 10k PINs was brute-forceable. Added a durable
  per-username lockout: pure `lib/auth/child-throttle.ts` (10 tests: window/lockout/escalation/reset)
  + `0137_child_login_throttle.sql` (service-role-only table, RLS deny-all; PG16-validated) wired into
  `childSignInAction` (locks after 5 fails/15 min, escalating; cleared on success) and cleared on a
  parent PIN reset. Degrades safely before the migration is applied (still works, just un-throttled).
  Doc: `CHILD_LOGIN_SECRET` + `0137` added to `PENDING_PROD_MIGRATIONS.md`.
  *(Phone-number deep-dive deferred: the parallel session is actively rewriting `phone-auth`/OTP on
  main — building there now would collide. Revisit once that settles.)*

> **Section C status: closed except the GIF picker (needs an external provider key).** All four
> agent-doable items are done — 2 built this session (onboarding telemetry, twin trigger), 2 were
> already wired (FOI financial, Concierge write-back).

### D. ★ Moat layer shipped this session (all validated: 1838 tests / tsc / eslint / build)
- [x] **Knowledge Graph** — `0129`, `lib/graph/reason.ts` (16 tests, impact propagation), `/dashboard/graph`, `seed_graph.sql`.
- [x] **Twin cross-domain projector** — `lib/twin/project.ts` (8 tests) + `projectTwinAction` (pillar #2's linked model).
- [x] **Decision Engine** — `0130`, `lib/decisions/engine.ts` (9 tests), `/dashboard/decisions`, `seed_decisions.sql`.
- [x] **Chief of Staff ↔ graph** — `lib/agents/graph-insight.ts` (6 tests): hubs + ripple into briefings.
- [x] **Prep Plans (autonomous planning)** — `0131`, `lib/planning/prep.ts` (10 tests), `/dashboard/prep-plans`, `seed_prep_plans.sql`.
- [x] **Life Readiness (horizon rollup)** — `lib/readiness/assess.ts` (11 tests), embedded on `/dashboard/readiness`.
- [x] **Intent-Based UX** — `lib/intent/detect.ts` + command-bar integration (18 tests).
- [x] **Auto-refresh cron** — `lib/planning/refresh.ts` (8 tests) + `app/api/cron/model-refresh` + `vercel.json`.
- [x] **Intelligence Network (full)** — `0132` consent + k-anonymity (`lib/network/insights.ts`, 9 tests)
  + informed-consent preview (`lib/network/contribution.ts`, 6 tests) + `0135` **aggregation pipeline**
  (`lib/network/aggregate.ts`, 9 tests; `network-aggregate` cron; real insights on `/dashboard/intelligence`).

### E. Full 500-record seed coverage
- [x] Every user-facing surface has a validated, idempotent 500-row seed (see the Seed-coverage tracker below).

---

**The nine pillars (build order is top-down from the reasoning core):**

1. **AI Operating Layer** — a *platform layer* (not per-feature AI) that continuously reasons
   across the whole household and answers: *What's most likely to go wrong tomorrow? What can be
   completed automatically today? Who's overloaded this week? What should the family decide next?
   What information is missing before an important event?* The AI is an **orchestrator**, not a
   collection of assistants.
2. **Household Digital Twin** ✅ SHIPPED — one continuously-updated model linking people,
   relationships, calendars, home, vehicles, pets, schools, finances, etc. **Both halves now built:**
   (a) **decision simulation** (`lib/twin/simulate.ts`, `/dashboard/family-digital-twin`) — "if we
   accept this tournament, what has to move?"; and (b) the **cross-domain linked model** — the
   Knowledge Graph (see below): a wired **twin projector** (`lib/twin/project.ts` + `projectTwinAction`)
   reads the family's real members/pets/vehicles/schools/teams/routines/places/accounts and
   materializes them as typed graph entities + edges, kept in sync on demand. Remaining scope:
   auto-refresh on data change (currently a one-tap "Rebuild from data") + doctors/smart-home once
   those domains land.

★ **Knowledge Graph — the reasoning substrate** ✅ SHIPPED (moat build) — migration `0129`
   (`graph_entities` + `graph_edges`, typed nodes + directed weighted edges, family RLS), pure
   engine `lib/graph/reason.ts` (16 tests: index/neighbours/`findPath`/`reachable`/`propagateImpact`
   impact blast-radius/`hubs`/`orphans`/`describePath`), `/dashboard/graph` ("Reasoning Graph")
   with path-finder, connection view, impact ripple bars, hubs, add-entity/link, and **Rebuild from
   data** (twin projector). 500-row `seed_graph.sql`. This is what lets the AI *reason across*
   relationships (Emma→Soccer→Field→Weather→Dinner) instead of retrieving isolated rows.
3. **Family Intelligence Layer / Playbook** — every interaction improves understanding; build a
   family playbook (favorite meals, birthday/holiday traditions, travel styles, homework habits,
   shopping patterns, communication styles). Family stays in control (visible + editable — the
   Knowledge Base `family_facts` is the seed of this).
4. **Outcomes, not features** — organize around goals (**Run Today · Feed the Family · Plan a Trip
   · Prepare for School · Manage Money · Keep Everyone Healthy · Celebrate Together · Prepare for
   the Unexpected**); the AI picks the underlying capabilities automatically.
5. **Family Command Center** — a concise morning operational briefing (today's priorities,
   conflicts, weather impacts, budget alerts, deliveries, health reminders, school updates, AI
   recs) and an evening summary of what changed + tomorrow prepped. *(Scaffolds exist:
   `/dashboard/command-center`, `/dashboard/briefing` — unify + make the briefing generative.)*
6. **Specialized AI agents behind one interface** ✅ SHIPPED — Chief of Staff · Scheduler · Meal
   Planner · Budget Coach · Household Manager · School Coordinator · Health Guide · Travel Planner ·
   Memory Keeper · Communications Assistant. User sees one assistant; agents collaborate internally.
   - Pure `lib/agents/roster.ts` (**11 tests**): 10-agent roster; `runAgent`/`chiefOfStaff`/
     `runAllAgents` turn a real `AgentContext` into per-agent briefings (status + deep-linked items);
     Chief of Staff synthesizes the top items across specialists.
   - Migration `0127_agent_activity.sql` — durable, family-scoped RLS log of what each agent
     surfaces/does (kind/severity/status, done/dismissible). PG16-validated (RLS, constraints, trigger).
   - `/dashboard/agents` (`components/modules/agents-module.tsx`): server reads a real snapshot →
     live briefings; roster grid w/ status dots; per-agent items + recent activity (Done/Dismiss
     writes back). Nav: Suggested → Family Assistant (`Bot`, free). 100% Supabase.
   - Seed `supabase/seed_pillar6_agents.sql` — 500 activity records across all 10 agents (idempotent).
   - Verified: tsc · eslint · **1723 vitest** · build.
7. **Family Operating Index (FOI)** — measure how well the household is *functioning* (not to
   judge): planning confidence, schedule stability, financial preparedness, household readiness,
   communication responsiveness, routine completion, goal progress. Surface **practical
   suggestions**, not vanity scores. **← FIRST SLICE, building now.**
8. **Design for Calm** ✅ SHIPPED — fewer notifications, ONE prioritized inbox, an AI daily digest,
   gentle escalation only when necessary. Reduces mental load; does not maximize engagement.
   - Pure `lib/calm/inbox.ts` (**7 tests**): `buildCalmInbox(items)` folds every signal source
     (agents · autopilot · Operating Index · approvals · reminders) into ONE de-duplicated, ranked
     list — `needsYou` (action only, capped), `today` (attention, capped), and a `quieted` count for
     the rest; `calmDigest` writes the gentle one-liner; `noiseReduced` = notifications spared.
   - `/dashboard/calm` (`components/modules/calm-module.tsx`): server reads the real sources → the
     calm inbox; a digest header, "Needs you" + "For today" sections, and everything else
     deliberately collapsed. **No migration** (pure aggregation of shipped tables). 100% Supabase.
   - Nav: Suggested → Calm (`Leaf`, free). Verified: tsc · eslint · **1730 vitest** · build.
9. **Family API** ✅ SHIPPED (hub) — the orchestration hub that *connects* external services
   (calendars, email, banking, grocery/delivery, smart home) rather than replacing them.
   - Pure `lib/connections/providers.ts` (**8 tests**): the provider registry (11 providers × 5
     categories) + `mergeConnections(rows)` folding the catalog with a family's saved connections
     (live-wins-over-disconnected), `groupByCategory`, `connectedCount`.
   - Migration `0128_family_connections.sql` — durable, family-scoped RLS connection records
     (provider/category/status/account_label/last_synced_at; `unique(family_id,provider,external_account_id)`).
     PG16-validated. **No tokens stored here** — those belong in a secret store.
   - `/dashboard/connections` (`components/modules/connections-module.tsx`): grouped provider hub,
     Connect (upsert a real connection) / Disconnect, live status, realtime. 100% Supabase.
   - Nav: Suggested → Connections (`Network`, free). Seed `supabase/seed_pillar9_connections.sql`
     (500 records, all providers × statuses, idempotent).
   - **Gated for later (needs provider keys):** the actual OAuth/token exchange + live two-way data
     sync per provider. The hub, model, and CRUD are production-ready now; enabling a provider = wiring
     its OAuth against these records. Verified: tsc · eslint · **1738 vitest** · build.

### ▶ Slice 1 ✅ SHIPPED: Family Operating Index — the measurable core of the Operating Layer
- [x] **Schema** `0125_family_operating_index.sql` — append-only daily snapshots (composite +
  per-dimension jsonb + suggestions), family-scoped RLS (select/insert/update), one row/family/day
  (`unique(family_id, as_of_date)`). PG16-validated: idempotent re-run, upsert-in-place, RLS + 3 policies.
- [x] **Engine** `lib/operating-index/score.ts` (pure, **12 tests**) — `computeOperatingIndex(snapshot,
  now)` → 7 dimension scores (0–100) + weighted composite + band (thriving/steady/stretched/overloaded)
  + ranked practical suggestions (each deep-linked) + `mostLoaded()` overload detection. Deterministic,
  DOM-free. Calm/empty household reads as *thriving*, never zero.
- [x] **Server** `lib/operating-index/server.ts` — builds the snapshot from real tables (calendar,
  reminders, chore_assignments, documents, maintenance, bills, approvals, votes/polls, goals + reuses
  `detectConflicts`), computes, **upserts today's snapshot idempotently**, returns current + prior
  composite for the trend arrow. **✅ FULLY WIRED (2026-07-05):** every input now reads live data —
  `overspentBudgets` (budgets vs this-period expenses, pure/tested `lib/operating-index/inputs.ts`, 7
  tests), `negativeBalances` (financial_accounts < 0, excl. credit), `lowInventory` (pantry ≤
  low_threshold), `eventsMissingInfo` (upcoming events needing a location), `unreadThreads`
  (conversations not read by all active members). No stubs remain. tsc/eslint/vitest/build green.
- [x] **Route** `/dashboard/family-operating-index` — composite ring dial + band, trend vs. yesterday,
  "Do these next" ranked suggestions (deep-linked), per-dimension bars w/ honest one-line summaries,
  "who's overloaded" line. 100% Supabase.
- [x] **Nav** entry (Operating Index, `Gauge`, minLevel 0 → free + auto in Navigation Choices catalog).
- [x] **Verified** tsc · eslint · **1661 vitest** · `next build`; migration validated on PG16.

### ▶ Slice 2 ✅ SHIPPED: "Since yesterday" evening recap (pillar #5, off the FOI snapshot)
- [x] **`lib/operating-index/summary.ts`** (pure, **8 tests**) — `summarizeChange(current, prior)`
  diffs two FOI snapshots → headline + composite delta + improved/declined dimensions (≥5-pt moves)
  + resolved/emerged suggestions (by id). Calm end-of-day tone; leads with cleared items; silent on
  a flat day. First-reading path handled.
- [x] **Server** now reads the prior **full** snapshot (dimensions + suggestions) and returns
  `change: ChangeSummary` alongside the index.
- [x] **"Since yesterday" card** on `/dashboard/family-operating-index` (headline + cleared/new/±dim
  chips). Reuses the state vector — zero contended files touched. tsc/eslint/**1669 tests**/build.

### ▶ Pillar #4 ✅ SHIPPED: Outcomes-not-features launcher
- [x] **Engine** `lib/outcomes/launcher.ts` (pure, **10 tests**) — the eight outcomes (Run Today ·
  Feed the Family · Plan a Trip · Prepare for School · Manage Money · Keep Everyone Healthy ·
  Celebrate Together · Prepare for the Unexpected); `buildOutcomePlan(id, ctx)` assembles each
  outcome's capability steps (deep-linked) and auto-badges the urgent ones from a real
  `OutcomeContext` (events today, overdue tasks, birthdays soon, open grocery items);
  `outcomeUrgencyCount` for the card badge. DOM-free.
- [x] **Route** `/dashboard/outcomes` — server reads the real family snapshot (count queries +
  birthday compute), builds badged plans, hands them to `components/modules/outcomes-launcher.tsx`
  (goal-first picker → the exact capabilities to get it done, with live badges). 100% Supabase, no
  new migration (reads existing tables).
- [x] **Nav** entry (Suggested → Outcomes, `Wand2`, minLevel 0 → free + in Navigation Choices catalog).
- [x] **Verified** tsc · eslint · **1709 vitest** · `next build`.

**Next slices (build order):** #1 wire the five orchestrator questions ("what's likely to go wrong
tomorrow / who's overloaded / what to decide next / what info is missing") off the same snapshot ·
#2 turn the snapshot into the Digital Twin's state vector for simulation · adopt `summarizeChange`
inside the existing Command Center / Daily Briefing surfaces (ui lane — coordinate vs. parallel session).

*(Why FOI first: it's the one pillar with no existing surface, it forces the reasoning core to
read across the entire household — the seed of pillar #1 — and it makes the north-star metric
[reduced admin effort] measurable from day one. Later slices reuse its snapshot as the twin's
state vector and the Command Center's evening "what changed" source.)*

---

## ☐ OPEN WORK TRACKER (single source of truth for what's left — keep in sync)

### 🌱 Test-data / seed coverage (as of 2026-07-05)
**37 seed files** exist under `supabase/` — most domains have a 500+-record `*_one_family.sql`
(scoped to The Kramer Family `92298eb2…`, idempotent): calendar · tasks · chores · meals(+extras) ·
finances · finance-hub · memories · messages · wallet(+ledger) · voice · location · family · family-safety ·
files · planning · food · home · roles(#8) · pillars 1–6 & 9. **NEW `seed_operating_index_one_family.sql`**
(≈613 records) lights up the FOI (#7) end-to-end — every wired input fires (overspent budgets, a
spendable account < 0, low pantry, expiring docs, overdue maintenance/reminders, off-track goals,
missing-location events, colliding events for conflicts). Run it, then open
`/dashboard/family-operating-index`.
- [x] **Remaining seed gaps closed ✅ (2026-07-10).** The two genuine gaps are now seeded at 500:
  **FOI snapshot history** — `seed_operating_index_history.sql` (500 daily `family_operating_index`
  snapshots, gentle wave + band spread) so the FOI **trend line** + day-over-day recap render (was
  "first reading" until history existed); and **`meal_votes`** — `seed_meal_votes.sql` (500 votes +
  ~1,000 options, open/closed spread) for the comms dimension + `/dashboard/voting` volume. Both
  idempotent, PG16-validated, in `SEED_ALL.sql` (now 45). *(Already covered at 500: `autopilot_suggestions`
  + `approval_requests` via `seed_autopilot.sql`; `family_polls` via `seed_group_decisions_one_family.sql`.)*
- ☑ **NEW `seed_group_decisions_one_family.sql`** (≈1,300 rows: 100 polls / 400 options / ~800 votes)
  fully exercises T6 AI-facilitated group decisions — categories, budgets, dietary tags, and biased
  votes so the consensus engine's recommendations AND vote-vs-fit conflicts render (also gives
  `family_polls`/options/votes real volume). Run it, open `/dashboard/voting`.
- ☑ **NEW `seed_ai_feedback_one_family.sql`** (600 rows) exercises T7 "Why this?" feedback log —
  all 6 surfaces (insight/autopilot/agent/voting/decision/briefing) × 5 signals, over the last ~60 days.
- ☑ **NEW `seed_experience_audits_one_family.sql`** (540 rows) exercises T8 Experience Scorecard —
  30 surfaces × 18 dates over ~68 days, upward trend, accessibility weakest, 4 surfaces below the bar.
- ☑ **NEW `seed_life_events_one_family.sql`** (567 rows) exercises T9 Life & Milestones — 44 plans
  (active/completed/archived) × ~493 dated checklist items + 30 learned facts. Run it, open `/dashboard/life-events`.
- ☑ **NEW `seed_activation_events.sql`** (~820 rows / 220 cohorts) exercises T10 TTFV — signup→first-value
  funnel with a realistic TTFV distribution + session-1 spread. Cross-family telemetry; open `/dashboard/onboarding-funnel`.

### A. Operating Layer slices still to build (agent-doable, build top-down)
- [x] **Slice 1 — Family Operating Index** (engine + page + 0125). PR #227. ✅
- [x] **Slice 2 — "Since yesterday" evening recap** (pillar #5, off the FOI snapshot). PR #228. ✅
- [x] **Slice 3 — Orchestrator questions** (pillar #1) ✅: the five daily questions —
  *what's most likely to go wrong tomorrow · what can auto-complete today · who's
  overloaded this week · what should we decide next · what info is missing before an
  important event.* Pure `lib/operating-index/orchestrator.ts` (**10 tests**) over the
  FOI snapshot + a tomorrow slice; reads open ≥90-confidence `autopilot_suggestions`
  for Q2 (read-only reuse, no engine edit); "Your family chief of staff" section on the
  FOI page. tsc/eslint/**1679 tests**/build.
- [x] **Slice 4 — Command Center adopts the recap** (pillar #5) ✅: shared server-safe
  `components/operating-index/change-recap.tsx` renders the "since yesterday" narrative from a
  `ChangeSummary`; the FOI page and `/dashboard/command-center` both reuse it (DRY), and it's also
  surfaced in the `/dashboard/briefing` **Evening** tab (via an optional `recap` prop). Seed
  `seed_operating_index_all_families.sql` writes yesterday+today snapshots across ALL families so
  the recap renders a real narrative everywhere (composite move + cleared/new + dimension shifts).
  tsc/eslint/1699 tests/build; migration 0125 + seed validated on PG16 (idempotent).
- [x] **Slice 5 — Household Digital Twin: decision simulation** (pillar #2) ✅: pure
  `lib/twin/simulate.ts` (**10 tests**) `simulateDecision(decision, ctx)` — safe "what-if" that
  runs against real data but writes nothing. Two scenarios: **add a commitment** ("if we accept this
  tournament, what has to move?" → overlaps as blockers, tight turnarounds, heavy-week load) and
  **a big spend** ("can we add two nights and stay in budget?" → real budget-vs-transactions
  headroom). Server action `simulateDecisionAction` (family-scoped reads) + client `DecisionSimulator`
  on `/dashboard/family-digital-twin`. tsc/eslint/**1679 tests**/build. *(Full linked state-vector
  reuse of the FOI snapshot = follow-up; this slice ships the category-defining simulation first.)*
- [x] **Slice 6 — Family Playbook** (pillar #3) ✅: Bubaly learns durable preferences/traditions
  from real usage and proposes them; the family confirms → real `family_facts` rows.
  Migration `0126_family_playbook.sql` (`family_playbook_suggestions`: category/label/value/
  evidence/confidence/signature/status suggested→accepted/dismissed/`fact_id`, `unique(family_id,
  signature)`, family-scoped RLS). Pure `lib/playbook/learn.ts` (**10 tests**) `learnPlaybook(signals)`
  → deduped/ranked/capped suggestions from meal/grocery/favorite/tradition signals. Server actions
  `refreshPlaybookAction` (mines meal_plans+meals, grocery_items, family_favorites, yearly
  calendar_events → upsert, `ignoreDuplicates` so dismissed/accepted never resurface) /
  `acceptSuggestionAction` (writes family_facts) / `dismissSuggestionAction`. `/dashboard/playbook`
  (`components/modules/playbook-module.tsx`: review cards w/ confidence + evidence, Save/Dismiss,
  realtime) + nav (Family AI OS, `Wand2`, free). Seed `seed_playbook_all_families.sql` across ALL
  families. tsc/eslint/**1699 tests**/build; migration+seed validated on PG16 (idempotent).
- [x] **Slice 7 — Outcomes launcher** (pillar #4) ✅: goal launcher at `/dashboard/outcomes`
  ("Run Today / Feed the Family / Plan a Trip / …") auto-selecting capabilities. Seed `seed_pillar4_outcomes.sql`.
- [x] **Slice 8 — Specialized agents behind one interface** (pillar #6) ✅: `lib/agents/roster.ts`
  (10-agent roster + Chief of Staff, 11 tests), `agent_activity` (`0127`), `/dashboard/agents`.
  **Now graph-aware** — the Chief of Staff reasons over relationships (`lib/agents/graph-insight.ts`).
  Seed `seed_pillar6_agents.sql`.
- [x] **Slice 9 — Design for Calm** (pillar #8) ✅: `lib/calm/inbox.ts` (one prioritized inbox +
  digest, 7 tests), `/dashboard/calm`. Seed `seed_pillar8_calm.sql`.
- [x] **Slice 10 — Family API** (pillar #9) ✅ (hub, functionally key-gated): `0128_family_connections.sql`,
  `lib/connections/providers.ts` (8 tests), `/dashboard/connections`, Connect/Disconnect CRUD.
  Seed `seed_pillar9_connections.sql`. **Remainder: OAuth token exchange + live sync needs provider keys.**

### B. Smaller follow-ups (agent-doable)
- [x] FOI financial dimension: real **budget-overspend** (budgets vs expenses) + **negative
  ledger balance** detection ✅ — all 5 previously-hardcoded inputs now read live data via pure
  `lib/operating-index/inputs.ts` (`countOverspentBudgets`, 7 tests); `negativeBalances` excludes
  credit cards; `lowInventory`/`eventsMissingInfo`/`unreadThreads` wired too. FOI is 100% Supabase-wired.
- [x] Onboarding: anonymous **pre-family telemetry** ✅ — shipped as `0133_onboarding_events.sql` +
  `lib/analytics/onboarding.ts` + `onboarding-track.ts` (wired into the wizard) + super-admin
  `/dashboard/onboarding-funnel` (+ the **T10 TTFV / activation** panel: `0146_activation_events.sql`,
  `lib/analytics/activation.ts`). (Was a stale duplicate of Section C — verified done.)
- [x] AI Concierge: **write-back of accepted recommendations** ✅ — the module creates/updates/deletes
  `concierge_plans` and converts a plan → real `calendar_events`. (Stale duplicate of Section C — verified done.)

### C. Human-owned / blocked (NOT agent-doable — surfaced, not buildable here)
- [ ] **Apply pending prod migrations 0125→0132** (`supabase db push`, or paste each in the
  Supabase SQL editor). **Highest leverage** — the whole reasoning layer (FOI, playbook, agents,
  connections, knowledge graph, decisions, prep plans, network consent) reads these; they silently
  no-op in prod until applied (this is why the seed hit the missing `habits` table).
  *Agent cannot execute — no prod DB creds/CLI in sandbox (verified).*
- [ ] **Set `CRON_SECRET` in prod** → activates the `model-refresh` cron (twin + prep-plan auto-refresh).
- [ ] **VAPID/FCM keys** → lights up the push path (already built).
- [ ] **Maps/ETA key** (Friction #6 travel buffer) · **GIF provider key** (Messages picker) ·
  **Stripe Issuing** (real-time Wallet card balances) · **CI Supabase login** (authed e2e).

---

## Roadmap features (from the product roadmap)

### 1. Marketplace — "Buy, sell, rent, borrow within the platform"  ☑ DONE
- [x] Migration `0120_marketplace.sql`: `marketplace_listings` (kind sell/rent/borrow/free/wanted, price_cents, rent_period, category, condition, status, claimed_by), `marketplace_offers` (interest/claim/offer), family-scoped RLS. Validated: all 120 migrations apply on PG16, idempotent re-run clean, RLS+trigger+FK verified.
- [x] Types for both tables in `lib/database.types.ts`.
- [x] `lib/marketplace/listings.ts` — labels, money math, filter/rank, offer/claim state machine (pure). Tests `tests/marketplace-listings.test.ts` (10 tests).
- [x] `components/modules/marketplace-module.tsx` — browse+filter, post/edit, interest/claim, owner offer review (accept→hand-off, decline), withdraw/complete. 100% Supabase via `useRealtimeQuery`.
- [x] Route `/dashboard/marketplace` + admin-only `/dashboard/marketplace/seed` (500-record test seed screen).
- [x] Nav entry (Family & Home group, `Store` icon).
- [x] Verified: tsc, eslint, vitest (1562), build.
#### ▶ Marketplace V2 — the AI-first marketplace (owner design, 2026-07-09) — FULL INCORPORATION CHECKLIST

> **Owner directive:** incorporate the provided design as the `bubaly.com` marketplace page.
> "The world's easiest AI-first marketplace — buy, sell, rent, borrow, lend & more, all in one
> trusted community." Keep the **bubaly global header**; the section rail's **Home** returns to the
> bubaly landing; **no marketplace-specific Messages** — the Messages entry routes to the ONE bubaly
> Messages surface. 100% Supabase-wired, 100% production ready.

**Schema + engines (shipped ✅):**
- [x] Migration **`0151_marketplace_v2.sql`** — `marketplace_stores` (one storefront/member) ·
  `marketplace_follows` · `marketplace_saves` (♥) · `marketplace_collections`+`_items` ·
  `marketplace_orders` (requested→confirmed→active→returned→completed/cancelled) ·
  `marketplace_reviews` (two-sided, 1–5★, one per side per order) · listing kinds widened with
  **`swap` + `donate`**. All family-scoped RLS; validated idempotent on PG16.
- [x] Types for all 7 tables in `lib/database.types.ts`; `swap`/`donate` in `lib/marketplace/listings.ts`.
- [x] Pure **`lib/marketplace/trust.ts`** — `computeTrustScore` (volume-scaled ratings + completed
  exchanges + activity − disputes; new members start at 50 "Building"), `ratingSummary`.
- [x] Pure **`lib/marketplace/discover.ts`** — `aiPicks` (badges: AI Match · Hot Rental · Great Deal ·
  Borrow Nearby · Trending · New Today, variety-first), `activityFeed` ("Sarah rented a dress · 2 min
  ago"), `rankCreators`. **14 tests** across both engines.
- [x] Server actions: `toggleSaveAction` · `toggleFollowAction` · `upsertStoreAction` ·
  `setOrderStatusAction` (legal-transition-enforced) · `leaveReviewAction` (completed orders only,
  both parties, one review per side).
- [x] Accepting an offer now records a **`marketplace_orders`** row (best-effort) — offers→orders→
  reviews→trust is one connected loop.

**Surfaces (shipped ✅):**
- [x] **`/dashboard/marketplace`** — the V2 home inside the bubaly global frame: hero ("AI-first
  marketplace" + trust chips + featured cards) · 8-tile action grid (Sell/Rent/Lend/Borrow/Request/
  Donate/Swap/Create Store) · **AI Picks for You** (badged, ♥-save) · AI Buyer Assistant + Request &
  Get Matched (live match count) + Verified-Trusted-Safe row · Browse by Category · Popular
  Collections · right rail: **AI Marketplace Assistant** (prompt chips → the ONE bubaly assistant) ·
  Recent Activity · Top Creators (Follow) · **Your Trust Score** · Safety First.
- [x] **Single left rail (fix, 2026-07-09):** the Marketplace rail now REPLACES the global bubaly
  sidebar *body* on `/dashboard/marketplace*` (swapped inside the same AppShell `<aside>`), so the
  Bubaly logo + global top header stay and there's ONE rail — not the global nav + a second rail.
  "Your Trust Score" moved to the bottom of the rail (client-computed via `SidebarTrustScore`),
  matching the design; the page's right rail is now Assistant · Nearby Activity · Top Creators ·
  Safety First. `next build` green (9 routes).
- [x] Marketplace **section rail** (`components/marketplace/marketplace-nav.tsx`): Marketplace ·
  **Home → `/dashboard`** (bubaly landing) · AI Assistant · Browse · Requests · Rentals · Borrow &
  Lend · Buy & Sell · Donate · Swap · Collections · Creators · My Store · My Listings ·
  **Messages → `/dashboard/messages`** (global bubaly Messages — no marketplace inbox) · Orders ·
  Reviews · Saved · **Verifications → `/dashboard/trust`** · Post an Item.
- [x] **`/browse`** — the full board (existing realtime module) + match strip; rail-driven via
  `?kind=` `?cat=` `?q=` `?post=1&kind=` (deep-linked post modal).
- [x] **`/saved`** · **`/orders`** (lifecycle controls + leave-review) · **`/reviews`** (received/given
  + your rating) · **`/collections`** (grid + detail) · **`/creators`** (ranked storefronts + Follow) ·
  **`/store`** (storefront editor + follower/rating/listing stats + My Listings).
- [x] Seed **`seed_marketplace_v2.sql`** (~1,200 rows: stores, follows, 6 collections + 150 items,
  300 saves, 300 orders across the status spread, ~500 two-sided reviews; in `SEED_ALL.sql`, now 42).
  PG16-validated ×2 (idempotent). Verified: tsc · eslint · **vitest (34 marketplace)** · `next build`
  (all 9 routes).
- [x] ⚠️ apply **`0151`** to prod (see `docs/PENDING_PROD_MIGRATIONS.md`). Safe before apply: every
  V2 read is best-effort — the home renders with empty rails and the 0120 board still works.

- [x] **Marketplace top-level URL move ✅ SHIPPED (2026-07-09, #275).** The whole surface moved from
  `/dashboard/marketplace*` to top-level **`/marketplace*`** (home, `/browse`, `/collections`,
  `/creators`, `/store`, `/orders`, `/reviews`, `/saved`, `/seed`) under `app/(app)/marketplace/`.

- [x] **Listing photos ✅ SHIPPED (2026-07-09, #277).** Cards + post/edit now render `photo_url`:
  listing cards show the image as a header (`object-cover`) with a gradient + kind-icon placeholder
  fallback; the post/edit form has a **Photo URL** field with a live preview. Seed
  `seed_marketplace.sql` gives all 500 listings a photo (`picsum.photos`). PG16-verified · tsc ·
  eslint · `next build`. *(Still open: a Supabase Storage **upload** path — bucket + policies — so
  owners can attach a file instead of pasting a URL; owner decision on storage.)*

- [x] **Listing detail page ✅ SHIPPED (2026-07-09, #278).** Clicking a listing now opens a real
  detail page — **`/marketplace/item/[id]`** (`app/(app)/marketplace/item/[id]/page.tsx`),
  server-rendered, family-scoped via RLS. Hero photo (with placeholder), title/price/category/
  condition/location/description + live status, a **seller trust card** (`computeTrustScore` from the
  seller's real reviews received + completed orders + listings posted → score, band, star rating, top
  factor; links to the seller's storefront when present), and this listing's reviews. Actions: **Save
  (♥)** + an **Interest/Claim** CTA via the new guarded server action **`makeOfferAction`** (rejects
  own-listing / closed / duplicate open offers; flips an `available` listing to `pending`) driving the
  optimistic **`InterestButton`** client component. Listing cards now **deep-link** to it from the
  browse module (photo + title) and the marketplace home hero + AI picks (were browse-search links).
  Verified: tsc 0 · eslint 0 · `next build` 0 (`/marketplace/item/[id]` registered) · Vercel preview
  deployed green.

**Remaining to reach the full design vision (open):**
- [ ] **Listing photo uploads** — render + URL capture + seed shipped (#277); still needs a Supabase
  Storage bucket + policies (owner decision on storage) so owners can upload a file, not paste a URL.
- [ ] **Real LLM marketplace assistant** — the rail panel routes to the bubaly assistant with prompt
  chips today; a marketplace-tuned conversational flow ("is this a fair price?") is key-gated on the
  LLM key (B3) and should route through the ONE assistant, not a second chat.
- [ ] **"Post in under 60 seconds with AI"** — AI-drafted listing (title/category/price suggestion
  from a photo or one sentence); LLM-key-gated (B3).
- [ ] **Secure payments** — real checkout/escrow is Stripe-gated (B3/owner); today amounts are
  recorded on orders and settled off-platform (family context makes this acceptable pre-keys).
- [ ] **Geo "near me" distances** — needs the Maps key (B3); location is stored free-text today.
- [ ] **Cross-family network marketplace** — the design's "community" reach beyond one household
  rides on the Intelligence-Network consent rails (`network_consent`) — a strategy decision (§A).

- [x] **Match intelligence (next level) ✅ SHIPPED (2026-07-09).** The board is now proactive:
  it connects open **`wanted`** requests to the supply already posted (`sell`/`free`/`rent`/`borrow`)
  — *"You're looking for a bike; Mom listed a balance bike for free."* Pure `lib/marketplace/matches.ts`
  (`computeMatches`/`scoreMatch`/`titleTerms`, **10 tests**) scores each wanted↔supply pair by shared
  category + title-term overlap + a free bonus, never matches a member to their own supply, caps per
  wanted. Server `matches-server.ts` (`loadAndSnapshotMatches`) computes from live listings + persists
  to **`marketplace_matches`** (`0150`, family-scoped RLS, one row per wanted/supply) **preserving
  dismissals**. A "Matches on the board" strip (`components/marketplace/matches-strip.tsx`) sits atop
  the board (now `/dashboard/marketplace/browse` under V2) with Got-it / Dismiss (`setMatchStatusAction`). Seed
  `seed_marketplace_matches.sql` (500 rows, status spread; in `SEED_ALL.sql`). Verified: tsc · eslint ·
  **vitest (10 match + 10 listings)** · `next build`; migration + seed validated on PG16 (500 rows,
  idempotent). ⚠️ apply `0150` to prod (see `docs/PENDING_PROD_MIGRATIONS.md`).

- [x] **Saved Searches & Alerts ✅ SHIPPED (2026-07-09).** "Alert me when someone lists X." A member
  saves a standing search (keyword + optional kind / category / price ceiling); **`/marketplace/alerts`**
  matches it against the live board and badges what's **NEW** since they last looked (`last_seen_at`
  cursor). Pure `lib/marketplace/saved-search.ts` (`listingMatchesSearch`/`matchesForSearch`/
  `countNewSince`/`describeSearch`, **12 tests**) — AND-combined criteria, all-terms keyword match over
  title+description, price ceiling on priced kinds only, excludes the viewer's own supply. Table
  **`marketplace_saved_searches`** (`0152`, family-scoped RLS, PG16-validated) + types; server actions
  (`createSavedSearchAction`/`deleteSavedSearchAction`/`markSearchSeenAction`); client `AlertComposer` +
  `AlertActions`; nav entry (Alerts, `BellRing`, additive). Pull-based (no notification hook → zero
  collision with the board). Seed `seed_marketplace_saved_searches.sql` (500 alerts, varied criteria,
  idempotent). Verified: tsc · eslint · **vitest (12)** · `next build` (`/marketplace/alerts`).
  ⚠️ apply `0152` to prod.

- [x] **Marketplace Pulse ✅ SHIPPED (2026-07-09).** A read-only intelligence view at
  **`/marketplace/insights`** — supply by kind, **where demand outruns supply** (open `wanted` vs
  available per category), **price benchmarks** (median/avg per category), and **what's hot** (saves ×2
  + offers ×3). Pure `lib/marketplace/insights.ts` (`marketplaceInsights`, **6 tests**); reads existing
  listings/saves/offers (NO new schema — the existing marketplace seeds populate it). Nav entry (Pulse,
  `Activity`, additive). Verified: tsc · eslint · **vitest (6)** · `next build` (`/marketplace/insights`).

- [x] **Listing Q&A ✅ SHIPPED (2026-07-09).** "Ask a question" on any listing — public within the
  family. Inline thread on the item detail page (`ListingQuestions`: buyers ask, the owner answers
  inline, realtime) + a seller **Questions inbox** at `/marketplace/questions` (Needs-your-answer / Your
  questions / Answered). Table **`marketplace_questions`** (`0153`, family-scoped RLS, PG16-validated) +
  types; pure `lib/marketplace/questions.ts` (`categorizeQuestions`/`unansweredCount`/`isAnswered`,
  **5 tests**). Nav entry (Questions, `MessageSquare`; one surgical mount on the detail page). Seed
  `seed_marketplace_questions.sql` (~400 Q&A, ~half answered by the owner). Verified: tsc · eslint ·
  **vitest (5)** · `next build`. ⚠️ apply `0153` to prod.

- [x] **Following feed ✅ SHIPPED (2026-07-09).** Seller-based discovery to complement keyword Alerts:
  **`/marketplace/following`** shows the latest browsable listings from the creators/stores you follow,
  newest first, each with store attribution + a "NEW this week" flag. Pure `lib/marketplace/following.ts`
  (`buildFollowingFeed`/`newFromFollowingCount`, **5 tests**); reads existing `marketplace_follows` /
  `marketplace_stores` / listings (NO new schema). Nav entry (Following, `UserCheck`, additive).
  Verified: tsc · eslint · **vitest (5)** · `next build` (`/marketplace/following`).

- [x] **Curated demo dataset ✅ SHIPPED (2026-07-09).** **`seed_demo_account.sql`** — ~200 curated,
  tagged, idempotent rows across calendar / finances / bills / reminders / goals / documents /
  maintenance / pantry / knowledge / meals+polls / marketplace for the primary demo family (The Patel
  Family, 1111…), **schema-drift safe** (each table guarded so an unmigrated table is skipped, not
  fatal) and additive (tagged `Demo · ` / `[demo]`, never disturbs seed_prod). PG16-validated (populates
  present tables, skips absent, idempotent). *(NOTE: superseded as the demo's data source by the
  single-account rework at the top of this file — the one-click demo now seeds via `lib/demo/seed.ts` /
  `resetDemoData()`, not this SQL file, which still targets the persistent Patel family. The demo UI is
  the parallel session's `components/demo/demo-experience.tsx` + `lib/demo/config.ts` +
  `useApp().demoExpiresAt`; the standalone `demo-timer.tsx` was removed in #292.)*

### 2. Wallet — "Full family financial OS"  ◐ (already wired)
Has `wallet_cards/passes/rewards` (0113), `/wallet` route, `lib/wallet/*`. Audit confirmed the
surfaces read/write Supabase (10+ `.from()` calls, realtime). Remaining honest gaps:
- [ ] Spending cards / real-time balance (`money-cards-view.tsx`, `child-detail-view.tsx`) say "coming soon" — needs Stripe Issuing (legit future infra; keep honest until it lands).

### 3. Allowance — "AI allowance coaching"  ☑ DONE
Has `allowance_rules`, `lib/wallet/allowance.ts`, `lib/wallet/coach.ts`; surfaced under `/wallet`.
- [x] Confirmed: allowance schedule posts to the immutable ledger (cron `/api/cron/wallet-allowance` →
  `creditChildWallet`, split-allocated, advances `next_run_on`) and the AI coach reads real ledger balances.
- [x] **Parent control added:** `runDueAllowancesAction()` — a "Run due now" banner on `/wallet/allowance`
  (manager-only, Basic-gated, Trust-gated) pays every due rule, idempotent with the cron (no double-pay).
  Pure `dueAllowances(rules, today)` helper (+2 tests) drives the count/total. Was cron-only before.

### 4. AI Concierge — "Become category defining"  ◐ (already wired)
`/dashboard/concierge`, `lib/concierge/digest.ts`; module has 6 `.from()` + realtime. No mock data.
- [x] **Deeper write-back of accepted recommendations ✅ SHIPPED (2026-07-10).** An accepted concierge
  plan now materializes across MORE surfaces than the calendar — **calendar event · reminder · prep
  task** — via `applyConciergePlanAction`, each logged to **`concierge_plan_actions`** (`0158`,
  family-scoped RLS) so the flow is **idempotent** (never double-applies) + auditable. Pure
  `lib/concierge/apply.ts` (`planWriteBacks`/`reminderLeadAt`/`writeBackTitle`, 7 tests); client
  `PlanWriteBacks` "Make it happen" buttons in the plan detail (replaces the calendar-only button).
  Seed `seed_concierge_plan_actions.sql` (500 rows, balanced across the 3 kinds; in `SEED_ALL.sql`).
  Verified: tsc · eslint · **vitest (7)** · `next build`; migration + seed PG16-validated (idempotent).
  ⚠️ apply `0158` to prod.
- [x] **Onboarding deep dive — lifecycle + marketing-signal layer ✅ SHIPPED (2026-07-11).** Deep
  audit of onboarding for new accounts AND accounts needing reset. Found five gaps and closed them:
  (1) the funnel analytics (`lib/analytics/onboarding.ts`) was **missing the `value` step** the wizard
  added — fixed; (2) the `onboardingComplete` flag was **write-only dead data** read nowhere;
  (3) the huge **auto-provisioned cohort** (users `ensureActiveFamily` gives a space to, skipping the
  wizard — no questionnaire/goals/**no marketing profile**) was **invisible** with no path to finish;
  (4) **value-step engagement** (imported? events? time saved — the strongest activation signal) never
  reached marketing; (5) no durable, **segmentable** per-account onboarding record. New
  **`onboarding_progress`** table (`0159`, one row per account, self-scoped RLS) is the queryable
  lifecycle + marketing signal; pure **`lib/onboarding/completeness.ts`** (9 tests) scores completeness
  + flags the needs-setup / needs-reset cohorts; `ensureActiveFamily` now stamps the auto-provision
  cohort, both finalize actions record progress + feed **value engagement / completeness** to the CRM
  contact + `onboarding_completed` automation; new **`/dashboard/setup`** re-onboarding surface (live
  score + what's-left + questionnaire against the EXISTING family — never creates a second one) +
  **`resetOnboardingAction`**. Lifecycle rows now come only from real Auth users;
  the former synthetic-account seed was retired because direct `auth.users`
  inserts violated GoTrue invariants. Verified: tsc · **vitest (20: 9 completeness
  + 11 funnel)**; migration PG16-validated (idempotent ×2; cascade, CHECK, unique,
  trigger, RLS confirmed). ⚠️ apply `0159` to prod.

### 5. Family Memory — "Build persistent family knowledge graph"  ☑ DONE
`/dashboard/family-memory` + `/dashboard/family-knowledge-graph`, `lib/memories/*`.
- [x] Persistent store shipped — **Family Knowledge Base**: migration `0123_family_facts.sql` (family-scoped RLS; sizes/allergies/contacts/preferences/accounts, member-tagged or family-level, pinnable), pure `lib/memory/facts.ts` (8 tests: filter/search/group), `components/modules/knowledge-base-module.tsx` at `/dashboard/knowledge` (search + member/category filters, add/edit/pin/copy/delete). Nav: Family AI OS, `Brain` icon. Validated on PG16; verified tsc/eslint/1637 tests/build. *(The `/dashboard/family-knowledge-graph` visualization can now read this store.)*
- [x] **Learning layer shipped** — the **Family Playbook** (North Star slice 6, see above) mines real household usage into suggested facts the family confirms into this same `family_facts` store. `/dashboard/playbook` + `0126_family_playbook.sql`.

### 6. Voice Control — "Full conversational interface"  ☑ DONE
- [x] `lib/voice/command-router.ts` — wake-word stripping + intent routing → capture kind, reusing `suggestKind`/`parseEvent`. Tests `tests/voice-command-router.test.ts` (12 cases).
- [x] Migration `0121_voice_commands.sql` — family-scoped RLS history log. Validated on PG16 (RLS, 4 policies, check constraint, idempotent).
- [x] `components/modules/voice-module.tsx` — Voice Command Center: `useSpeechRecognition` mic + editable transcript + live routing preview → `saveCapture` (real rows) → logs `voice_commands` → toast w/ Undo. Recent-commands history (realtime) with one-tap re-run + delete. Graceful type-only fallback when Web Speech unsupported.
- [x] Route `/dashboard/voice` + nav (Family AI OS, `Mic` icon; auto-included in NAV_CATALOG / Navigation Choices).
- [x] **Test seed** `supabase/seed_voice_one_family.sql` + `db:seed:voice` — 500 `voice_commands` for the
  target family (task/note/event/shopping + failed/dismissed, ~90 days). Deterministic-UUID idempotency
  (no tag column). Validated on PG16 (500 rows, idempotent re-run). So `/dashboard/voice` history renders full.
- [x] Verified: tsc, eslint, vitest, build.

### 7. Phone Concierge — "AI receptionist for families"  ◐ (already wired)
`/dashboard/front-desk`; module has 8 `.from()` + realtime. Wired.
- [x] **OUTBOUND counterpart — "Bubaly calls FOR you" (closes opportunity-table gap #2: AI makes phone calls on behalf of families).** Full vertical slice, mobile-first, realtime, 100% Supabase:
  - Schema `0173_concierge_calls.sql` — `concierge_calls` (task_kind · callee · goal · details/brief jsonb · full lifecycle status · outcome/transcript/duration/attempts/provider_ref). Family-scoped RLS (4 policies via `is_family_member`), 3 indexes, `set_updated_at`. PG16-verified idempotent ×2.
  - Engine `lib/concierge-calls/brief.ts` — pure `buildCallBrief()` → opening · key points · per-task-kind questions · success criteria · fallback (never throws). **7 tests pass.** Types/labels/tones exported.
  - Types added to `lib/database.types.ts`; server actions `requestCallAction`/`cancelCallAction`/`requeueCallAction` (validated, audited); page `/dashboard/concierge-calls`; module `concierge-calls-module.tsx` (composer + stat tiles + status pills + expandable AI plan + outcomes).
  - Telephony **provider-gated** (`TWILIO_*`): `/api/concierge-calls/place` (CRON_SECRET) places queued calls when a provider is configured, else honestly flips to `action_needed` — usable end-to-end without a phone provider, lights up when one is added.
  - Seed `seed_concierge_calls.sql` (**500 rows**, every task_kind × status, briefs on every row) + added to `SEED_ALL.sql`. Idempotent ×2 on PG16.
  - Linked from **AI Front Desk** (inbound ↔ outbound), no global-nav change (standing rule). Verified tsc/eslint/vitest.

### 8. Email Concierge — "AI inbox management"  ◐ (already wired)
`/dashboard/inbox` Communications Hub; module has 10 `.from()` + realtime. Wired.

### 9. Predictive Planning — "Recommend next best actions"  ◐ (wired via Moments)
`lib/opportunities/deadlines.ts` + Moments engine surface next-best-actions on Home. Wired.
- [x] Dedicated "Next Best Actions" feed page — `lib/opportunities/next-actions.ts` (pure, 7 tests: bucketing overdue→someday, priority tie-break, human reasons) + `components/modules/next-actions-module.tsx` merging real events + open tasks + open opportunities into one ranked worklist at `/dashboard/next-best-actions` (nav: Suggested, `Target` icon). Inline task-complete. No migration (reads existing tables). Verified tsc/eslint/1629 tests/build.

### 10. AI Automation — "Multi-step autonomous workflows"  ◐ (already wired)
`/dashboard/family-automation`, `/dashboard/autopilot`, `lib/autopilot/engine.ts`. Wired.
- [x] #4 Fold ≥90%-confidence moment-prep steps into the Autopilot engine (reversible auto-exec) — `momentPrepSuggestions(snapshot)` in `lib/autopilot/engine.ts` reuses the shared `buildMomentPrep` to emit, for imminent (≤2d) moments, the two SAFE reversible steps at auto-tier: a **leave-by reminder** (conf 92 → reuses the existing `create_reminder` executor) and a **snacks/supplies grocery list** (conf 91 → new reversible `add_groceries` executor in `scan.ts` that inserts grocery_items). Weather/packing/photo stay as on-screen suggestions. 5 new engine tests (36 total). Verified tsc/eslint/1649 tests/build.

### 11. Home Management — "Maintenance and inventory automation"  ◐ (already wired)
`/dashboard/home`, `lib/home/maintenance.ts`, `lib/home/devices.ts`; module has 10 `.from()`. Wired.

### 12. Vehicle Management — "AI maintenance scheduling"  ◐ (already wired)
`vehicles` + `vehicle_registrations/inspections` (0037), `/dashboard/auto/vehicles`, `lib/auto/*`. Wired.

### 13. Family Operating System — "Own this positioning"  (meta)
- [x] Cross-feature cohesion (nav/customization): audited `NAV_CATALOG` (only `minLevel 0` items are customizable in Settings → Navigation Choices). This session's Knowledge Base + Next Best Actions were already free (0); per user decision, **Marketplace + Voice Control lowered to `minLevel 0`** so all four new features are free-tier and selectable in Navigation Choices (the pages were never plan-gated anyway).

---

## ★ "Largest opportunities" table audit (owner screenshot, 2026-07-12)
Compared all 10 opportunities against the codebase. **8 already shipped** (life-admin autopilot ·
knowledge graph · digital twin · verified marketplace · connected services · proactive agents ·
approvals · unified identity — plus AI-drafted replies via inbox `generateReply`). **Gap #2
(outbound AI phone calls)** is now BUILT this session — see roadmap #7 OUTBOUND counterpart above.
- [ ] **Remaining gap #10 — Open developer platform / third-party app ecosystem** (public API, OAuth
  app registration, webhooks-out, marketplace of integrations). This is a **strategic + human-owned**
  decision (API surface, partner program, security review) rather than a single agent-buildable slice —
  surfaced here, not silently built. All the internal engines it would expose are already Supabase-wired.

## ★ "Missing Competitor Features" matrix (owner screenshot, 2026-07-12) — full 28-row audit
Compared every row against the codebase (Cozi/Skylight/FamilyWall/TimeTree/Hearth/Maple/Ohai/
Family Assistant/OurHome benchmark). Verdicts grounded in actual routes/libs, not the table's guesses —
several "No" rows were already built here.

**Already built (table said Partial/No — verified in code):**
| # | Feature | Where it lives |
|---|---|---|
| 1 | Natural-language family planning | ⌘K command bar + `lib/capture` parser + Voice + assistant (create events/reminders/items from one sentence) |
| 2 | Automatic conflict detection | `/dashboard/conflicts` + conflict surfacing in Home/insights |
| 5 | Smart recurring routines | `lib/routines` + habits engine (streaks, adaptive) |
| 6 | School calendar sync | `/dashboard/family-school` + `lib/school` + `lib/sync` providers |
| 7 | Sports league integration | `/dashboard/family-sports` + `lib/sync` (provider adapters) |
| 8 | **Photo-to-calendar** (table said No) | `/dashboard/scan` + `/api/ai/flyer` — AI extracts events from a photographed flyer |
| 9 | Recipe import | `lib/recipes` + `/api/ai/import` |
| 10 | Shared family timeline | Activity feed + memory timeline + social-feed |
| 11 | Widgets | Capacitor + `lib/native` (mobile shell); per-role Home tiles |
| 12 | Large-screen family dashboard | `/dashboard/command-center` (TV/tablet Command Center) |
| 14 | Location arrival/departure automation | `/dashboard/locator` + `lib/location` (geofence triggers) |
| 15 | Smart shopping suggestions | grocery/pantry predictive suggestions (`lib/grocery`, `lib/pantry`) |
| 17 | Travel-time optimization | leave-by engine (`lib/opportunities/deadlines`); ETA API key = open item #6 |
| 18 | Multi-family collaboration | grandparent portal + family-access roles/permissions |
| 20 | Achievements & gamification | goals + streaks + rewards + economy (family-wide milestones live in goals/memory) |
| 21 | Apple/Google deep integration | `lib/google.ts` + `lib/sync/providers/*` + connections hub |
| 22 | Voice-first assistant | `/dashboard/voice` (full conversational, executes actions) |
| 23 | Personalized AI per member | per-member AI profiles/tone (`lib/tone`, agents) + role-aware surfaces |
| 24 | **Household operating metrics** (table said No) | `/dashboard/family-operating-index` (FOI weekly health score) |
| 25 | AI weekly family briefing | `/dashboard/weekly-briefing` + `home_briefs` (0140s) daily brief |
| 26 | **Automatic memory capture** (table said No) | `/dashboard/family-memory` + knowledge graph + on-this-day |
| 27 | **Household digital twin** (table said No) | `/dashboard/family-digital-twin` + `lib/twin` simulation |

**Genuine gaps → BUILT THIS SESSION (2026-07-12):**
- [x] **#3+#4 Household workload balancing + family workload analytics** (Hearth) — `/dashboard/workload`:
  pure engine `lib/workload/balance.ts` (per-member load from chore assignments (est_minutes) + todos +
  events, fairness index, overload flags, human-reason rebalance suggestions), one-tap "Move it" applies the
  reassignment; `workload_snapshots` table (0166) for week-over-week analytics; 500-row seed; linked from Chores.
- [x] **#16 Calendar heat maps** (TimeTree) — `lib/calendar/heatmap.ts` (pure busyness engine over the
  recurrence-expanded events, 0–4 levels, overload detection + advice) + Busyness card in Calendar. No new
  table — rides the already-seeded 500 events.
- [x] **#19 Child independence progression** (Hearth) — `/dashboard/independence`: age-banded milestone
  ladder across 6 domains (chores/money/safety/self-care/school/social), `independence_milestones` (0167),
  pure engine `lib/independence/progression.ts` (suggest-by-age, level compute), accept/achieve actions,
  per-child progress; 500-row seed; linked from Chores + Behavior.

**Remaining gaps (logged, not silently built):**
- [x] **#13 Offline mode — v1 (read-side) SHIPPED** (FamilyWall's headline behavior: "local caching
  with automatic synchronization when connectivity returns"). `lib/offline/cache.ts` (localStorage,
  per-family+table+query keys, 7-day TTL, 200-row cap, quota-safe, 4 tests) wired into
  `useRealtimeQuery` (every realtime module): instant paint from last-known rows, quiet offline
  (no error banner), auto-refetch on the `online` event; global `OfflineBanner` in the app shell
  (offline amber / "back online — syncing" flash); **cache wiped on sign-out** (privacy).
  - [ ] v2 (owner decision still): write-behind queue for offline MUTATIONS + conflict resolution —
    genuinely infrastructural, per-module opt-in.
- [ ] **#28 Family operating system API** — same as opportunity-table #10 (open developer platform):
  strategic + human-owned (public API surface, OAuth app registration, partner security review).

## Other open features (carried from the Friction Backlog / Scorecard)
- [x] #2 Universal ⌘K natural-language command bar — DONE. `lib/command-bar/route.ts` (pure, 8 tests) +
  `components/app/command-bar.tsx` (global palette in app-shell, ⌘K / "/" open, navigate/capture/assistant,
  reuses the Voice/capture parser). See the "⌘K + 💸" handoff block.
- [ ] #6 ETA-based travel buffer for leave-by (needs a maps/ETA API key).
- [x] #9 Admin-mobile table overflow — DONE. Audited every `<table>` under `app/(app)/admin` (27 total):
  14 already wrapped, **13 wrapped** in `overflow-x-auto` + `min-w-[720px]` (admins, users, audit-logs,
  audit, content, security, subscriptions, support-tickets, sync). Class-only; tsc/eslint/build green.
- [x] #7 Time-of-day Home Mission Control — DONE. `lib/home/time-of-day.ts` (pure, 6 tests: dayPhase /
  phaseGreeting / phaseBlurb / focusForPhase) + `components/home/time-of-day-focus.tsx` "Focus now" strip
  at the top of `/home` (morning: schedule/weather/school · night: tomorrow/get-ready/reflect). Additive —
  did not refactor the contended grid. Server-time based (no per-user tz yet).
- [x] #8 Role-tailored surfaces — **slices 1–4 shipped** (2026-07-10): (1) pure `lib/ui/role-surface.ts` (10 tests) —
  `roleSurface(role)` → { density, tone, canManage, focusMax } + `roleGreeting`/`focusHeadline` — applied
  to the Home "Focus now" strip (role-tailored heading + trimmed focus set for kids/guests). (2) **Nav
  management-affordance gating**: `NavItem.manage` + pure `isNavItemVisibleToRole` (4 tests) hide
  manager-only destinations (e.g. Kid Logins) from kids/teens/guests across the primary rail, All
  Services, and mobile tabs (super-admins still see them) — the page guards already redirect those roles,
  so the links were dead-ends. (3) **Density rollout**: pure `focusChipClasses(role)` (3 tests) maps
  `roleSurface().density` → chip sizing, wired into the Home "Focus now" strip — kids ('playful') get
  bigger, rounder, more-tappable chips; adults ('comfortable') keep compact ones; teens/guests ('cozy')
  sit between. Finally consumes the `density` field. (4) **Broader rollout**: the role-tailored
  `roleGreeting` now also leads the **personal dashboard** (parents formal · adults casual · kids a warm
  emoji line), extending the treatment beyond Home to a second primary surface. tsc/eslint/build green.
  **Slice 5 — APP-WIDE density (2026-07-12):** density was per-chip only; now it scales the *whole app*.
  `<RoleDensity/>` (mounted in AppShell) stamps `data-density` on `<html>` from the member's role, and
  a globals.css block scales the root font size (Tailwind rem cascades → text + padding + gaps together):
  parents 100% · teens/guests 104% · kids 110%. Added `resolveDensity` + `DENSITY_FONT_PCT`/labels to
  `lib/ui/role-surface.ts` (+7 tests) and a **Settings → Display comfort** control (`display-comfort.tsx`,
  Auto/Standard/Cozy/Relaxed override, localStorage, instant apply). No migration — client pref + CSS.
- [x] #10 Recurring-routine templates — **DONE**. Migration `0122_routine_templates.sql`
  (`routine_templates` + `routine_template_items`, weekday bitmask, family-scoped RLS) +
  pure `lib/routines/detect.ts` (13 tests: `detectRoutines` finds title+weekday+time repeating
  ≥3 weeks; `materializeRoutine` expands a template → concrete `calendar_events`) +
  `components/modules/routines-panel.tsx` in the calendar right rail (detect → "Save as routine",
  create/edit with weekday toggles + ordered steps, "Apply to this week" with one-tap Undo, delete).
  100% Supabase/realtime. tsc/eslint/**1612 tests**/build green.
- [x] Onboarding → first value (audited + first win): the **PIN step was mandatory** (Continue disabled until a 4-digit PIN matched), forcing every new user through 2 extra fields + validation before reaching the app — even though `completeProfileOnboardingAction` already treats an absent PIN as valid. Made it **"Skip for now"** (defers PIN to Settings → App Lock). Onboarding is now 1 required field (name) → skip → done. *(Onboarding telemetry doesn't fit `journey_events`: no family_id exists until completion — would need an anonymous/pre-family analytics path.)*

## ★ Seed coverage — 500-record test data per feature (2026-07-05)

> **Goal:** every feature testable at volume (≥500 rows). The DB has **354 base tables**;
> most are join/config/derived tables that don't need bulk data. What matters is that every
> **user-facing surface** has a validated, idempotent, paste-ready 500-row seed. All seeds
> below resolve the family by email, are re-runnable (delete-by-sentinel / ON CONFLICT), and
> were validated on a throwaway PG16 (500 rows each, stable across re-runs).

**✅ DONE — secondary user-facing tables now seeded at 500 rows** (all validated on PG16,
idempotent, stable across re-runs):
- [x] Messages — `family_messages` (all kinds) → `seed_messages.sql`
- [x] Chores — `chores` + `chore_assignments` (full status lifecycle) → `seed_chores.sql`
- [x] Meals — `meals` + `family_recipes` + `meal_plans` → `seed_meals.sql`
- [x] Documents — `documents` (categories + expiry + secure) → `seed_documents.sql`
- [x] Location / Safety — `family_places` + `member_locations` + `location_events` → `seed_location.sql`
- [x] Finance hub — `financial_accounts` + `transactions` + `bills` → `seed_finance.sql`
- [x] Memories / trips — `family_memories` + `trip_memories` → `seed_memories.sql`
- [x] Autopilot — `autopilot_suggestions` + `approval_requests` → `seed_autopilot.sql`
- [x] Family Vault — `family_credentials` (all 9 categories, migration 0119 applied + validated) → `seed_vault.sql`

**☑ One-paste master runner:** `supabase/SEED_ALL.sql` runs all 46 seeds in dependency order
(one paste → every surface at ≥500 rows). Idempotent; validated on PG16.

**☑ Validated 500-row seeds (paste-ready in `supabase/`):**

| Feature / surface | Table(s) seeded | File |
|---|---|---|
| Messages | `family_messages` | `seed_messages.sql` |
| Chores | `chores`, `chore_assignments` | `seed_chores.sql` |
| Meals | `meals`, `family_recipes`, `meal_plans` | `seed_meals.sql` |
| Documents | `documents` | `seed_documents.sql` |
| Location / Safety | `family_places`, `member_locations`, `location_events` | `seed_location.sql` |
| Finance hub | `financial_accounts`, `transactions`, `bills` | `seed_finance.sql` |
| Memories / trips | `family_memories`, `trip_memories` | `seed_memories.sql` |
| Autopilot | `autopilot_suggestions`, `approval_requests` | `seed_autopilot.sql` |
| Family Vault | `family_credentials` | `seed_vault.sql` |
| Knowledge Graph / Twin | `graph_entities`, `graph_edges` | `seed_graph.sql` |
| Decision Engine | `family_decisions`, `decision_options` | `seed_decisions.sql` |
| Prep Plans | `prep_plans`, `prep_plan_steps` | `seed_prep_plans.sql` |
| Onboarding funnel | `onboarding_events` | `seed_onboarding_events.sql` |
| Onboarding lifecycle + marketing signal | `onboarding_progress` (real Auth lifecycle rows only) | Production telemetry; no synthetic Auth seed |
| Intelligence Network aggregates | `network_aggregates` (+opts family in) | `seed_network_aggregates.sql` |
| Calendar, To-Dos, Groceries, Notes, Photos, Journal, Habits | `calendar_events`, `todo_items`, `grocery_items`, `notes`, `family_photos`, `journal_entries`, `habits` | `seed_core_content.sql` |
| #1 AI Orchestrator | `family_events`, `family_polls` | `seed_pillar1_orchestrator.sql` |
| #2 Household Twin | `budgets`, `calendar_events`, `family_routines`, `school_classes`, `teams` | `seed_pillar2_twin.sql` |
| #3 Playbook | `family_playbook_suggestions` | `seed_pillar3_playbook.sql` |
| #4 Outcomes launcher | `calendar_events`, `grocery_items`/`grocery_lists`, `todo_items`/`todo_lists` | `seed_pillar4_outcomes.sql` |
| #5/#7 Command Center + Family Operating Index | `family_operating_index` | `seed_pillar5_command_center.sql` |
| #6 Agent roster | `agent_activity` | `seed_pillar6_agents.sql` |
| #8 Design for Calm | `reminders` (due <24h) | `seed_pillar8_calm.sql` |
| #9 Connections / Family API | `family_connections` | `seed_pillar9_connections.sql` |
| Marketplace | `marketplace_listings`, `marketplace_offers` | `lib/marketplace/seed-sql.ts` → `/dashboard/marketplace/seed` |
| Voice Control | `voice_commands` | `seed_voice_one_family.sql` |
| Wallet / Allowance | child ledger | `seed_wallet_ledger_one_family.sql` |

> **Honest note:** seeding + validating *all* 354 tables in one pass isn't feasible — most are
> internal (junction, settings, audit, materialized). The list above covers every table behind a
> real screen. Each remaining item is a 15-min job using the exact pattern in `seed_core_content.sql`.

---

## Dead / stubbed UI to finish or hide
- [ ] **Messages → GIF picker** (FUTURE FOLLOW-UP — needs an external provider key). Stub:
  `components/modules/messages-module.tsx` (~line 876) — the "GIF" button toasts "coming soon".
  **Implementation plan** (code-complete + key-gated, mirror the Family-API pattern):
  1. Pick a provider — **Giphy** or **Tenor** (both have free tiers + search endpoints).
  2. Add the key to env: `GIPHY_API_KEY` (server) — proxy GIF search through a route
     (`app/api/gif/search/route.ts`) so the key never ships to the client.
  3. Build a `GifPicker` popover (query input → grid of results → pick → send as a `family_messages`
     row with `kind: 'image'` + the GIF url, reusing the existing image-message render path).
  4. Graceful fallback: if the key is absent, keep the button disabled with a "not configured" tooltip
     (don't toast "coming soon"). Same honest gating as Connections/OAuth.
  *Blocked only on the key; everything else is agent-buildable when you're ready to green-light a provider.*
- [x] Messages → Voice messages — DONE. `MediaRecorder` in `messages-module.tsx` records a clip → uploads through the existing `sendFile` path (kind `audio`, 25 MB cap + rollback) → renders an inline `<audio controls>` player. Live timer + cancel/discard; graceful "not supported" fallback. 100% Supabase (family-media storage + family_messages row).
- [x] Family page → "Wi-Fi & Passwords" — shipped as the Family Vault: `family_credentials` table + `/dashboard/passwords` (CRUD, mask/reveal/copy, RLS). *(parallel session)*

## Polish / consistency
- [x] Size guard consistency for `documents-module.tsx` + `trip-memories-module.tsx` — both are single-file uploads (no progress bar to add; Supabase JS `upload()` has no progress event). The 25 MB guard already existed in `lib/storage/documents.ts`; exported `DOCUMENT_MAX_BYTES`/`DOCUMENT_MAX_MB`, added **fail-fast pre-checks at file-pick time** in both, and fixed the Documents dropzone's misleading "up to 50 MB" copy → the real 25 MB.
- [x] Journey telemetry pipeline — migration `0124_journey_events.sql` (append-only, family-scoped RLS), pure `lib/analytics/journey.ts` (7 tests: median/summarize/format), client `useJourney(key)` hook (fire-and-forget started/step/completed, errors swallowed), instrumented the **Capture** journey (quick-capture: start on open, complete on save), and a super-admin `/dashboard/journeys` page showing real per-journey completion rate + median time/steps. Instrument more flows by calling `useJourney('key')`. *(Cross-family aggregate medians would need a service-role read.)*

## Standing rules (see /memory.md)
- Do **not** modify the global left navigation for all accounts without explicit instruction. Per-user Navigation Choices customization is fine. (The Marketplace nav entry above was an explicit roadmap build.)

---

## Build log (append as features land)
- **2026-07-08 — One-click demo ("Test Account").** Pricing-page button → a throwaway
  Family+ demo, no signup: `lib/demo/session.ts` provisions a fresh auth user + Family+
  family (plan 'plus') seeded via `lib/demo/seed.ts`, `demo_sessions` (0138) tracks a
  5-min expiry, `startDemoAction`/`endDemoAction` sign in/out, `DemoTimer` countdown
  banner, `/api/cron/demo-cleanup` (+ on-exit + on-expiry) fully deletes the family +
  user so it resets for the next visitor. Pure `lib/demo/config.ts` (4 tests). Each
  click = its own ephemeral family (collision-free). Owner: apply 0138. tsc/eslint/2082/build.
- **2026-07-06 (eve) — onboarding + role-tailoring + a11y run (7 PRs).** #235 onboarding→marketing
  wiring (`crm_contacts` upsert + `onboarding_completed`) & **child logins without email**
  (`0105_child_logins`, synthetic auth user, username+PIN, `/kid-login` + `/dashboard/family-access`).
  #236 role **nav gating** (`NavItem.manage` + `isNavItemVisibleToRole`). #237 marketing header text size.
  #238 role **Focus-strip density** (`focusChipClasses`). #239 **Kid-Logins nudge** on onboarding Done
  (`kidsNeedingLogin`). #240 onboarding progress-bar a11y. #241 **app-wide progress-bar a11y**
  (`lib/ui/a11y.ts::progressBarA11y`, 10 bars). All: tsc/eslint/**1905 tests**/build green.
- **Marketplace** shipped (migration 0120, lib+tests, module, route, nav). Commit `213718d`.
- **Marketplace test seed**: `lib/marketplace/seed-sql.ts` (500 listings + ~290 offers,
  all kinds/statuses, idempotent full-reseed per family) + admin-only screen at
  `/dashboard/marketplace/seed` (Copy SQL button, iPad-friendly). Validated on PG16:
  500 rows, every pending listing has offers, re-run stays 500.
- **Voice Control** shipped (migration 0121, `lib/voice/command-router.ts`+12 tests, `voice-module.tsx`, `/dashboard/voice`, nav). Web Speech → route → real capture rows + `voice_commands` history. Verified: tsc/eslint/1578 tests/build. **+ 500-row `voice_commands` seed** (`seed_voice_one_family.sql` / `db:seed:voice`, PG16-validated).
- **Universal ⌘K command bar** (Friction #2) shipped: `lib/command-bar/route.ts` (pure, 8 tests) + `components/app/command-bar.tsx` (global palette in app-shell; ⌘K / "/" open; navigate/capture/assistant; reuses the Voice/capture parser). 1588 tests / tsc / eslint / build green.
- **Allowance** (roadmap #3) completed: parent-run `runDueAllowancesAction()` + "Run due now" banner on `/wallet/allowance` (idempotent with the cron, Trust+tier gated) + pure `dueAllowances` helper (2 tests). Wallet also gained CSV **statement export** + a 500-row child-ledger seed (`seed_wallet_ledger_one_family.sql`).
- **Time-of-day Home Mission Control** (Friction #7) shipped: `lib/home/time-of-day.ts` (pure, 6 tests) + `components/home/time-of-day-focus.tsx` "Focus now" strip at the top of `/home`, phase-adaptive (morning: schedule/weather/school · night: tomorrow/get-ready/reflect). Additive; 1599 tests / tsc / eslint / build green.
- **Recurring-routine templates** (Friction #10) shipped: migration `0122`, `lib/routines/detect.ts`
  (13 tests), `RoutinesPanel` in the calendar rail (detect → save → apply-to-week w/ Undo). Commit on
  `main` via merge of `claude/routine-templates`. 1612 tests / tsc / eslint / build green.
- **Next up:** all 12 roadmap features built + wired + seeded. Remaining agent-doable Friction Backlog:
  **#8 role-tailored surfaces** (density/language per `family_members.role`; `ui`) · **#4 Autopilot
  self-completion of ≥90%-confidence moment-prep** (`engine`, touches shared `lib/autopilot/*`) · the
  **onboarding time-to-value < 90s** audit. Blocked/human-owned: #6 ETA travel buffer (maps API key),
  Stripe Issuing cards, applying pending prod migrations (0118/0120/0121…) in the Supabase SQL editor,
  per-platform OAuth keys, CI Supabase login for authed e2e. **Recommended next:** #10 recurring-routine
  templates (high value, self-contained `engine` lane) or #8 role-tailored surfaces.

## 🎨 SITE-WIDE UI/UX AUDIT — every dashboard page, graded (2026-07-12, this session)
Method: signal scan of every page + its rendered components (loading/error/empty states,
header, stat tiles, AI layer, realtime, mobile classes, interactivity) + manual review of the
bottom cohort. Tiers: **★★★ world-class** (rich module, full states, stats/AI/realtime,
mobile-first) · **★★ solid production** (wired + stated + clean; missing one premium layer,
usually by design) · **★ upgrade** (thin for its traffic — rebuilt this session) · **↪ redirect**.

| Page | Tier | Notes |
|---|---|---|
| `/dashboard/activity` | ★★ | Server-merged cross-surface feed; wired, clean. Realtime not needed (snapshot feed) |
| `/dashboard/agents` | ★★ | 5/9 signals, 297 LoC UI |
| `/dashboard/announcements` | ★★ | 7/9 signals, 183 LoC UI |
| `/dashboard/app-store` | ★★ | 6/9 signals, 197 LoC UI |
| `/dashboard/assistant` | ★★ | 7/9 signals, 711 LoC UI |
| `/dashboard/auto` | ★★ | 7/9 signals, 258 LoC UI |
| `/dashboard/autonomous-family-management` | ★★ | 6/9 signals, 347 LoC UI |
| `/dashboard/autopay` | ★★ | 6/9 signals, 182 LoC UI |
| `/dashboard/autopilot` | ★★★ | 8/9 signals, 272 LoC UI |
| `/dashboard/behavior` | ★★★ | 8/9 signals, 263 LoC UI |
| `/dashboard/billing` | ★★★ | 8/9 signals, 2237 LoC UI |
| `/dashboard/bills` | ★★ | 6/9 signals, 182 LoC UI |
| `/dashboard/binder` | ★★ | 6/9 signals, 127 LoC UI |
| `/dashboard/briefing` | ★★★ | 8/9 signals, 979 LoC UI |
| `/dashboard/budgets` | ★★ | 7/9 signals, 126 LoC UI |
| `/dashboard/calendar` | ★★★ | 8/9 signals, 905 LoC UI |
| `/dashboard/calm` | ★★ | Calm inbox; engine-driven minimal by design |
| `/dashboard/care` | ★★★ | 8/9 signals, 305 LoC UI |
| `/dashboard/celebrations` | ★★ | 7/9 signals, 156 LoC UI |
| `/dashboard/chores` | ★★★ | 8/9 signals, 787 LoC UI |
| `/dashboard/command-center` | ★★ | TV/large-screen dashboard; wired |
| `/dashboard/concierge-calls` | ★★★ | 8/9 signals, 305 LoC UI |
| `/dashboard/concierge` | ★★★ | 8/9 signals, 644 LoC UI |
| `/dashboard/conflicts` | ★★ | 6/9 signals, 274 LoC UI |
| `/dashboard/connections` | ★★ | 7/9 signals, 167 LoC UI |
| `/dashboard/contacts` | ★★★ | 8/9 signals, 538 LoC UI |
| `/dashboard/decisions` | ★★ | 7/9 signals, 398 LoC UI |
| `/dashboard/dental` | ★★★ | 8/9 signals, 726 LoC UI |
| `/dashboard/devices` | ★★ | 7/9 signals, 139 LoC UI |
| `/dashboard/dining` | ★ | UPGRADE: read-only, zero interactivity, dining_out has NO seed |
| `/dashboard/documents` | ★★★ | 8/9 signals, 678 LoC UI |
| `/dashboard/due` | ★★ | 6/9 signals, 182 LoC UI |
| `/dashboard/expenses` | ★★★ | 8/9 signals, 250 LoC UI |
| `/dashboard/experience` | ★★ | 6/9 signals, 229 LoC UI |
| `/dashboard/family-access` | ★★ | 4/9 signals, 187 LoC UI |
| `/dashboard/family-ai-assistant` | ↪ | Redirects to Assistant (de-dup, by design) |
| `/dashboard/family-automation` | ★★ | 7/9 signals, 468 LoC UI |
| `/dashboard/family-cfo` | ★★ | 4/9 signals, 230 LoC UI |
| `/dashboard/family-coo` | ★★ | 7/9 signals, 480 LoC UI |
| `/dashboard/family-digital-twin` | ★★★ | 8/9 signals, 799 LoC UI |
| `/dashboard/family-emergency` | ★★ | 7/9 signals, 460 LoC UI |
| `/dashboard/family-health` | ★★ | 4/9 signals, 218 LoC UI |
| `/dashboard/family-knowledge-graph` | ↪ | Redirects to Graph (de-dup, by design) |
| `/dashboard/family-memory` | ↪ | Redirects to Memories (R4 de-dup, by design) |
| `/dashboard/family-operating-index` | ★★ | 4/9 signals, 366 LoC UI |
| `/dashboard/family-operations` | ★★ | 4/9 signals, 216 LoC UI |
| `/dashboard/family-school` | ★★ | 4/9 signals, 216 LoC UI |
| `/dashboard/family-signals` | ★★ | Signal cards + ack/dismiss; engine-driven |
| `/dashboard/family-sports` | ★★ | 4/9 signals, 220 LoC UI |
| `/dashboard/family-stress` | ★★ | 7/9 signals, 379 LoC UI |
| `/dashboard/family-tree` | ★★ | 7/9 signals, 422 LoC UI |
| `/dashboard/family` | ★★ | 7/9 signals, 597 LoC UI |
| `/dashboard/favorites` | ★★ | 7/9 signals, 150 LoC UI |
| `/dashboard/focus` | ★★ | 6/9 signals, 165 LoC UI |
| `/dashboard/food` | ★★ | 5/9 signals, 218 LoC UI |
| `/dashboard/front-desk` | ★★★ | 9/9 signals, 769 LoC UI |
| `/dashboard/goals` | ★★★ | 8/9 signals, 246 LoC UI |
| `/dashboard/grandparent-portal` | ★★ | Digest-engine server page; warm + wired |
| `/dashboard/graph` | ★★ | 7/9 signals, 413 LoC UI |
| `/dashboard/grocery` | ★★ | 7/9 signals, 475 LoC UI |
| `/dashboard/habits` | ★★ | 7/9 signals, 405 LoC UI |
| `/dashboard/health` | ★★★ | 8/9 signals, 906 LoC UI |
| `/dashboard/home` | ★★★ | 8/9 signals, 566 LoC UI |
| `/dashboard/homework` | ★★ | 7/9 signals, 281 LoC UI |
| `/dashboard/inbox` | ★★★ | 9/9 signals, 802 LoC UI |
| `/dashboard/independence` | ★★ | 5/9 signals, 251 LoC UI |
| `/dashboard/insurance` | ★★★ | 8/9 signals, 352 LoC UI |
| `/dashboard/intelligence` | ★★ | 6/9 signals, 224 LoC UI |
| `/dashboard/journal` | ★★ | 7/9 signals, 257 LoC UI |
| `/dashboard/journeys` | ★★ | 4/9 signals, 214 LoC UI |
| `/dashboard/kitchen` | ★★ | 7/9 signals, 612 LoC UI |
| `/dashboard/knowledge` | ★★ | 6/9 signals, 249 LoC UI |
| `/dashboard/life-events` | ★★★ | 8/9 signals, 319 LoC UI |
| `/dashboard/locator` | ★★ | 7/9 signals, 533 LoC UI |
| `/dashboard/meals` | ★★★ | 8/9 signals, 821 LoC UI |
| `/dashboard/medical` | ★★★ | 8/9 signals, 913 LoC UI |
| `/dashboard/medications` | ★★ | 7/9 signals, 521 LoC UI |
| `/dashboard/memories` | ★★ | 6/9 signals, 451 LoC UI |
| `/dashboard/messages` | ★★ | 7/9 signals, 1397 LoC UI |
| `/dashboard/migrate` | ★★ | 6/9 signals, 318 LoC UI |
| `/dashboard/moments` | ★★★ | 8/9 signals, 437 LoC UI |
| `/dashboard/money-timeline` | ★★ | Timeline module; wired |
| `/dashboard/more` | ★★ | Deliberate simple links hub (mockup screen 11); premium enough for its job |
| `/dashboard/next-best-actions` | ★★ | 7/9 signals, 196 LoC UI |
| `/dashboard/notes` | ★★★ | 8/9 signals, 513 LoC UI |
| `/dashboard/notifications` | ★★ | 7/9 signals, 270 LoC UI |
| `/dashboard/nutrition` | ★★ | 7/9 signals, 161 LoC UI |
| `/dashboard/onboarding-funnel` | ★★ | 4/9 signals, 253 LoC UI |
| `/dashboard/outcomes` | ★★ | Outcome launcher picker; engine-driven, purposeful |
| `/dashboard/pantry` | ★★★ | 9/9 signals, 318 LoC UI |
| `/dashboard/paperwork` | ★★ | 4/9 signals, 305 LoC UI |
| `/dashboard/passwords` | ★★ | 7/9 signals, 323 LoC UI |
| `/dashboard/payments` | ★★ | 6/9 signals, 100 LoC UI |
| `/dashboard/pets` | ★★★ | 8/9 signals, 419 LoC UI |
| `/dashboard/photos` | ★★★ | 8/9 signals, 615 LoC UI |
| `/dashboard/planning` | ★★ | Server planning surface; wired |
| `/dashboard/playbook` | ★★★ | 9/9 signals, 264 LoC UI |
| `/dashboard/prep-plans` | ★★ | 7/9 signals, 223 LoC UI |
| `/dashboard/profile` | ★ | UPGRADE: thin links menu on a high-traffic surface — no personal stats/identity |
| `/dashboard/readiness` | ★★ | 4/9 signals, 253 LoC UI |
| `/dashboard/reasoning` | ★★ | Unified reasoning view; engine-driven |
| `/dashboard/recipes` | ★★★ | 9/9 signals, 739 LoC UI |
| `/dashboard/relationship` | ★★★ | 8/9 signals, 603 LoC UI |
| `/dashboard/reminders` | ★★★ | 9/9 signals, 897 LoC UI |
| `/dashboard/renewals` | ★★ | 7/9 signals, 295 LoC UI |
| `/dashboard/rewards` | ★★★ | 8/9 signals, 343 LoC UI |
| `/dashboard/rides` | ★★ | 7/9 signals, 327 LoC UI |
| `/dashboard/savings` | ★★ | 7/9 signals, 148 LoC UI |
| `/dashboard/scan` | ★★ | 6/9 signals, 203 LoC UI |
| `/dashboard/school` | ★★★ | 9/9 signals, 653 LoC UI |
| `/dashboard/screen-time` | ★★★ | 8/9 signals, 244 LoC UI |
| `/dashboard/security` | ★ | UPGRADE: bare CRUD event list — no stat tiles, no severity summary, no AI |
| `/dashboard/settings` | ★★ | 6/9 signals, 464 LoC UI |
| `/dashboard/setup` | ★★ | 7/9 signals, 378 LoC UI |
| `/dashboard/signups` | ★★★ | 8/9 signals, 320 LoC UI |
| `/dashboard/social-feed` | ★★ | 7/9 signals, 448 LoC UI |
| `/dashboard/social` | ★★ | 7/9 signals, 333 LoC UI |
| `/dashboard/sports` | ★★★ | 9/9 signals, 468 LoC UI |
| `/dashboard/subscriptions` | ★★★ | 8/9 signals, 176 LoC UI |
| `/dashboard/sync` | ★★ | 5/9 signals, 218 LoC UI |
| `/dashboard/tax-vault` | ★★ | 6/9 signals, 165 LoC UI |
| `/dashboard/timetable` | ★★ | 7/9 signals, 261 LoC UI |
| `/dashboard/todos` | ★★★ | 8/9 signals, 677 LoC UI |
| `/dashboard/trip-intel` | ★★ | 6/9 signals, 739 LoC UI |
| `/dashboard/trip-memories` | ★★ | 7/9 signals, 192 LoC UI |
| `/dashboard/trips` | ★★ | 7/9 signals, 425 LoC UI |
| `/dashboard/trust` | ★★ | 7/9 signals, 848 LoC UI |
| `/dashboard/utilities` | ★★★ | 8/9 signals, 211 LoC UI |
| `/dashboard/vacations` | ★★★ | 8/9 signals, 204 LoC UI |
| `/dashboard/voice` | ★★ | 6/9 signals, 254 LoC UI |
| `/dashboard/voting` | ★★ | 6/9 signals, 354 LoC UI |
| `/dashboard/weather` | ★★ | 7/9 signals, 335 LoC UI |
| `/dashboard/weekend` | ★★★ | 8/9 signals, 271 LoC UI |
| `/dashboard/weekly-briefing` | ★★ | 7/9 signals, 443 LoC UI |
| `/dashboard/wishlists` | ★★★ | 8/9 signals, 256 LoC UI |
| `/dashboard/workload` | ★★ | 5/9 signals, 289 LoC UI |

**Tally:** 43 world-class · 87 solid-production · 3 upgraded this session · 3 redirects.

**Upgrades built this session (all with 500-seed where a table backs them):**
- [x] **Profile** → premium identity surface: avatar hero, personal stats (points, chores done,
  streak, upcoming events), theme toggle + quick links preserved.
- [x] **Security** → stat tiles (open/critical/7-day), severity timeline styling, AI-style rollup
  headline from `summarizeSecurity`; CRUD preserved.
- [x] **Dining Out** → interactive: favorite toggle + log-a-visit (server actions), stat tiles,
  `seed_dining_out.sql` (500 rows: restaurants + visits).

### 🎨 Audit second pass — ★★/★ upgrade sweep (2026-07-12, same session)
Owner directive: upgrade every ★/★★ page. Every low-scoring page was manually re-reviewed:
- [x] **Payments** (`/dashboard/payments`) — UPGRADED: "this month" stat tiles (in/out/net/count,
  computed from the unfiltered set so search doesn't wobble them) + per-month subtotals on the
  history headers. Realtime + filters preserved.
- [x] **Family Intelligence** (`/dashboard/family-signals`) — UPGRADED: at-a-glance strip
  (active patterns · avg confidence · most-common kind · handled count) above the signal cards.
- **Re-graded ★★→★★★ on manual review** (the signal scan under-scored engine-driven server pages —
  each verified fully Supabase-wired with real states/design): `outcomes` (live urgency counts +
  reasoning insights), `reasoning` (6-question live engine + daily snapshot), `calm`
  (5-table inbox; minimal ON PURPOSE — its design brief is "does not maximize engagement", so no
  tiles were added), `grandparent-portal` (digest engine, photos/milestones/celebrations),
  `family-*` shell pages (share the premium StatTile/SectionCard/ScoreRing primitives in
  `components/family/shell.tsx`), `activity` (7-table merged feed), `dining`/`profile`/`security`
  (rebuilt earlier this session).
- **Left ★★ by design** (verified, do NOT chrome-inject): `more` (menu mockup), binder/devices/
  focus/tax-vault (grouping/reveal/status-cycling already present), finance re-export routes.

### 🪨 Full stone-turn pass (2026-07-12, late) — build + links + auth + scoping
- `next build` production build: **PASS** (exit 0, all 136+ routes compile).
- Dead-link sweep (172 distinct internal hrefs): 2 dead → fixed (`/dashboard/routines` →
  `/dashboard/calendar` in moments/prep engines; `/dashboard/shopping` → `/dashboard/grocery`).
- **API auth audit (95 routes): 4 real security fixes.** (1–2) `guardian/screen` +
  `guardian/status/voicemail` Twilio callbacks accepted unsigned requests (inbound trio validated,
  these didn't) → now validate `x-twilio-signature` in production, full-URL-with-query form.
  (3) `guardian/escalate` **failed open** when `GUARDIAN_INTERNAL_SECRET` unset — could blast
  emergency SMS/calls to every parent → fails closed (secret or CRON_SECRET required; no internal
  callers broken — verified none exist yet). (4) `guardian/escalate/twiml` was an open
  text-to-TwiML reflector → Twilio-signature-gated. Plus `mkt/track` (service-role public ingest)
  had NO rate limit while every sibling tracker did → 60/min/IP.
- Family-scoping audit (all client `.from().select()` chains): 11 flagged, all verified safe
  (child-record lookups by parent id, RLS backstop). No fixes needed.
- Stub sweep: no console.log leftovers; remaining TODO(keys) are documented key-gated integration
  points (Google/Gmail adapters), by convention.

### 🔗 Open-item #3 build-out — provider calendar two-way sync (2026-07-12, latest)
Everything up to the OAuth keys is now COMPLETE — adding keys lights it up with zero code changes:
- [x] **Provider-generic OAuth routes** `/api/sync/[provider]/auth|callback|disconnect` — registry-
  driven (R9), so **Microsoft connects end-to-end today** (its adapter pointed at a callback that
  didn't exist) and future adapters need zero route work. State bound to the live session; tokens
  AES-256-GCM via `connectAccount`; fails closed without `SYNC_TOKEN_KEY`; disconnect revokes at the
  provider (best-effort) + 303 redirect. Google's original static routes untouched.
- [x] **Scheduled background sync** `/api/cron/provider-sync` (CRON_SECRET, every 4h in vercel.json):
  oldest-synced accounts first, bounded batch of 25, per-account audit rows — manual "Sync now"
  becomes real continuous two-way sync.
- [x] **UI** — Microsoft Connect button (was missing); generic `ProviderControls` (Sync now via
  provider-agnostic `/api/sync/run` + Disconnect) for any adapter provider; **honest key-gating**:
  when keys are missing the Connect button is replaced by an amber "fully built, waiting on
  MICROSOFT_SYNC_CLIENT_ID/SECRET" notice (registry `isProviderConfigured`).
- [x] **Env-doc bug fixed**: `.env.example` documented `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID` +
  `/api/microsoft/callback` — variables NOTHING reads and a route that doesn't exist. Now documents
  the real `MICROSOFT_SYNC_*` vars + exact callback path; `*_SYNC_REDIRECT_URI` env override
  honored on both OAuth legs (proxy/custom-domain safe).
- Verified: 71 sync tests + full suite 2400 green; tsc/eslint clean; production build passes.
- **Owner keys to flip it live**: `SYNC_TOKEN_KEY`, `GOOGLE_SYNC_CLIENT_ID/SECRET`,
  `MICROSOFT_SYNC_CLIENT_ID/SECRET` (+ register the exact callback URIs), `CRON_SECRET`.
  Apple stays honestly CalDAV/ICS-guided; Alexa stays ICS one-way (documented in capabilities).

### 💳 Open-item #5 build-out — Stripe Issuing cards + real-time balances (2026-07-12, latest)
Deep audit verdict: the pipeline was already MUCH deeper than the table said — real-time
authorization gate (atomic reserve against the child's Spend bucket), capture/release handlers,
idempotent webhook route, capability resolver, and a 3-mode honest Cards UI all shipped. Genuine
stones found + fixed this pass:
- [x] **Auth-decision unit tests were MISSING** (code claimed "unit-tested separately" — no test
  existed): `tests/stripe-issuing-auth.test.ts` (7 tests — approve within balance, decline on
  inactive/frozen/blocked-category/insufficient, exact-balance edge, status-outranks-balance,
  unknown-merchant-category safety; plus the precheck's short-circuit parity).
- [x] **PAN reveal was promised but not built** (issuing.ts header: "parents reveal full details
  via an ephemeral Stripe.js session" — nothing existed): `prepareCardRevealAction` +
  `createCardRevealAction` (manager-gated, family-scoped, capability-gated, audited to
  wallet_audit_logs) + `CardRevealModal` (Stripe.js v9 Issuing display Elements — nonce →
  ephemeral key → number/expiry/CVC render in Stripe-hosted iframes; the PAN never touches our
  servers) + a Reveal button on every card row.
- [x] **Stale "Coming soon · real-time balance check"** on the child virtual card → now links to
  /wallet/cards with honest live-gate copy (the Spend balance shown IS what authorizations check).
- [x] **`STRIPE_MONEY_WEBHOOK_SECRET` was undocumented** in .env.example (the money webhook reads
  it; falls back to STRIPE_WEBHOOK_SECRET) → documented with the /api/webhooks/money endpoint note.
- Verified: 2411 tests green (7 new), tsc/eslint clean. Wallet balances already realtime
  (useRealtimeQuery on accounts/txns/cards).
- **Owner to flip live**: enable Issuing on the platform account, switch the
  stripe_issuing_enabled / stripe_connect_enabled feature flags, point a second webhook at
  /api/webhooks/money (secret above). Everything else is done.

### 📋 Master autonomous-build prompt — execution record (2026-07-13)
Owner supplied the full-platform "MASTER AUTONOMOUS BUILD PROMPT". Most phases were already
executed across this session's lanes with evidence (Phases 1–2: 136-page audit + competitor
matrices; Phase 3: mobile-first throughout; Phase 5: AI layers incl. the parallel lane's AI-Assist
batches + paperwork draft-reply (verified on main); Phase 6: Supabase wiring + RLS model (0118
universal enable + family policies); Phase 12: security passes; Phase 13/19: build/tsc/eslint/
vitest enforced per push). This pass closed the prompt's outstanding requirements:
- [x] **Documentation ledger created (10 files, grounded, generated from the repo where possible):**
  `route-inventory.md` (348 page routes w/ access class), `database-map.md` (418 tables w/ the
  correct 0118 universal-RLS model), `feature-inventory.md` (133 features → direct table deps),
  `architecture.md`, `security-review.md` (consolidated fixes + residual risks),
  `production-readiness.md` (green-locally vs human-owned launch gate), `testing-plan.md`
  (coverage + the 3 honest gaps: E2E, RLS-as-CI, visual regression), `user-journeys.md`,
  `audit.md` (pointer ledger), `change-log.md` (65 session commits).
- [x] **Final-validation anti-pattern sweep re-run on the merged tree**: clean — no TODO/FIXME
  beyond documented TODO(keys) adapter markers, no "not implemented"/mock/fake in prod paths,
  no console.log leftovers, no committed secrets (the one `sk_live_` hit is an input placeholder).
- [x] **Fixed a CI-blocking type error a parallel lane introduced**: `vitest.config.ts` carried an
  `oxc` key that isn't in this Vitest version's types — every `tsc --noEmit` failed. Removed
  (inert: the test glob is .ts-only); 2508 tests still green.
- Honest deferrals per the prompt's own priority rules: E2E suite (needs CI Supabase login —
  open item #24), RLS CI matrix, visual regression — scoped in `testing-plan.md`.

### ✅ Open-item #2 (Chief-of-Staff proactive front door) — VERIFIED COMPLETE (2026-07-13)
The opportunities-table screenshot was stale: this is fully built as **R5** and shipping on Home.
Verified end-to-end, not rebuilt:
- Engine `lib/home/front-door.ts` (`buildFrontDoor` + `mergeHandled`) assembles autopilot
  auto-executed actions + specialist-agent completed actions ("Done for you") and pending
  approvals ("Waiting on you") into one warm greeting. **11 tests pass.**
- `FrontDoorHero` renders on `/home`; `pending-approvals.tsx` calls the REAL
  `decideApprovalAction` (manager-gated + re-enforced server-side) — one-tap Approve/Decline in
  place; "Done for you" links to Autopilot for review/undo.
- Small connective add this pass: a "See everything in Calm →" link from the hero to the deeper
  quiet inbox (`/dashboard/calm`), so the home assembly leads onward to the full surface.
Net: every 4–5 star agent-buildable item on the owner's open-items table is now built. Remaining
items are human-owned (keys/OAuth/Issuing/CI Supabase login) or large greenfield strategic bets
(open developer platform), all logged.
- Honest deferrals per the prompt's own priority rules: E2E suite (needs CI Supabase login -
  open item #24), RLS CI matrix, visual regression - scoped in `testing-plan.md`.

---

## 2026-07-13 Autonomous Audit Session

This section is an additive execution ledger for the current repository-wide audit. Existing
roadmap entries and user worktree changes are preserved.

### Audit Metadata

- Audit started: 2026-07-13T08:42:01-04:00
- Repository: FamilyOS
- Branch: `codex/world-class-production`
- Commit at audit start: `3fd3ab9` (`remove unsafe synthetic auth seeds`)
- Environment: Windows workspace, Next.js 15, Node/npm project
- Supabase project: configured through environment; live credentials intentionally not recorded
- Auditor: Codex
- Overall status: CONDITIONAL GO pending validation and external-environment checks
- Critical blockers remaining: unknown until full validation completes
- High-priority issues remaining: unknown until full validation completes
- Medium-priority issues remaining: unknown until full validation completes
- Low-priority issues remaining: unknown until full validation completes

### Initial Worktree Safety Record

- [x] Existing `todo.md` found and extended rather than replaced.
- [x] Existing user changes preserved: `supabase/SEED_ALL.sql`, `supabase/seed_network_aggregates.sql`,
  and untracked `tests/seed-data-safety-contract.test.ts`.
- [x] No production data, users, storage objects, migrations, or secrets were modified by audit setup.

### Inventory Snapshot

- 348 `page.tsx` route files.
- 193 Supabase migration files and 309 SQL files under `supabase`.
- 305 test files after the audit's regression contracts.
- 2,054 repository files returned by the initial source inventory (excluding node_modules, dist, and build).
- Detailed route, database, feature, architecture, security, testing, and journey inventories already
  exist in the root documentation and will be reconciled with this session's command evidence.

### Open Audit Items

- [~] Run typecheck, lint, unit tests, production build, dependency audit, and static searches.
- [ ] Verify route/API/feature coverage against the current tree.
- [ ] Review Supabase migrations, RLS/policy coverage, storage declarations, RPCs, triggers, and client usage.
- [ ] Repair safe defects found by the current validation pass.
- [ ] Produce the required uppercase production reports and deployment checklist.
- [ ] Perform live Supabase, authenticated browser, RLS attack, and deployment checks where credentials/services
  are available; document any unavailable checks as blockers.

### TODO-0178 - Marketplace circles RLS recursion

- Status: [x] Completed in code; live migration application and post-migration probe pending.
- Severity: P1
- Category: Database authorization / reliability
- Feature: Cross-family marketplace circles
- Route: `/marketplace`
- File or files: `supabase/migrations/0176_marketplace_circles.sql`, `supabase/migrations/0178_marketplace_circles_rls_recursion.sql`
- Database objects: `marketplace_circles`, `marketplace_circle_members`, `marketplace_listing_shares`, related RLS policies
- Affected roles: Authenticated family members using circles
- Description: Production REST access to `marketplace_circles` returned PostgreSQL `42P17` because the
  `marketplace_circle_members` SELECT policy queried the same table directly. Related policies also
  depended on that recursive path.
- User impact: Circle discovery and any related listing feed could fail with HTTP 500.
- Security or privacy impact: The failure blocked access rather than broadening access, but the policy
  design was not safely verifiable until recursion was removed.
- Root cause: Direct membership-table subqueries inside RLS policies on the membership table and related tables.
- Required remediation: Apply migration `0178_marketplace_circles_rls_recursion.sql`, then rerun the schema
  probe and authenticated cross-family allow/deny tests in an isolated Supabase environment.
- Implementation notes: Added stable SECURITY DEFINER helpers with pinned `search_path`; preserved active
  family membership checks; tightened share delete to the owning family/listing.
- Test plan: Contract test plus local Supabase migration/RLS tests; live non-destructive REST probe after deploy.
- Tests performed: `tests/marketplace-circles-rls.test.ts` added; typecheck, lint, unit suite, and build rerun after patch.
- Evidence before fix: `marketplace_circles` REST probe returned HTTP 500, code `42P17`, message
  `infinite recursion detected in policy for relation "marketplace_circle_members"`.
- Resolution: Additive migration and regression contract are present. Production resolution is not claimed
  until the migration is applied and the live probe returns successfully.
- Follow-up evidence: `npm.cmd run db:audit:schema` passed, and anonymous REST probes for
  `marketplace_circles`, `marketplace_circle_members`, and `marketplace_listing_shares` each returned
  HTTP 200 on 2026-07-13. Authenticated cross-family allow/deny testing and migration-history
  verification still require an authorized isolated environment.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0195 - Notification and test-push routes lacked request budgets

- Status: [x] Completed in code and covered by the shared limiter regression tests.
- Severity: P1
- Category: Notification delivery abuse resistance / external side effects
- Feature: Family notification refresh and push testing
- Routes: `/api/notifications/generate`, `/api/push/test`
- File or files: the two route handlers, `lib/server/request-rate-limit.ts`,
  `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `notifications`, `push_devices`
- Description: Authenticated notification refresh could generate and dispatch up to 200 pending rows
  repeatedly, while test push could fan out to every registered device without request limits.
- User impact: Runaway clients could spam devices, repeat provider calls, and create avoidable database work.
- Root cause: The routes relied on authentication but predated the shared side-effect limiter.
- Resolution: Added family-scoped 10-request-per-minute notification refresh limits and user-scoped
  5-request-per-minute test-push limits, with `Retry-After` responses before fan-out.
- Tests performed: Shared limiter regression passed; full suite, typecheck, lint, build, and public E2E remain
  release gates. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### Audit Closeout Evidence (2026-07-13)

- [x] Typecheck: `npm.cmd run typecheck` passed.
- [x] Lint: `npm.cmd run lint` passed with only the known Next.js `next lint` deprecation notice.
- [x] Unit tests: `npm.cmd test` passed, 305 files and 2,554 tests.
- [x] Credential-safety regression: all seed scripts load access only from environment; no literal
  `sb_secret_*` credential remains in runtime/source SQL.
- [x] Production build: `npm.cmd run build` passed; 233 static pages generated.
- [x] Public E2E: 51 passed, 1 intentional authenticated-test skip.
- [x] Public accessibility: dark/light axe checks passed with no serious/critical violations.
- [x] Public responsive overflow: 320/390/768/1024 width checks passed.
- [x] Seed TLS safety and marketplace RLS contract tests passed.
- [x] Required reports created: `PRODUCTION_READINESS_REPORT.md`, `SUPABASE_AUDIT.md`,
  `TEST_EVIDENCE.md`, and `PRODUCTION_DEPLOYMENT_CHECKLIST.md`.
- [x] Live marketplace table probes passed: required schema audit plus all three related REST endpoints
  returned HTTP 200; authenticated cross-family RLS attack tests remain pending.
- [!] Live Auth Admin probe remains blocked by Supabase HTTP 500.
- [!] Local migration/RLS validation remains blocked until Docker Desktop is available.
- [!] Dependency advisory remains unresolved because npm reports no available PostCSS fix.

- [x] Added `supabase/seed_production_readiness.sql`, an idempotent 600-record independence-ladder
  dataset with a contract test and no destructive/Auth writes.

### TODO-0183 - Supabase service credential exposed in seed history

- Status: [!] Repository repair complete; external key rotation blocked by Supabase permissions.
- Severity: P0
- Category: Credential exposure / incident response
- Feature: Seed tooling
- File or files: Historical `scripts/seed-notifs.mjs` and related seed bootstraps; current fix is
  `scripts/seed-client.mjs` plus `tests/seed-credentials-safety.test.ts`.
- Description: A historical seed script embedded a live `sb_secret_*` credential. A local comparison
  confirmed that credential matched the currently configured `SUPABASE_SERVICE_ROLE_KEY`.
- Security impact: Anyone with repository history could potentially use the service credential to bypass
  RLS and access or modify Supabase data.
- Resolution in code: Removed embedded Supabase URLs and credentials from all seed scripts. Scripts now
  require `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment.
  Added a regression test that rejects literal clients, project URLs, and secret-key patterns.
- Required external remediation: A Supabase project owner must revoke/rotate the exposed key, review
  audit logs for its use, update deployment/local environment variables, and invalidate any old copies.
- Evidence: `npx supabase projects api-keys --project-ref ltcxlbipiihclxwioyqj` returned HTTP 403 due to
  insufficient project privileges; rotation was not performed by this agent.
- Launch impact: NO-GO until key rotation and log review are complete.

### TODO-0179 - Supabase Auth Admin users probe returns 500

- Status: [!] Blocked on external Supabase service diagnosis.
- Severity: P1
- Category: Authentication / operations
- Feature: Admin user inventory
- Route: `/admin/users`
- File or files: `scripts/audit-supabase-auth.mjs`, `app/(app)/admin/users/page.tsx`
- Database objects: Supabase Auth `auth.users` / GoTrue Admin API
- Affected roles: Super administrators
- Description: The configured live project reports HTTP 500 `Database error finding users` for
  `GET /auth/v1/admin/users?page=1&per_page=1` with the service-role key.
- User impact: Admin user listing and the Auth audit cannot be verified against the live project.
- Root cause: Not determinable from repository code; the response includes a Supabase error id and no SQL detail.
- Required remediation: Supabase owner should inspect GoTrue/Postgres logs for the returned error id,
  verify `auth.users` health, and rerun the probe after repair.
- Tests performed: Public Auth health probe passed; Admin users probe failed with HTTP 500.
- Evidence: `019f5b84-d42e-7354-9db9-89b9460d2921` from the live probe at audit time.

### TODO-0180 - Production Supabase migration state is incomplete

- Status: [!] Blocked pending deployment authorization and migration application.
- Severity: P1
- Category: Deployment / database
- Feature: Latest schema and RLS
- Description: The repository contains migrations through `0177` plus the new `0178` repair, while the
  configured live schema probe failed on the latest required object. The repository cannot safely claim
  that production has every migration applied without running the migration deployment process.
- Required remediation: Apply pending migrations through `0178` in the intended deployment environment,
  run the schema/auth probes, then run isolated RLS allow/deny tests. No destructive production operation
  was performed by this audit.

### TODO-0181 - Dependency audit reports unresolved PostCSS advisory

- Status: [!] No fix available from `npm audit`.
- Severity: P2
- Category: Dependency security
- Feature: Build dependency chain
- Description: `npm audit --omit=dev --audit-level=high` reports two moderate PostCSS vulnerabilities
  (`GHSA-qx2v-qp2m-jg93`) through Next.js with no available fix in the installed dependency graph.
- Required remediation: Track the Next.js/PostCSS release that removes the advisory, then upgrade and
  rerun build, lint, typecheck, and tests. Do not force an unreviewed breaking dependency change.

### TODO-0182 - Seed scripts disabled TLS verification

- Status: [x] Completed and covered by regression test.
- Severity: P2
- Category: Security / developer tooling
- Feature: Remote seed scripts
- File or files: `scripts/seed*.mjs`
- Description: Six seed scripts set `NODE_TLS_REJECT_UNAUTHORIZED=0`, disabling certificate
  verification for every outbound request in the process.
- User impact: A remote seed run could expose Supabase credentials to a man-in-the-middle.
- Resolution: Removed the process-wide TLS bypass from all seed scripts; normal Node certificate
  validation now applies. Added `tests/seed-tls-safety-contract.test.ts`.
- Tests performed: Targeted contract test, typecheck, lint, and full suite after the repair.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0184 - Legacy seed scripts used fixed household scope and unsafe fallbacks

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Production data safety / seed tooling
- Feature: Legacy JavaScript seed scripts
- File or files: `scripts/seed*.mjs`, `scripts/seed-client.mjs`,
  `tests/seed-credentials-safety.test.ts`, `tests/seed-scope-safety.test.ts`, `.env.example`
- Description: Multiple service-role seed scripts embedded a fixed family ID, creator ID, and
  member-ID fallbacks. A script could therefore be pointed at a different Supabase project and
  still attempt to mutate the wrong household or silently attach records to a fallback member.
- User impact: An operator mistake could write synthetic or sensitive fixture data into an unintended
  family, and the medical seed script also performs family-scoped cleanup before inserting fixtures.
- Security or privacy impact: The service-role key bypasses RLS, so URL-only targeting was insufficient
  protection against cross-household mutation.
- Root cause: Seed scope was encoded in source rather than confirmed at invocation time; missing
  members fell back to stale UUIDs in older scripts.
- Resolution: All six legacy seed scripts now require `requireSeedScope()`. The shared guard requires
  `SEED_ENVIRONMENT` to be local/test/preview/staging, validates `SEED_FAMILY_ID` and
  `SEED_CREATED_BY_USER_ID`, requires an exact `SEED_CONFIRM_FAMILY_ID` match, and rejects production.
  Member lookups now fail closed instead of falling back to fixed IDs.
- Tests performed: `node --check` for every `scripts/seed*.mjs`; focused Vitest suite passed with
  2 files and 3 tests; typecheck and lint passed. Static scan found no former fixed family/user IDs.
- Evidence: `tests/seed-credentials-safety.test.ts` requires the scope guard and rejects the legacy
  identifiers; `tests/seed-scope-safety.test.ts` proves production and mismatched confirmations fail.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0185 - Inactive public gift links disclosed household names

- Status: [x] Completed in code and covered by regression test.
- Severity: P1
- Category: Privacy / public capability links
- Feature: Public gift links
- Route: `/gift/[token]`
- File or files: `app/gift/[token]/page.tsx`, `tests/public-gift-privacy-contract.test.ts`
- Database objects: `gift_links`, `child_wallets`, `family_members`, `families`
- Description: The public gift page used the service-role client to resolve child and family names
  before checking whether the gift link was active. A revoked or expired token could therefore
  disclose identifying household information even though pledges were blocked.
- User impact: Someone holding an old or revoked gift URL could still see the associated child and
  family name.
- Security or privacy impact: Public capability revocation was incomplete; inactive links retained
  an information-disclosure path.
- Root cause: The `active` decision was made after identifying lookups instead of guarding them.
- Resolution: The page now computes `active` immediately after loading the link and performs all
  child/family lookups only when the link is active. Inactive and invalid links render generic names
  and the existing inactive-link message.
- Tests performed: `npm.cmd test -- tests/public-gift-privacy-contract.test.ts` passed; typecheck and
  lint passed. The contract proves all identifying lookups are behind the active-link guard.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0186 - Guardian screening callbacks accepted stale turn values

- Status: [x] Completed in code and covered by regression test.
- Severity: P1
- Category: Reliability / replay resistance / AI cost control
- Feature: Guardian AI call screening
- Route: `/api/guardian/screen`
- File or files: `app/api/guardian/screen/route.ts`, `lib/guardian/screening-turn.ts`,
  `tests/guardian-screening-turn.test.ts`
- Database objects: `guardian_screening_sessions`, `guardian_communications`, `notifications`
- Description: A validly signed Twilio callback was accepted based only on the session's active
  status. Replayed, stale, skipped, or over-limit `turn` values could rerun screening work and
  duplicate state changes or family notifications.
- User impact: A caller session could produce repeated AI responses, duplicate notifications, or
  inconsistent conversation history when Twilio retried or callbacks arrived out of order.
- Security impact: Twilio signature validation authenticates the provider but does not itself provide
  application-level replay or ordering protection.
- Root cause: The callback did not enforce the persisted session turn as the next bounded turn.
- Resolution: Added `isNextScreeningTurn` and reject any turn other than `current + 1`, including
  malformed values and turns beyond the five-turn limit, before AI work and additional service-role
  reads. Existing Twilio signature validation remains in place.
- Tests performed: Focused guardian and gift regression tests passed; typecheck and lint passed.
- Evidence: `tests/guardian-screening-turn.test.ts` covers initial/sequential acceptance, stale and
  skipped rejection, maximum-turn rejection, and malformed input rejection.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0187 - Public A/B events accepted fabricated variants

- Status: [x] Completed in code and covered by regression test.
- Severity: P2
- Category: Analytics integrity / public write validation
- Feature: A/B experiment event ingestion
- Route: `/api/ab/track`
- File or files: `app/api/ab/track/route.ts`, `lib/marketing/ab.ts`, `tests/marketing-ab.test.ts`
- Database objects: `ab_experiments`, `ab_events`
- Description: The public event endpoint verified that an experiment was running but trusted the
  submitted `variant` string. A caller could create fabricated variant rows and conversion metrics
  that polluted admin experiment results.
- User impact: Experiment dashboards could show inaccurate exposure, conversion, and significance data.
- Security impact: The service-role ingestion path accepted untrusted identifiers without validating
  them against the experiment definition.
- Root cause: The endpoint selected only experiment status and never inspected configured `variants`.
- Resolution: The endpoint now selects the experiment variants, accepts only configured variant keys,
  and rejects oversized experiment, variant, or visitor identifiers before inserting events.
- Tests performed: `npm.cmd test -- tests/marketing-ab.test.ts` passed with 9 tests; typecheck and lint
  passed. The pure helper covers valid, fabricated, malformed, and missing variant definitions.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0188 - Public consent endpoint lacked abuse bounds

- Status: [x] Completed in code and covered by regression test.
- Severity: P2
- Category: Public API abuse resistance / data retention
- Feature: Visitor consent management
- Route: `/api/mkt/consent`
- File or files: `app/api/mkt/consent/route.ts`, `lib/marketing/consent.ts`,
  `tests/marketing-consent-safety.test.ts`
- Database objects: `mkt_consent_events`
- Description: The unauthenticated consent POST appended immutable rows without a rate limit and
  iterated an unbounded caller-supplied object. The GET path also had no request limit.
- User impact: Automated callers could generate unnecessary consent rows and database work without
  affecting a legitimate visitor's consent state.
- Security or privacy impact: The service-role write path lacked the same public-ingestion controls
  used by other analytics endpoints.
- Root cause: Consent was treated as a low-volume browser-only path and did not use the shared limiter
  or a strict payload contract.
- Resolution: Added IP-based fixed-window limits (30 POST and 60 GET requests per minute), `Retry-After`
  responses, and strict validation for a finite map of known boolean categories only.
- Tests performed: Focused consent/A-B tests passed with 10 tests; typecheck and lint passed.
- Evidence: `tests/marketing-consent-safety.test.ts` rejects unknown categories, non-boolean values,
  oversized maps, and null payloads.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0189 - Agentic AI chat lacked request budget and input bounds

- Status: [x] Completed in code and covered by regression test.
- Severity: P1
- Category: AI cost control / public application abuse resistance
- Feature: Agentic AI chat
- Route: `/api/ai/chat`
- File or files: `app/api/ai/chat/route.ts`, `lib/ai/chat-request.ts`, `tests/ai-chat-request.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `ai_conversations`, `ai_messages`
- Description: The authenticated agentic chat route could invoke streaming and fallback model runs with
  no per-user request budget and accepted unbounded message/conversation input before tool execution.
- User impact: A compromised or runaway session could consume disproportionate AI capacity and request
  processing resources.
- Security impact: The model-backed, tool-capable path had weaker abuse controls than adjacent AI routes.
- Root cause: The route relied on authentication and RLS but had no request limiter or shared input contract.
- Resolution: Added a 20-request-per-user-per-minute in-memory limit plus the durable `rate_limit_hit` guard,
  valid UUID validation, trimmed non-empty messages, and an 8,000-character maximum before model work.
- Tests performed: `npm.cmd test -- tests/ai-chat-request.test.ts` passed with 3 tests; typecheck and lint
  passed. Durable enforcement remains dependent on migration `0156` being applied in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0190 - Authenticated voice AI routes lacked request budgets

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: AI cost control / provider abuse resistance
- Feature: Voice transcription and speech synthesis
- Routes: `/api/ai/voice/transcribe`, `/api/ai/voice/speak`
- File or files: `app/api/ai/voice/transcribe/route.ts`, `app/api/ai/voice/speak/route.ts`,
  `lib/server/ai-rate-limit.ts`, `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`
- Description: Authenticated voice routes validated payloads but could make unlimited paid OpenAI
  transcription or speech requests per user.
- User impact: A runaway or compromised session could exhaust AI provider capacity or incur unexpected cost.
- Root cause: Voice routes predated the shared durable AI limiter used by the gift assistant and agentic chat.
- Resolution: Added a shared local plus durable limiter: 10 transcription requests and 30 speech requests
  per user per minute, with `Retry-After` responses before provider keys or calls are used.
- Tests performed: `npm.cmd test -- tests/ai-rate-limit.test.ts tests/ai-voice.test.ts` passed with 22 tests;
  typecheck and lint passed. Durable enforcement remains dependent on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0191 - Generic AI insights endpoint lacked request budget

- Status: [x] Completed in code and covered by the shared limiter regression tests.
- Severity: P1
- Category: AI cost control / family data-read abuse resistance
- Feature: Family-scoped AI insights
- Route: `/api/ai/insights`
- File or files: `app/api/ai/insights/route.ts`, `lib/server/ai-rate-limit.ts`,
  `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`
- Description: The broad insights route could repeatedly read multi-module family context and invoke
  a paid model without a per-user request budget.
- User impact: A runaway dashboard or compromised session could consume provider capacity and perform
  unnecessary family-data reads.
- Root cause: The route was authenticated and RLS-scoped but did not use the shared AI limiter.
- Resolution: Added a distinct 20-request-per-user-per-minute local plus durable guard before context
  queries and model execution, with `Retry-After` on rejection.
- Tests performed: Shared limiter tests passed with 3 cases; full suite, typecheck, lint, build, and
  public E2E remain the release gates. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0192 - Public calendar feed lacked abuse bounds

- Status: [x] Completed in code and covered by regression test.
- Severity: P1
- Category: Public capability access / service-role read abuse resistance
- Feature: Anonymous iCalendar subscriptions
- Route: `/api/sync/feeds/[token]`
- File or files: `app/api/sync/feeds/[token]/route.ts`, `lib/sync/feed-request.ts`,
  `tests/sync-feed-contract.test.ts`
- Database objects: `sync_calendars`, `sync_calendar_events`, `rate_limits`, `rate_limit_hit`
- Description: A valid capability URL intentionally grants calendar access, but the endpoint had no
  request budget and accepted unbounded token strings before a service-role query returning up to 2,000 rows.
- User impact: A leaked feed URL or automated poller could create avoidable database load.
- Security impact: The capability read path had weaker abuse resistance than other public service-role routes.
- Root cause: The route treated the token as sufficient authorization without a bounded input or rate guard.
- Resolution: Added URL-safe token validation (16-200 characters) and 60 requests per IP per minute using
  local plus durable limits, with `Retry-After` responses. Anonymous calendar clients remain supported.
- Tests performed: `npm.cmd test -- tests/sync-feed-contract.test.ts` passed with 2 tests; full suite,
  typecheck, lint, build, and public E2E remain the release gates. Durable enforcement depends on `0156`.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0193 - Billing side-effect routes lacked request budgets

- Status: [x] Completed in code and covered by the shared limiter regression tests.
- Severity: P1
- Category: Billing provider abuse resistance / duplicate side effects
- Feature: Subscription checkout and self-serve billing
- Routes: `/api/billing/checkout`, `/api/billing/change-plan`, `/api/billing/cancel`, `/api/billing/portal`
- File or files: the four billing route handlers, `lib/server/request-rate-limit.ts`,
  `lib/server/ai-rate-limit.ts`, `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `billing_customers`, `subscriptions`, `checkout_sessions`
- Description: Parent-only billing routes had authorization but no per-family request budget before Stripe
  customer, checkout-session, subscription-update, or portal-session calls.
- User impact: Double-clicks, runaway clients, or compromised parent sessions could create avoidable
  provider calls and duplicate checkout sessions.
- Root cause: Rate limiting existed only in selected public and AI routes, not billing side effects.
- Resolution: Added a generic local plus durable limiter keyed by family at 10 requests per route per minute,
  after input/role checks and before Stripe work, with `Retry-After` responses.
- Tests performed: Shared limiter regression passed; full suite, typecheck, lint, build, and public E2E remain
  release gates. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13

### TODO-0194 - Calendar sync routes lacked request budgets

- Status: [x] Completed in code and covered by the shared limiter regression tests.
- Severity: P1
- Category: External integration abuse resistance / duplicate provider work
- Feature: Google and provider-agnostic calendar synchronization
- Routes: `/api/sync/run`, `/api/sync/google/sync`, `/api/google/calendar/sync`
- File or files: the three sync route handlers, `lib/server/request-rate-limit.ts`,
  `tests/ai-rate-limit.test.ts`
- Database objects: `rate_limits`, `rate_limit_hit`, `sync_accounts`, `calendar_events`
- Description: Authenticated sync entry points could refresh tokens and call external calendar providers
  repeatedly without a per-family/user request budget.
- User impact: Repeated clicks or a runaway client could cause duplicate imports, provider throttling, or
  unnecessary external API work.
- Root cause: Authentication and account scoping existed, but sync routes predated the shared side-effect guard.
- Resolution: Added provider-specific 10-request-per-family/user-per-minute limits before sync engines,
  token refreshes, or Google imports, with `Retry-After` responses.
- Tests performed: Shared limiter regression passed; full suite, typecheck, lint, build, and public E2E remain
  release gates. Durable enforcement depends on migration `0156` in production.
- Verified by: Codex
- Date completed: 2026-07-13
