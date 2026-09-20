# PUSH-001 follow-up — Queue progress and incomplete cron delivery

2026-09-12. The root audit recorded this follow-up as in progress before edits. Source ownership covers `lib/server/push.ts`, the failure calculation in both notification cron handlers, and their execution tests. No schema, policy, dependency, notification timestamp, or provider configuration was changed; no external notification was sent.

## Reproduced failures

Independent execution of the actual sender exposed a regression in retry retention: with 201 due notifications, the first 200 targeting an unconfigured native provider and the last targeting a healthy Web Push device, three scans each selected the same 200 rows. Every result was `notifications: 200, skipped: 200, sent: 0`; the healthy recipient was never attempted. The previous retry fixture ignored `order()` and `limit()`, hiding this condition.

Executing the actual push-scan handler with one skipped delivery also returned HTTP 200 and `ok: true`. Missing credentials and incomplete registrations are unsuccessful deliveries; intentional opt-outs are already filtered and resolved separately. Both cron failure calculations omitted this skipped count.

## Change

The sender uses the existing `app_settings` table for a versioned traversal cursor. The global key is `push_dispatch_cursor:v1:global`; family-scoped on-demand scans use `push_dispatch_cursor:v1:family:<familyId>`. Migration 0023 defines its text primary key and JSONB value with RLS and no client policies. Migration 0276 permits authenticated reads only for the unrelated `feature_tiers` key. All existing dispatch callers supply a service client. This is source inspection of the existing contract, not proof of deployed RLS.

Each cursor contains a version, a validated timestamp and a UUID. Timestamp strings retain PostgreSQL microseconds. The queue uses ascending `(created_at, id)` keysets, including the ID tie-breaker. A scan reads at most 200 due, unresolved rows in at most two queries: after the cursor, then the prefix through the cursor if there is room. Both queries apply the requested family scope and the same due-time cutoff. Deleted cursor rows do not prevent wrap-around, and newly due older rows remain discoverable on wrap.

The sender validates the final selected row and checks the cursor upsert response before any external delivery. Returned or thrown cursor errors, invalid cursor data, an unconfirmed write, or either failed page read surface as dispatch errors. Progress is independent of delivery acknowledgement: provider failures, missing configuration and unreadable permissions leave notifications pending, while traversal can reach subsequent batches. `created_at` and `send_at` are never changed.

Both `/api/cron/push-scan` and `/api/cron/notifications` include skipped pushes in their unsuccessful delivery count and return HTTP 502. Their actual handlers return HTTP 200 after the registration is repaired and delivery succeeds.

## Executed verification

The shared stateful fixture in `tests/helpers/push-dispatch-db.ts` applies filtering, ordered keyset predicates, limits, PostgreSQL timestamp precision, persistent upserts and notification acknowledgements. It supports returned, thrown and unconfirmed-write faults. The original retry and scheduled-delivery tests now use it.

`tests/push-cursor-fairness.test.ts` executes the actual sender and covers the 201-row regression, bounded tail/wrap reads, equal timestamps, microseconds, independent global/family progress, family filtering through wrap, future delivery, deleted cursor rows, malformed state, cursor read/write recovery, failed wrap reads and invalid batch sizes. The retry suite executes both actual cron handlers through failure and recovery, with controlled provider/database boundaries.

At 09:08 EDT, the following command passed **12 suites / 121 tests**:

```text
node node_modules/vitest/vitest.mjs run tests/native-push-provider.test.ts tests/push-native-routing.test.ts tests/push-cursor-fairness.test.ts tests/push-delivery-retry.test.ts tests/push-dispatch-read-boundary.test.ts tests/push-send-at-boundary.test.ts tests/push-request.test.ts tests/push-endpoint-ssrf.test.ts tests/child-channels-delivery.test.ts tests/cron-notification-failure-status.test.ts tests/notification-email-boundary.test.ts tests/notification-due-surfaces.test.ts --maxWorkers=4 --reporter=dot
```

Scoped Next lint, `git diff --check`, and full standalone strict TypeScript (`node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false`, exit 0) passed. Root owns combined repository tests and production build.

## Limits

This cursor records progress; it provides no exclusive worker claim or per-device delivery receipt. Concurrent scans may read the same cursor, overwrite progress or repeat delivery. Partial sends, lost acknowledgements or a process stopping after a cursor write can require later retries. A growing backlog still limits delivery latency; wrap-around depends on reaching the current tail. `PUSH-003` remains open for a durable claim/receipt design and real-database concurrency verification.

The tests use controlled database and provider transports. Deployed RLS, database query execution/plans, durable cursor persistence on the live service, overlapping production workers, real provider acceptance and physical device delivery remain unverified. No production-readiness claim is made.
