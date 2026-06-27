# WORLD_CLASS_UX_AUDIT.md — Bubaly

> Brand promise: **Less Managing Life. More Living It.**
> North star: Bubaly is the calm **AI Operating System for Family Life** — a trusted family
> Chief of Staff that quietly runs the admin of life in the background.
>
> This is a living audit. It scores the product against the promise, names the friction, and
> defines the future state. Companion execution plan: `FRICTIONLESS_UX_ROADMAP.md`. Per-feature
> implementation status is tracked at the bottom.

---

## Executive summary

Bubaly is **feature-complete and then some** — ~70 modules across daily life, family & home,
finances (the full Bubaly Money program: ledger wallet, Stripe Money, cards, gifting, Pay-ID,
Family Economy, kid investing), plus the Trust & Permissions Engine and Concierge/Front-Desk AI.
The platform foundations (immutable ledger, family-scoped RLS, capability detection, audit logs,
shared empty/error/loading + skeleton states, dark/light, mobile bottom-sheet modals) are strong.

**The single biggest UX risk is breadth, not depth.** The product exposes 70+ destinations as
navigation. That contradicts the promise: a busy parent should not have to *remember where things
live* or *do the routing themselves*. The work ahead is **collapse + automate + bring-to-you**, not
"add more screens."

**Strategic direction:** collapse the surface area into **five primary surfaces** and let AI +
context deliver the right thing at the right moment:

1. **Home** — Family Mission Control (today, approvals, what Bubaly handled, one-tap actions)
2. **Assistant** — the operating layer (explain, act, schedule, summarize, undo) — everywhere
3. **Capture** — one inbox for voice/photo/PDF/email/receipt → AI classifies + routes
4. **Inbox** — a decision queue (Needs approval / Urgent / Waiting / Handled), not email
5. **Profile** — identity, family, trust policies, billing, settings

Everything else becomes **search-reachable, AI-triggered, contextual, or progressively disclosed.**

---

## Scoring rubric (per feature, 1–10)

- **Friction** (1 painful → 10 effortless)
- **AI Leverage** (1 manual → 10 fully AI-assisted)
- **Mobile UX** (1 poor → 10 excellent)
- **Trust** (1 risky/unclear → 10 explainable/safe)
- **Brand Alignment** ("Less Managing Life…") (1 → 10)

Rule: **< 8 → redesign · < 6 → rebuild or remove.**

---

## Top 25 friction points (ranked)

