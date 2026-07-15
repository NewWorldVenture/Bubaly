# Launch Blockers

The repository is currently NO-GO. These blockers are external, incomplete, or insufficiently verified;
they are not counted as completed audit weight.

| ID | Severity | Blocker | Evidence | Owner/dependency | Exit criteria | Status |
| --- | --- | --- | --- | --- | --- | --- |
| LB-001 | P0 | Supabase Auth Admin users health check returns HTTP 500 | `npm.cmd run db:audit:auth` latest request `019f669f-9f42-7c56-b92c-dd6180f3eeac` | Supabase project/operator access | Admin users endpoint returns healthy response and auth smoke passes | Open |
| LB-002 | P0 | Remote migration ledger is not verified against checkout | Current audit scripts are not linked to a confirmed remote migration history; local checkout now has 229 migrations through 0213 | Supabase project access | Reconcile all 229 migrations with remote ledger and safely apply 0208, 0210, 0211, 0212, and 0213 | Open |
| LB-003 | P0 | Historical Supabase service credential requires rotation | Credential exposure and rotation dependency are documented in existing readiness report | Supabase owner/secret manager | Rotate/revoke, update deployment secrets, verify old key fails | Open |
| LB-004 | P1 | Local Postgres/RLS lint is unavailable without a running Supabase container | `supabase db lint --local` previously failed with `LegacyDbConnectError` | Docker/Supabase local runtime | Run migration/RLS lint in isolated local or CI database | Open |
| LB-005 | P1 | Authenticated browser E2E coverage includes an intentional skip | Public E2E baseline records 51 passed and 1 authenticated skip out of 52 | Test credentials/isolated environment | Execute authenticated role/device suite with no unexplained skips | Open |
| LB-006 | P1 | Third-party production callbacks and secret rotation are not fully smoke-tested | Service matrix marks Stripe, Google, email and push as partial | Provider sandbox credentials | Verify callback, retry, idempotency, outage and rotation behavior | Open |
| LB-007 | P1 | Page-by-page and interaction-by-interaction audit is incomplete | `docs/AUDIT_PROGRESS.md` has 18 in-progress units | Ongoing audit work | All weighted units meet their completion gate | Open |
| LB-008 | P1 | Backup/restore and rollback rehearsal is not evidenced | No current restore drill artifact in this checkout | Supabase/Vercel operator access | Complete isolated backup restore and deployment rollback drill | Open |

## Release Rule

No production launch recommendation may be changed to Go while any P0 blocker is open or while a P1
blocker lacks an owner, exit criteria, and current evidence.
