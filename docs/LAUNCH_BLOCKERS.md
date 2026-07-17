# Launch Blockers

The repository is currently NO-GO. These blockers are external, incomplete, or insufficiently verified;
they are not counted as completed audit weight.

| ID | Severity | Blocker | Evidence | Owner/dependency | Exit criteria | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LB-001 | P0 | Supabase Auth Admin users health check returns HTTP 500 | `npm.cmd run db:audit:auth` at 2026-07-16 09:38 America/New_York: public Auth health passed; Admin users returned HTTP 500 `Database error finding users` (request `019f6b24-3266-7b9b-afce-1d33e7648848`) | Supabase project/operator access | Admin users endpoint returns healthy response and auth smoke passes | Open |
| LB-002 | P0 | Remote migration ledger is not verified against checkout | Local `npm.cmd run db:audit:migrations` passes with 230 numbered migrations through 0214; remote history is not confirmed | Supabase project access | Reconcile all 230 migrations with remote ledger and safely apply pending launch-critical migrations (including 0208 and 0210-0214 as applicable) | Open |
| LB-003 | P0 | Historical Supabase service credential requires rotation | Credential exposure and rotation dependency are documented in existing readiness report | Supabase owner/secret manager | Rotate/revoke, update deployment secrets, verify old key fails | Open |
| LB-004 | P1 | Local Postgres/RLS lint is unavailable without a running Supabase container | `supabase db lint --local` previously failed with `LegacyDbConnectError` | Docker/Supabase local runtime | Run migration/RLS lint in isolated local or CI database | Open |
| LB-005 | P1 | Authenticated browser E2E coverage includes an intentional skip | Public E2E baseline records 51 passed and 1 authenticated skip out of 52 | Test credentials/isolated environment | Execute authenticated role/device suite with no unexplained skips | Open |
| LB-006 | P1 | Third-party production callbacks and secret rotation are not fully smoke-tested | Service matrix marks Stripe, Google, email and push as partial | Provider sandbox credentials | Verify callback, retry, idempotency, outage and rotation behavior | Open |
| LB-007 | P1 | Page-by-page and interaction-by-interaction audit is incomplete | `docs/AUDIT_PROGRESS.md` has 18 in-progress units | Ongoing audit work | All weighted units meet their completion gate | Open |
| LB-008 | P1 | Backup/restore and rollback rehearsal is not evidenced | No current restore drill artifact in this checkout | Supabase/Vercel operator access | Complete isolated backup restore and deployment rollback drill | Open |
| LB-009 | P1→P2 | `family-media` media bucket is served via public URLs (PLA-0461) | Bucket + family-folder write RLS now defined in migration `0216` (commit `46556214`, PG16-validated: cross-family write blocked). Residual: bucket is `public` and all four consumers use `getPublicUrl`, so object URLs are unauthenticated | Supabase owner: apply `0216` to prod (human-owned) + decide public→signed-URL + migrate stored URLs | Partially mitigated: bucket defined + write-isolated + reproducible. Remaining: flip reads to private/signed URLs (needs a data-migration of stored public URLs in family_photos/family_messages) and apply `0216` to prod | Open (downgraded) |
| LB-010 | P0 | **wallet ledger money-minting** — until migration 0217 is applied to prod, any family member (incl. a child) can INSERT a completed credit into `wallet_transactions` and mint spendable money (PLA-0580) | Proven live on PG16: child INSERT of a $9,999.99 completed credit succeeded pre-0217; blocked post-0217 | Supabase owner (apply 0217 — human-owned) | Apply 0217; verify a non-manager INSERT to any wallet_* table is rejected in prod | Open |

## Release Rule

No production launch recommendation may be changed to Go while any P0 blocker is open or while a P1
blocker lacks an owner, exit criteria, and current evidence.
