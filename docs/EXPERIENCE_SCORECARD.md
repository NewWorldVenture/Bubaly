# FamilyOS — Experience Scorecard

Objective UX health per **journey**, so "world-class" is measured, not asserted.
Pairs with `docs/FRICTION_BACKLOG.md` (the Opportunity Register = *what to fix
next*); this is *how good each journey is now*.

**Metrics**
- **Taps** — interactions to complete the happy path (fewer = better).
- **Typing** — free-text fields required (fewer = better).
- **Switches** — screen/context changes.
- **Time** — rough time-to-complete for a practiced user.
- **A11y** — keyboard + SR + 44px targets + labels (✅ / ⚠️ / ❌).
- **Perceived perf** — optimistic UI / skeletons / instant feedback.
- **Recovery** — undo / confirm-destructive / clear errors.

> ⚠️ **Measurement status:** the *journey* table below is still **design-time
> estimates** from reading the code. To make this a true scorecard, add
> lightweight analytics (a `journey_started/completed` event with a step counter)
> and a Playwright "taps to complete" harness per journey, then replace these
> estimates with medians. Treat cells as a baseline to beat.

## ✅ Now measured: the live Experience Scorecard (T8)

The premium-consistency sweep is now **data-backed and tracked over time**, not
just asserted here. Every surface (module or journey) gets a dated audit across
six premium dimensions, rolled up into a live grade with a trend.

- **Where:** `/dashboard/experience` (family-scoped, realtime).
- **Dimensions (0–100 each):** Empty state · Error recovery · Transitions ·
  Performance · Accessibility · Consistency. The composite is a weighted average
  (error-recovery and a11y weigh slightly more) → a letter grade (A ≥90 … F <60).
- **Rubric + rollup:** pure `lib/experience/scorecard.ts` (`scoreAudit`,
  `gradeFor`, `rollUpScorecard`; **13 tests**). Missing dimensions are excluded,
  not zeroed, so partial audits stay fair; un-audited dimensions never rank as
  "weakest".
- **Storage:** `experience_audits` (migration `0144`, family-scoped RLS,
  `unique(family_id, surface_key, audited_on)` → one audit per surface per day).
  Dated rows give real **trend lines** (score movement since the previous audit).
- **What it surfaces:** overall grade + Δ since last audit, per-dimension health
  bars, a "needs work" callout (surfaces < 70), and a per-surface table ordered
  **worst-first** so the sweep runs top-down. Accessibility currently trails —
  the seed reflects that, and it's the weakest dimension to attack first.
- **Seed baseline:** `seed_experience_audits_one_family.sql` (540 rows: 30
  surfaces × 18 dates over ~68 days) — an upward trend with 4 surfaces still
  below the bar (Connections, Messages, Wallet, Homework).

> **Next telemetry step (unchanged):** replace seeded audit scores with values
> derived from real signals — error rates, skeleton coverage, Lighthouse/perf
> budgets, and the T7 `ai_feedback` helpful-ratio — written as a nightly audit row
> per surface. The table + rollup are ready; only the collectors remain.

| Journey | Taps | Typing | Switches | Time | A11y | Perceived perf | Recovery | Notes / top friction |
|---|---|---|---|---|---|---|---|---|
| **Capture a thought** (type→filed) | 2–3 | 1 | 0 | ~8s | ✅ | ✅ optimistic + Undo toast | ✅ Undo | FAB/`c` → type → AI routes. Strong. |
| **Get ready for an event** (set leave-by reminder) | **1** | 0 | **0** | ~3s | ✅ | ✅ inline states | ✅ reversible (reminders) | Home banner inline "Remind me" (Friction #1). Was 3+ taps + a screen switch. |
| **Add snacks for the game** | 1 | 0 | 0 | ~3s | ✅ | ✅ | ✅ **Undo** in toast | Moment "Add N" → deduped grocery insert; toast offers Undo that deletes exactly the inserted rows. |
| **Add a memory** (photo→saved) | 3–5 | 1 | 0–1 | ~20s | ✅ | ✅ per-file upload progress bar ("N of M uploaded") | ✅ **Undo** on the "Memory created" screen (deletes the rows + storage) | In-app camera OR upload; multi-shot. Live per-photo progress + 25 MB pre-check + undo (2026-07-03). |
| **Plan tonight's dinner** | 4–6 | 0–1 | 1–2 | ~30s | ✅ | ✅ | ✅ | Meals module. Candidate for a one-tap "plan tonight" NL command (backlog #2). |
| **Check "what needs me now"** | 0–1 | 0 | 0 | ~5s read | ✅ | ✅ | n/a | Home Mission Control + moment banner (now shows leave-by, real weather, birthdays, **double-booking warnings**, one-tap remind). Static across day → backlog #7 (time-of-day). |
| **Onboarding → first value** | ~3–6 | 1 (name) | 1–4 (steps 3–5 skippable) | ~40–90s | ✅ | ✅ resumable draft + optimistic finish | ✅ nothing written until Finish; PIN skippable | Audited: PIN made skippable (1 required field = name); sessionStorage draft resume; family name auto-suggested. **Done screen now nudges Kid Logins** when no-email kids were added, closing the loop to `/dashboard/family-access`. Remaining: instrument real medians. |
| **Customize the sidebar** | 2–4/change | 0 | 0 | ~15s | ✅ | ✅ live | ✅ reset | Settings → Navigation Choices. Solid. |

## Journey targets (what "great" looks like)
- Any recurring daily action (reminder, add-to-list, check schedule): **≤1 tap, 0 typing, 0 switches.**
- Any creation flow (memory, task, event): **≤1 free-text field**; infer the rest, allow edit.
- Onboarding: **time-to-first-value < 90s**; defer every non-essential field to just-in-time.
- Every destructive action: confirm **or** undo (never both-absent), and every async action shows instant feedback.

## How to keep this alive
1. Before a dev cycle, read this + the Opportunity Register.
2. When a journey changes, update its row (and note the commit).
3. When telemetry lands, replace estimates with real medians and date the row.
