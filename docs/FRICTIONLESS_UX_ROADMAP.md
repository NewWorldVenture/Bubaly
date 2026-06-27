# FRICTIONLESS_UX_ROADMAP.md — Bubaly

> Execution plan for `WORLD_CLASS_UX_AUDIT.md`. Goal: collapse 70+ destinations into **five
> surfaces** (Home · Assistant · Capture · Inbox · Profile) and let AI + context bring the right
> thing to the user. Tagline test for every change: **Less Managing Life. More Living It.**
>
> Sequenced so a parallel agent can pick up a phase and ship it **without breaking the live app**.
> Each item lists concrete files/tables so work can start immediately.

---

## Priority matrix

| | High impact | Lower impact |
|---|---|---|
| **Low effort** | Notification levels · contextual upgrade · adopt skeletons per-module · aria-labels on icon buttons | copy tightening · empty-state CTA standardization |
| **High effort** | Home = Mission Control · Inbox decision-queue · Universal Capture intake · Assistant-as-layer | full nav collapse · plain-language policy editor |

Start top-left, move right; do high-effort behind flags.

---

## Quick wins (days, low risk, no migration)

1. **Adopt `SkeletonList` in the busiest modules** — replace `LoadingBlock` in
   `components/modules/{chores,meals,grocery,calendar,habits,...}-module.tsx`. Mechanical; tsc+build verify.
2. **aria-labels on icon-only buttons** — sweep `components/**` for `<button>` with only an icon; add `aria-label`. WCAG 2.2 AA.
3. **Standardize empty-state CTA** — ensure each `EmptyState` has one prominent `action`; audit usages.
4. **Per-route `loading.tsx`** for heavy routes (`/dashboard/calendar`, `/dashboard/photos`,
   `/dashboard/documents`, `/wallet`) with layout-matched skeletons (subnav + cards).
5. **Copy pass** — tighten page titles/CTAs/empty states to short + human; strip jargon on consumer pages.
6. **Light-mode contrast** — verify `text-muted` meets AA; bump token if needed in `globals.css`/theme.

## High-impact redesigns (sequenced)

### Phase A — Notification intelligence (low effort, high impact)
- Add a notification-level enum (silent_log / digest / standard / urgent / emergency) to the
  notifications layer; default routine events to **digest**. Only standard+ when a human must act.
- Files: notifications lib + cron/digest assembler; respect Household Policy escalation for emergencies.
- Success: notifications/user/day down; approval-response time down.

### Phase B — Home = Family Mission Control (high impact)
- New `components/home/mission-control.tsx` rendered by `/dashboard`. Ranked cards from a single
  server aggregator that unions cross-domain "needs me" items (wallet approvals, trust approvals,
  chore sign-offs, renewals due, calendar conflicts, concierge outcomes).
- Each card: **Approve / Snooze / Delegate / Ask Bubaly / Automate / Dismiss / Undo** (server actions;
  Trust-gated). Mobile-first, scannable in 5s. No card without a clear action.
- Reuse existing approval tables (parent_approvals, economy_redemptions, invest_orders, trust
  approval_requests). No new money tables.

### Phase C — Inbox decision-queue (high impact)
- Rebuild Communications Hub (`/dashboard/inbox`) into groups: **Needs Approval / Urgent / Waiting on
  You / Already Handled** + domain filters (School/Medical/Sports/Bills/Travel/Documents/Family).
- Source from communications + the same cross-domain aggregator as Home. Inline actions; bulk handle.

### Phase D — Assistant as the operating layer
- Global invoke: a FAB + ⌘K palette mounted in `app/(app)/layout.tsx`; pass current route/context so
  the assistant can "explain this screen" and act. Every action returns an **undo** affordance.
- Reuse existing `/api/ai/*` + Trust `evaluateTrust` for governed execution + audit.

### Phase E — Universal Capture
- One `/capture` (+ FAB) accepting voice/text/photo/screenshot/PDF/email/receipt/calendar/voicemail.
- Pipeline: extract → classify → route → create records/reminders → ask approval only when policy
  requires. Extend the existing NL parser (`lib/capture/parse.ts`) + Scan + document AI.

### Phase F — Plain-language Household Policy + explainable AI
- Policy editor that reads/writes rules as sentences ("Require a parent for medical changes").
- On every AI/automation result, surface **why / what data / who approved / policy / undo** (Trust
  Engine already records this — surface it in the card UI).

### Phase G — "Bubaly handled this for you" weekly recap
- Weekly digest of time saved / things handled / upcoming, surfaced on Home + email. Relief = delight.

---

## Navigation simplification plan
- Introduce the 5-surface bottom nav (mobile) / rail (desktop): Home · Assistant · Capture · Inbox · Profile.
- Demote the 70-item groups behind **global search** + AI suggest + contextual entry. Keep deep routes
  for direct/search access; remove duplicate routes (audit `app/(app)/**` for overlapping wallet/finance/dashboard variants).
- Locked/upgrade features: never in primary nav; surface contextually at moment-of-need.

## AI automation plan
- Risk/confidence-gated auto-approve for routine low-risk actions; everything else → Inbox.
- Pre-fill forms from Family CRM / knowledge graph to kill repeated data entry.
- Concierge (phone/email) outcomes become Inbox decision cards, not raw transcripts.

## Trust & Permissions / Policy plan
- Route every automation through identity → relationship → permission → policy → risk → confidence →
  approval → audit (engine exists in 0093). Add per-action explainability UI + plain-language policy.

## Mobile plan
- One-handed, <30s, minimal typing, large tap targets, voice input, sticky primary actions,
  safe-area (modals ✅ #163), undo. Audit each redesigned surface on a phone viewport.

## Accessibility plan (WCAG 2.2 AA)
- Keyboard nav + visible focus (`focus-ring` exists), screen-reader labels, contrast, semantic HTML,
  modal focus-trap, aria on icon buttons, error announcements, text scaling, reduced-motion (skeletons ✅).

## Data / API / component / route plans
- **DB:** prefer reusing existing approval/ledger tables; only add a `notification_level` concept +
  (optional) a `home_cards` materialized view if aggregation perf needs it. Keep family-scoped RLS.
- **API:** one cross-domain "needs-me" aggregator endpoint feeding Home + Inbox.
- **Components:** consolidate one-off cards/buttons to shared primitives; add `Skeleton*` adoption.
- **Routes:** add `/capture`, restructure `/dashboard` → Mission Control, `/dashboard/inbox` → queue;
  consolidate duplicates.

## Implementation roadmap (suggested order)
1. Quick wins (1–6 above) — ship continuously, no flags.
2. Phase A Notifications → B Home → C Inbox → D Assistant-layer → E Capture → F Policy/explainability → G Recap.
3. Nav collapse behind a feature flag; dogfood; then default on.

## Definition of done (per phase)
tsc clean · eslint clean · `next build` ✓ · vitest green (logic in `lib/*`) · mobile viewport checked ·
dark/light checked · RLS/tier preserved · Trust-gated where it acts · audit-logged · handoff updated.

## Ops gap (not code)
Apply prod Supabase migrations **0085–0097** to make the built features live. Until then the app
degrades safely (missing-relation guard, #163) but the value isn't switched on in production.
