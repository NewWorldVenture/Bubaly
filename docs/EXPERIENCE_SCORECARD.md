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

> ⚠️ **Measurement status:** values below are **design-time estimates** from
> reading the code, not instrumented telemetry. To make this a true scorecard,
> add lightweight analytics (a `journey_started/completed` event with a step
> counter) and a Playwright "taps to complete" harness per journey, then replace
> these estimates with medians. Treat cells as a baseline to beat.

| Journey | Taps | Typing | Switches | Time | A11y | Perceived perf | Recovery | Notes / top friction |
|---|---|---|---|---|---|---|---|---|
| **Capture a thought** (type→filed) | 2–3 | 1 | 0 | ~8s | ✅ | ✅ optimistic + Undo toast | ✅ Undo | FAB/`c` → type → AI routes. Strong. |
| **Get ready for an event** (set leave-by reminder) | **1** | 0 | **0** | ~3s | ✅ | ✅ inline states | ✅ reversible (reminders) | Home banner inline "Remind me" (Friction #1). Was 3+ taps + a screen switch. |
| **Add snacks for the game** | 1 | 0 | 0 | ~3s | ✅ | ✅ | ⚠️ no undo on add | Moment "Add N" → deduped grocery insert (Friction/​Moments). Add an undo. |
| **Add a memory** (photo→saved) | 3–5 | 1 | 0–1 | ~20s | ✅ | ⚠️ upload has no progress bar | ⚠️ | In-app camera OR upload; multi-shot. Add upload progress. |
| **Plan tonight's dinner** | 4–6 | 0–1 | 1–2 | ~30s | ✅ | ✅ | ✅ | Meals module. Candidate for a one-tap "plan tonight" NL command (backlog #2). |
| **Check "what needs me now"** | 0–1 | 0 | 0 | ~5s read | ✅ | ✅ | n/a | Home Mission Control + moment banner. Static across day → backlog #7 (time-of-day). |
| **Onboarding → first value** | ~8–12 | 3–5 | several | ~2–4 min | ⚠️ | ⚠️ | ⚠️ | Longest journey; biggest opportunity to defer/infer fields. Not yet audited this session. |
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
