# Test Evidence

Audit date: 2026-07-13

## Passing Checks

| Command | Result |
|---|---|
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS; Next.js reports the known `next lint` deprecation notice |
| `npm.cmd test` | PASS: 299 files, 2,542 tests |
| `npm.cmd run build` | PASS: Next.js 15.5.19, 233 generated pages |
| `npm.cmd test -- tests/marketplace-circles-rls.test.ts tests/seed-data-safety-contract.test.ts tests/seed-tls-safety-contract.test.ts` | PASS: 3 files, 5 tests |
| `npm.cmd test -- tests/production-readiness-seed.test.ts tests/seed-data-safety-contract.test.ts` | PASS: 2 files, 4 tests |
| `npm.cmd test -- tests/seed-credentials-safety.test.ts ...` | PASS: all seed credential/TLS/safety contracts |
| `git diff --check` | PASS |
| `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e` | PASS: 51, skipped 1 |
| `npm.cmd audit --omit=dev --audit-level=high` | Reports 2 moderate advisories, no fix available |

## Browser Coverage

- Public routes rendered successfully: home, pricing, features, how-it-works, security, FAQ, AI,
  mobile, blog, contact, login, and signup.
- Accessibility checked in dark and light modes using axe, with no serious or critical violations.
- Horizontal overflow checked at 320, 390, 768, and 1024 pixels with no failures.
- Anonymous dashboard access redirected to login.
- Authenticated first-value journey was intentionally skipped because `E2E_AUTHENTICATED` was not set.

## Database Evidence

- Live schema audit: earlier required probes passed; `marketplace_circles` returned HTTP 500 / `42P17`
  before the new migration.
- Live Auth audit: public health passed; Admin users returned HTTP 500.
- Local Supabase migration/RLS tests: not run because Docker Desktop's Linux engine was unavailable.
- No destructive production database or storage operation was run.
- Historical credential comparison confirmed the removed source credential matched the current local
  service key; Supabase key management returned HTTP 403 and rotation was not possible here.

## Known Gaps

- Authenticated browser journey and RLS attack tests require an isolated Supabase instance.
- Production migration application and post-migration live probes remain pending.
- Visual regression, large-dataset performance, webhook replay, and third-party provider failure tests
  remain documented in `testing-plan.md` and the production ledger.
## Audit Update - 2026-07-13

- `node --check scripts/seed*.mjs`: passed for all six legacy seed scripts plus the shared client.
- `npm.cmd test -- tests/seed-credentials-safety.test.ts tests/seed-scope-safety.test.ts`: 2 files,
  3 tests passed.
- `npm.cmd test`: 299 files and 2,542 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Static scope scan: no legacy fixed family, creator, or member UUIDs remain in `scripts/seed*.mjs`.
- `npm.cmd run db:audit:schema`: 8 required live tables available.
- Live anonymous REST probes for `marketplace_circles`, `marketplace_circle_members`, and
  `marketplace_listing_shares`: HTTP 200 for each. This is not a substitute for authenticated
  cross-family RLS attack tests.
