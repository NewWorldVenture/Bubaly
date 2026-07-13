# Test Evidence

Audit date: 2026-07-13

## Passing Checks

| Command | Result |
|---|---|
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS; Next.js reports the known `next lint` deprecation notice |
| `npm.cmd test` | PASS: 305 files, 2,554 tests |
| `npm.cmd run build` | PASS: Next.js 15.5.19, 233 generated pages |
| `npm.cmd test -- tests/marketplace-circles-rls.test.ts tests/seed-data-safety-contract.test.ts tests/seed-tls-safety-contract.test.ts` | PASS: 3 files, 5 tests |
| `npm.cmd test -- tests/production-readiness-seed.test.ts tests/seed-data-safety-contract.test.ts` | PASS: 2 files, 4 tests |
| `npm.cmd test -- tests/ai-chat-request.test.ts tests/marketing-consent-safety.test.ts` | PASS: 2 files, 4 tests |
| `npm.cmd test -- tests/ai-rate-limit.test.ts tests/ai-voice.test.ts` | PASS: 2 files, 22 tests |
| `npm.cmd test -- tests/sync-feed-contract.test.ts` | PASS: 1 file, 2 tests |
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

## Audit Update - 2026-07-13 (public side-effect limits)

- `npm.cmd test`: 306 files and 2,556 tests passed.
- `npm.cmd test -- tests/public-side-effect-rate-limit.test.ts tests/ai-rate-limit.test.ts`: 2 files,
  5 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Public service-role ingestion contract now covers contact, forms, exit-intent, landing-page,
  visitor-intelligence, and A/B routes using the shared durable request guard.

## Audit Update - 2026-07-13 (model/provider request budgets)

- `npm.cmd test`: 307 files and 2,557 tests passed.
- `npm.cmd test -- tests/ai-route-rate-limit-contract.test.ts tests/ai-rate-limit.test.ts tests/public-side-effect-rate-limit.test.ts`:
  3 files, 6 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- The audited model-backed and external-provider routes now use shared durable per-user request
  budgets before paid provider calls or broad context reads. Durable enforcement depends on migration
  `0156` being applied in the target environment.

## Audit Update - 2026-07-13 (provider inventory follow-up)

- `npm.cmd test`: 307 files and 2,557 tests passed.
- `npm.cmd test -- tests/ai-route-rate-limit-contract.test.ts tests/ai-rate-limit.test.ts`: 2 files,
  4 tests passed.
- The route contract now covers marketing-admin AI, behavior coaching, and the authenticated Giphy
  proxy in addition to the prior model/provider inventory.
- Marketing AI request text is trimmed and capped at 4,000 characters before prompt construction.

## Audit Update - 2026-07-13 (durable limiter RPC privileges)

- `npm.cmd test`: 308 files and 2,558 tests passed.
- `npm.cmd test -- tests/rate-limit-rpc-security.test.ts tests/ai-rate-limit.test.ts tests/public-side-effect-rate-limit.test.ts`:
  3 files, 6 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- `npm.cmd run db:audit:schema`: all 8 required tables passed.
- Migration `0179_harden_rate_limit_rpc_grants.sql` revokes anonymous/public limiter RPC access,
  binds authenticated keys to `auth.uid()`, and restricts pruning to `service_role`.
## Audit Update - 2026-07-13

- `node --check scripts/seed*.mjs`: passed for all six legacy seed scripts plus the shared client.
- `npm.cmd test -- tests/seed-credentials-safety.test.ts tests/seed-scope-safety.test.ts`: 2 files,
  3 tests passed.
- `npm.cmd test`: 305 files and 2,554 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Static scope scan: no legacy fixed family, creator, or member UUIDs remain in `scripts/seed*.mjs`.
- `npm.cmd run db:audit:schema`: 8 required live tables available.
- Live anonymous REST probes for `marketplace_circles`, `marketplace_circle_members`, and
  `marketplace_listing_shares`: HTTP 200 for each. This is not a substitute for authenticated
  cross-family RLS attack tests.
- `npm.cmd test -- tests/public-gift-privacy-contract.test.ts`: 1 file, 1 test passed.
- Public gift privacy regression: inactive links no longer trigger child/family identifying lookups.
- `npm.cmd test -- tests/guardian-screening-turn.test.ts tests/public-gift-privacy-contract.test.ts`:
  2 files, 2 tests passed.
- Guardian callback ordering regression covers stale, skipped, malformed, and over-limit turns.
- `npm.cmd test -- tests/marketing-ab.test.ts`: 1 file, 9 tests passed.
- A/B ingestion regression covers configured versus fabricated/malformed variants.
- `npm.cmd test -- tests/marketing-consent-safety.test.ts tests/marketing-ab.test.ts`: 2 files,
  10 tests passed.
- Consent ingestion regression covers unknown, non-boolean, oversized, and null payloads.
- `npm.cmd test -- tests/ai-chat-request.test.ts`: 1 file, 3 tests passed.
- Agentic chat input regression covers malformed UUIDs, blank messages, trimming, and the 8,000-character bound.
- Voice AI regression covers local/durable limiter behavior before paid transcription and speech calls.
- Calendar feed regression covers URL-safe token bounds before service-role reads.
