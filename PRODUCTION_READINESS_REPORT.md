# Production Readiness Report

## Executive Summary

FamilyOS is in a strong local validation state, but it is not proven production-ready. The current
tree compiles, passes lint and type checking, passes 2,549 unit tests, builds all 233 Next.js build
routes, and passes 51 public/mobile/accessibility E2E checks. The audit also found and repaired a
real RLS recursion defect in marketplace circles, but the new migration has not been applied to a
live database by this audit.

Recommended decision: **NO-GO until the pending database migration is applied and the live Supabase
Auth Admin 500 is diagnosed, and the exposed historical Supabase credential is rotated.** After
those checks pass in an isolated environment, the posture can be reconsidered as Conditional Go.

## Scope and Inventory

- 348 `page.tsx` route files.
- 100 API route handlers.
- 193 migrations at audit start; new additive repair migration `0178` added.
- 309 SQL files under `supabase`.
- 303 unit-test files and 2,549 passing tests.
- Existing detailed inventories: `route-inventory.md`, `database-map.md`, `feature-inventory.md`,
  `architecture.md`, `security-review.md`, `testing-plan.md`, and `user-journeys.md`.

## Fixes Completed

- Added `0178_marketplace_circles_rls_recursion.sql` to replace recursive circle policies with
  pinned SECURITY DEFINER membership helpers.
- Preserved active family membership checks and tightened listing-share deletion to the owning family
  and listing.
- Added `tests/marketplace-circles-rls.test.ts`.
- Removed process-wide TLS certificate-verification bypasses from six seed scripts and added a
  regression contract test.
- Added `supabase/seed_production_readiness.sql`, an idempotent pack generating 600 realistic
  independence-ladder records without destructive statements or Auth writes.
- Removed a live Supabase service credential from all current seed scripts and centralized credential
  loading in `scripts/seed-client.mjs`.
- Updated `.env.example` with runtime variables previously used by the code but undocumented.
- Preserved pre-existing user changes in the two seed files and the seed-safety contract test.

## Security Findings

- No new secret was added or printed.
- P0: a historical seed script contained a credential matching the current configured service key. The
  current tree is scrubbed and regression-tested, but rotation and audit-log review require a Supabase
  project owner; the CLI returned HTTP 403 for the key-management endpoint.
- Existing middleware refreshes Supabase sessions and redirects anonymous users away from protected
  routes.
- Existing response headers include `nosniff`, frame denial, strict referrer policy, permissions
  policy, and HSTS.
- Existing documentation records earlier auth, webhook, tenant-isolation, and rate-limit repairs.
- Marketplace circles had a P1 availability/authorization-verification defect; the additive repair
  is present but awaits migration application and RLS allow/deny testing.
- `npm audit --omit=dev --audit-level=high` reports two moderate PostCSS advisories through Next.js,
  with no available fix in the installed dependency graph.

## Validation Results

| Check | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm.cmd run typecheck` |
| Lint | PASS, with Next.js deprecation notice | `npm.cmd run lint` |
| Unit tests | PASS, 2,549 tests / 303 files | `npm.cmd test` |
| Production build | PASS, 233 generated pages | `npm.cmd run build` |
| Public E2E | PASS, 51 tests; 1 intentional auth skip | `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e` |
| Accessibility E2E | PASS for public routes in dark and light modes | Playwright + axe |
| Mobile overflow E2E | PASS at 320, 390, 768, and 1024 widths | Playwright |
| Migration contract | PASS, 4 tests | targeted Vitest run |
| Schema probe | BLOCKED/FAIL | live `marketplace_circles` HTTP 500, PostgreSQL `42P17` before repair |
| Auth Admin probe | BLOCKED/FAIL | live GoTrue HTTP 500 `Database error finding users` |
| Local Supabase migration | BLOCKED | Docker Desktop unavailable |
| Dependency audit | FAIL/PENDING | 2 moderate PostCSS advisories, no fix available |
| Live RLS attack tests | NOT RUN | requires isolated Supabase with migration applied |

## Remaining Launch Blockers

1. Apply migration `0178_marketplace_circles_rls_recursion.sql` in the intended environment and
   rerun schema plus cross-family RLS allow/deny probes.
2. Diagnose the live Supabase Auth Admin 500 in Supabase/GoTrue/Postgres logs and rerun the Auth audit.
3. Resolve or formally accept the PostCSS advisory after reviewing the next compatible Next.js release.
4. Run authenticated E2E and database RLS tests against an isolated local Supabase instance.
5. Confirm production environment variables and third-party provider configuration using the updated
   `.env.example` and deployment checklist.

## Recommended Launch Decision

**NO-GO.** The local application quality gates are green, but live database migration state, Auth Admin
health, and RLS attack tests are not fully proven. No production data was changed during this audit.
## Audit Update - 2026-07-13

Legacy service-role seed scripts were hardened after the initial report: fixed family/user scopes
and stale member fallbacks were removed. Every `scripts/seed*.mjs` script now requires an explicit
non-production environment, confirmed family UUID, and creator UUID through `scripts/seed-client.mjs`.
The focused scope and credential safety tests pass. This does not clear the external Supabase key
rotation, pending migration, Auth Admin 500, local Docker, or dependency advisory blockers.

The public gift capability flow was also hardened: inactive or revoked gift URLs no longer perform
service-role lookups or disclose child/family names. A regression contract covers the privacy boundary.

Guardian AI screening callbacks now require the next bounded persisted turn before AI work or further
service-role reads, preventing stale, skipped, and over-limit callback replays from duplicating work.

Public A/B event ingestion now validates submitted variants against the active experiment definition
and bounds identifiers before writing service-role events, preventing fabricated metrics.

Public consent ingestion now rate-limits both reads and writes and rejects unknown, non-boolean, or
oversized consent maps before appending service-role events.

The authenticated agentic AI chat route now enforces per-user in-memory and durable request limits,
validates conversation UUIDs, and rejects oversized or empty messages before model/tool execution.
