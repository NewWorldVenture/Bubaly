# PUSH-001 — Pending push delivery and failure recovery

Baseline `c7b56eff`, 2026-09-12. Source edits began after the root audit inventory was created.

The baseline sender acknowledged failed, unconfigured and unreadable deliveries by stamping `pushed_at`. The current sender keeps those rows pending, counts failed device pruning and acknowledgement writes, and refuses to interpret unavailable membership or preference data as an empty audience. It respects the recipient's `push_enabled` flag as well as parental child-channel restrictions. A confirmed opt-out or a successful empty device lookup remains an intentional resolution.

The shared child-channel resolver now throws on failed reads for both push and email; their cron callers already report these failures and retain unresolved notifications. Web Push requests have a 15-second deadline. The signed-in user's test-push endpoint returns a non-success status for failed, skipped or absent delivery instead of always returning `ok: true`.

Native provider integration is recorded separately in `native-push-cycle.md`: Android registration tokens go to FCM, and iOS APNs tokens go directly to APNs. Only explicit provider confirmation of an unregistered device permits pruning. Unknown providers fail instead of being sent to Firebase.

## Executed verification

`tests/push-delivery-retry.test.ts` executes the actual sender, child-channel resolver, cron route and test-push route. Its stateful database fixture applies recipient, due-date, preference and pending-state filters and preserves writes between invocations; provider transport is controlled. It demonstrates failure → pending readback → successful retry → no third send, failed recipient/device/preference reads, parental and user opt-outs, missing configuration, partial delivery, failed pruning and failed acknowledgement. The actual cron returns 502 on delivery failure and 200 after recovery; unauthorized requests never send.

`tests/push-native-routing.test.ts` separately verifies recipient-scoped provider selection, iOS/Android token separation, confirmed stale registration pruning, failed pruning, unconfigured/error retention and unknown-provider rejection.

Focused execution on 2026-09-12:

```text
node node_modules/vitest/vitest.mjs run tests/push-delivery-retry.test.ts tests/push-send-at-boundary.test.ts tests/push-dispatch-read-boundary.test.ts tests/child-channels-delivery.test.ts tests/cron-notification-failure-status.test.ts tests/notification-email-boundary.test.ts --maxWorkers=4
```

Six suites / 41 assertions passed. After native integration, the delivery and native-routing suites passed 30 assertions in two files. Scoped lint passed for all root-owned changed source/tests. Root owns the subsequent combined regression.

## Open verification

This proves the local failure-retention and provider-routing behavior, using controlled database/provider boundaries. It does not prove deployed cron credentials, applied RLS, real VAPID/native credentials, physical device receipt or user-facing notification rendering. Those remain part of the parent workflow audit.

`PUSH-003` remains actionable: one notification-wide timestamp provides neither a distributed worker claim nor individual device receipts. A partial delivery, lost acknowledgement response or overlapping cron workers can repeat a successful push. Comments no longer claim exactly-once delivery. A reviewed durable per-device claim/receipt design and real-database concurrency verification are needed; no SQL was authored or applied in this cycle.

Production readiness remains **NO**.
