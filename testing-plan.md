# Testing Plan

## Current automated coverage
- **Vitest**: 275 files / 2400+ tests over pure engines (wallet ledger/auth decisions, sync
  adapters/conflict/crypto/ICS, calendar recurrence/heatmap, workload, independence, calm,
  reasoning, marketplace, onboarding completeness, offline cache, a11y helpers, …).
  Run: `npx vitest run`.
- **Type/lint/build**: `npx tsc --noEmit` · `npx eslint .` · `npx next build` — all enforced
  before every push this session.
- **Database**: throwaway PG16 cluster validation for every migration (idempotent ×2) and seed
  (row counts + spreads). RLS behavior smoke-tested with `request.jwt.claim.sub` switching.

## Manual/scripted checks in the repo
- Route inventory + dead-link scan (172 internal hrefs) — scripted, re-runnable.
- API auth audit (95 routes) — scripted classifier + manual review of flagged routes.
- 136-page UX signal scan + manual bottom-cohort review (todo.md matrix).

## Known gaps (next investments, in order)
1. **E2E (Playwright)**: auth → onboarding → first-value journey on mobile/desktop viewports.
   Chromium is preinstalled in CI sandboxes; needs a seeded Supabase login (open item #24 in the
   opportunities table: "CI Supabase login for authed E2E").
2. **RLS test matrix as CI suite**: promote the PG16 role-switch smoke tests into a committed
   pgTAP/vitest-pg suite covering owner/member/non-member/anonymous per table family.
3. **Visual regression**: core pages × light/dark × mobile/desktop (tooling not yet chosen).
