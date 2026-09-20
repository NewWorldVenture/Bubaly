# EMAIL-001 — Resend suppression retry cycle

2026-09-12. Baseline `c7b56eff`; source changes began after root created `finalaudit.md`.

## Problem and repair

A valid `email.complained` or `email.bounced` callback that encountered a transient suppression write error returned 503 but left its event `processing`. An immediate signed retry then returned 200 `duplicate` without suppressing the recipient. Baseline reproduction executed the real route in memory with a valid Svix fixture signature: first=503, retry=200, suppression attempts=1, event status=processing.

`app/api/webhooks/resend/route.ts` now acknowledges duplicate completion only for a `processed` event. Active or contended claims return 503 with `Retry-After: 30`. Failed processing releases its claim as `error`; if release also fails, retries remain unsuccessful until the stale claim can be recovered. Conditional updates compare status and `received_at`; monotonic timestamps fence older workers from releasing or finalizing a newer claim. Suppression upserts run before metrics. Signed malformed JSON shapes, malformed `tags`/`to` and suppression events without recipients return 400 before a receipt is written.

Provider-contract review also found that webhook tags use a string record, while the original route assumed the outbound API's name/value array. Validation and campaign lookup now accept Resend's documented record and retain compatibility with the previously handled array. The [official bounced-event definition](https://resend.com/docs/webhooks/emails/bounced) supplies that record contract; Resend's [webhook introduction](https://resend.com/docs/webhooks/introduction) confirms unsuccessful responses trigger retries. No provider call was needed to inspect those public definitions.

No SQL, schema, dependency, provider account or production data was changed. The implementation uses columns already defined in migration 0180.

## Executed verification

`tests/resend-webhook-execution.test.ts` executes the real route, real bounded request parser and real HMAC verification against a stateful Supabase fixture that applies uniqueness and filters. It covers:

- Forged/expired signatures; 15 malformed signed payload shapes; well-formed unsupported events.
- Bounce and complaint failure → error receipt → successful retry → processed duplicate.
- Partial recipient persistence and thrown request failures.
- Campaign read/write failures after suppression and event-finalization failure.
- Failure to persist the error state, active retry rejection and later stale recovery.
- Concurrent first inserts, concurrent stale reclamation, and old-worker completion/error after a newer worker finishes.
- The actual campaign audience resolver excludes the complaint recipient after successful retry.
- Documented record tags attribute bounce suppression and open-event automation to the campaign.

Final focused command:

```text
node node_modules/vitest/vitest.mjs run tests/resend-webhook-execution.test.ts tests/resend-webhook-replay-contract.test.ts tests/webhook-persistence-boundaries.test.ts tests/public-webhook-signature-boundary.test.ts tests/stripe-webhook-replay-contract.test.ts --reporter=dot
```

Result: **5 files / 46 tests passing** (08:55 EDT / 12:55 UTC), including 33 execution tests in the new suite. Scoped Next lint for the route and execution test passed with no warnings/errors. `node scripts/audit-supabase-queries.mjs` passed (484 tables, 77 functions, 135 API routes). `git diff --check` for owned source/test passed.

A concurrent standalone `tsc --noEmit --incremental false` run initially failed in other agents' actively edited contact-center and PWA tests. A later already-running check reported only the cron execution test's environment-map typing. Neither emitted Resend diagnostics. Root owns the final combined typecheck/build/regression, so this cycle does not claim the overall typecheck passed.

## Remaining verification and limitations

The **specific suppression-retry defect is fixed and locally verified**. The complete production integration remains open pending the agreed real database/Resend sandbox execution, configured sender/webhook endpoint and recipient delivery evidence. No external email was sent by these tests.

Exact-once campaign metrics remain a separate unresolved repository concern: the counter update and event finalization are different database writes. A lost finalization response/retry can increment a counter again, and concurrent distinct events can lose a read/modify/write increment. This repair preserves suppression idempotency and truthful retry status; it does not pretend to make those metrics transactional. A durable atomic operation or equivalent reviewed schema design is needed for that distinct guarantee. Engagement automation retains its existing best-effort contract and now logs failures safely; full automation completion is not proved by this cycle.

Source evidence here supersedes the baseline OPS-F01 suppression status in discovery. Production readiness remains **NO**.