1. **Navigation overload** — 70+ items as primary nav; no "bring it to me" model. (Brand 3)
2. **No true Home/Mission-Control** — `/dashboard` exists but isn't the single "what matters now + 1-tap action" surface.
3. **Assistant is a destination, not a layer** — should be invokable from every screen with context.
4. **Capture isn't universal** — NL Quick Capture shipped (events/tasks/shopping); still missing email/PDF/receipt/voicemail → auto-route.
5. **Inbox = list, not decision queue** — needs Needs-Approval / Urgent / Waiting / Handled grouping with inline Approve/Snooze/Delegate.
6. **Notifications risk noise** — no enforced levels (silent log / digest / standard / urgent / emergency).
7. **Onboarding asks before it gives** — should create useful defaults + land on a valuable Home, resumable.
8. **Feature discovery via memory** — users must know a feature exists to find it; needs global search + AI suggest.
9. **Per-feature loading was spinners** — ✅ fixed: skeleton system + route-level loading (#165).
10. **Dead-end recovery** — ✅ improved: 404/error now route to dashboard + show support ref (#165).
11. **Forms ask too much too early** — audit field counts, input types, sticky mobile submit, inline validation.
12. **Upgrade prompts not contextual** — show value at moment-of-need, never modal-spam.
13. **Duplicated/overlapping routes** — several wallet/finance + dashboard variants; consolidate.
14. **Trust actions not always explainable in-context** — engine exists; surface "why / who approved / undo" on each AI action.
15. **Household Policy not plain-language editable** — avoid IT-style settings; natural-language rules.
16. **Mobile primary actions sometimes below the fold** — sticky CTAs; (modal safe-area ✅ in #163).
17. **No consistent "Bubaly handled this for you" moment** — the core delight (relief) isn't surfaced as a weekly recap.
18. **Empty states inconsistent in CTA strength** — standardize a single prominent next action.
19. **Tier/locked state clutter** — locked features should not crowd primary nav; show contextually.
20. **Icon-only buttons miss aria-labels** — a11y gap for screen readers.
21. **Light-mode muted-text contrast** — verify WCAG AA on `text-muted`.
22. **Migrations not in prod** — features dark in prod until 0085–0097 applied (degrade-safe via #163, but value isn't live).
23. **Context switching** — related actions (e.g. approve a chore → pay to wallet) span screens; unify.
24. **Repeated data entry** — AI should pre-fill from family memory/CRM/knowledge graph.
25. **No single "what needs me" view across domains** — approvals live per-feature; centralize in Inbox/Home.

---

## Top 25 game-changing opportunities

1. **Five-surface IA** (Home/Assistant/Capture/Inbox/Profile) with everything else behind search/AI/context.
2. **Home = Family Mission Control** — cards with Approve/Snooze/Delegate/Ask/Automate/Dismiss/Undo.
3. **Assistant as operating layer** — global invoke (⌘K / FAB), screen-aware, action-taking, undoable.
4. **Universal Capture** — voice/photo/PDF/email/receipt/voicemail → AI extract→classify→route→remind.
5. **Decision-queue Inbox** — prioritized, grouped by domain + urgency, inline actions.
6. **Notification intelligence** — five levels; notify only when a human must act.
7. **"Bubaly handled this for you" weekly recap** — make relief visible (retention + trust).
8. **Plain-language Household Policy** — "Require a parent for medical changes," editable as sentences.
9. **Explainable AI everywhere** — every AI action shows why/what/who/undo (Trust Engine already logs).
10. **Global command palette + semantic search** over family memory/knowledge graph.
11. **Proactive surfacing** — renewals, conflicts, missed responsibilities appear before they bite.
12. **One-tap delegation** — assign to a family member/grandparent within policy.
13. **Auto-defaults onboarding** — generate wallet buckets, calendars, lists; land on value.
14. **Cross-domain bundles** — "School pickup changed → reschedule ride + notify grandparent."
15. **Contextual upgrade** — surface Plus exactly where it removes the user's current friction.
16. **Mobile one-handed everything** — bottom sheets, sticky CTAs, voice input.
17. **Family CRM auto-fill** — providers/contacts prefill forms and concierge actions.
18. **Concierge outcomes → Inbox cards** — phone/email results become decisions, not transcripts.
19. **Calm visual system** — fewer, larger, clearer cards; premium spacing; reduced cognitive load.
20. **Skeleton-everywhere perceived speed** — ✅ system shipped; adopt per-module + per-route.
21. **Undo for every AI/automation action** — confidence to let AI act.
22. **Risk/confidence-gated auto-approve** — routine low-risk handled silently; rest queued.
23. **Emergency escalation path** — school/medical emergencies bypass digest instantly.
24. **Memory-surfaced delight** — resurface photos/milestones at the right moment.
25. **Single settings/profile hub** — identity, family, policy, billing in one calm place.

---

## Five-surface mapping (where today's 70 modules go)

| Surface | Absorbs / surfaces |
|---|---|
| **Home** | dashboard, briefings, command-center, renewals, "needs attention" across all domains, autopilot results |
| **Assistant** | assistant, concierge, front-desk, AI advisor/companion, conflict resolution, scheduling agent |
| **Capture** | scan, quick-capture, document/email/receipt intake, photos-as-capture |
| **Inbox** | communications hub, approvals (wallet/trust/chores), notifications, school/medical/sports updates |
| **Profile** | settings, family setup, trust & permissions, household policy, billing/subscriptions, referrals |
| **Search / contextual / progressive** | calendar, tasks, chores, meals, grocery, pantry, health, medical, dental, meds, school, homework, sports, rides, auto, pets, travel, documents, notes, memories, family tree, social, wallet & money program, admin (separate) |

Principle: a feature still has a deep page — but the **primary** way to reach it is Home cards,
Assistant, Capture routing, Inbox decisions, or search. Nav stops being a 70-item memory test.

---

## Feature Review Cards (representative; full set tracked in the roadmap)

### Home / Dashboard
- **Today:** `/dashboard` shows widgets; not a true "what needs me now + 1 tap" command center.
- **Friction:** cards not all action-bearing; cross-domain approvals not centralized.
- **Decision:** **Rebuild** into Family Mission Control.
- **Future:** ranked cards (needs-approval, today, handled, emerging risk) each with Approve/Snooze/Delegate/Ask/Automate/Undo. Mobile-first, scannable in 5s.
- **AI:** rank by urgency × impact; auto-resolve routine; explain each card.
- **Scores now:** Friction 6 · AI 5 · Mobile 7 · Trust 7 · Brand 5 → **redesign.**

### Assistant
- **Today:** capable chat + tool execution + Trust-governed actions (Magic Import wired).
- **Friction:** lives at a route; not globally invokable/screen-aware.
- **Decision:** **Improve** → make it the layer (global FAB/⌘K, context of current screen, undo).
- **Scores:** Friction 6 · AI 8 · Mobile 6 · Trust 8 · Brand 7 → redesign (reach/ubiquity).

### Capture
- **Today:** NL Quick Capture (events/tasks/shopping), Scan Center.
- **Friction:** not yet one universal intake for email/PDF/receipt/voicemail with auto-route.
- **Decision:** **Consolidate + AI-upgrade** into one Capture surface.
- **Scores:** Friction 7 · AI 7 · Mobile 8 · Trust 7 · Brand 8 → polish to 9+.

### Inbox / Communications Hub
- **Today:** communications hub exists (migration 0090).
- **Friction:** organized as messages, not a decision queue; approvals scattered.
- **Decision:** **Rebuild** as the decision queue (Needs Approval/Urgent/Waiting/Handled + domains).
- **Scores:** Friction 5 · AI 6 · Mobile 6 · Trust 7 · Brand 5 → rebuild.

### Trust & Permissions / Household Policy
- **Today:** full engine (0093): policies, grants, delegations, approvals, scores, emergency, audit.
- **Friction:** policy editing is structured, not plain-language; explainability not surfaced on every AI action card.
- **Decision:** **Improve** → plain-language rules + inline "why/who/undo" on AI actions.
- **Scores:** Friction 6 · AI 7 · Mobile 6 · Trust 9 · Brand 8 → polish.

### Notifications
- **Decision:** **Rebuild** around five levels (silent log/digest/standard/urgent/emergency); default to digest; notify only on required decisions/deadlines/risks/failures.
- **Scores:** Friction 4 · AI 5 · Mobile 6 · Trust 6 · Brand 4 → rebuild.

### Onboarding
- **Decision:** **Improve** → ask minimum, auto-create defaults, resumable, end on valuable Home.
- **Scores:** Friction 6 · AI 6 · Mobile 7 · Trust 7 · Brand 6 → redesign.

### Loading / Error / Empty (cross-cutting)
- **Status:** ✅ Skeleton system + route-level loading + recovery pages shipped (#165). Adopt skeletons per-module next.
- **Scores:** Friction 8 · Mobile 8 · Brand 8 → keep + roll out.

---

## Shipped this session (concrete UX code, not just analysis)
- **#163** — missing-relation guard (no more crashes pre-migration) + NL Quick Capture + modal safe-area + Wallet promoted in nav.
- **#165** — Skeleton system (`Skeleton/SkeletonText/SkeletonCard/SkeletonList`), app-level `loading.tsx`, recovery pages (404/error → dashboard + support ref).
- Plus the full Bubaly Money program (#155–#162) with family-scoped RLS, immutable ledger, audit logs, capability detection.

## Per-feature implementation status
Tracked incrementally here as the five-surface rollout proceeds. Today: cross-cutting loading/error/empty = DONE; Home/Assistant/Capture/Inbox/Notifications = SPEC'd in `FRICTIONLESS_UX_ROADMAP.md`, awaiting build (sequenced to avoid regressions on a live 70-module app).

## Hard constraints for whoever executes
- Preserve Supabase integrity, family-scoped **RLS**, tier entitlements, dark/light, mobile responsiveness.
- Keep the **immutable-ledger** discipline and **audit logging** on every financial/AI action.
- vitest is **node-only (no jsdom)** — keep logic in tested `lib/*` helpers; verify presentational changes via `tsc` + `next build`.
- **Ops gap:** apply prod Supabase migrations **0085–0097** to make features live (degrade-safe today via #163).
