# PUSH-004 — Consent at every public push sender

2026-09-12. The root recorded and authorized this bounded repair after independent review reproduced a public-sender bypass. This lane owns the shared sender, the small marketing accounting adjustment, necessary count fixtures and focused execution tests. No SQL, provider configuration, external delivery or dependency change occurred.

## Reproduction and repair

The marketing action called `sendPushToUsers` directly, while recipient `push_enabled` and parental `child_channels.push` checks existed only inside `dispatchPendingPushes`. Executing the actual marketing action, recipient selector and sender with a controlled native transport and a stateful database sent to a child whose two push settings were both false. The campaign became `sent`, and there were zero reads of either policy. This pre-existing caller gap also reached the newly functional native transport.

`sendPushToUser` and `sendPushToUsers` now always resolve both policies before delivery. Actual device delivery and already-authorized fanout are private functions. The notification dispatcher resolves its complete candidate set once and uses the private fanout, avoiding repeated consent reads for each notification. Public multi-user calls deduplicate recipients and resolve consent in chunks of at most 200 IDs. Every chunk must succeed before the first device send. Returned or thrown membership, child-setting or preference read failures propagate to the caller and permit no provider request.

`PushResult.withheld` explicitly counts recipients denied by user or parental policy. It is separate from `skipped`, which still counts unsuccessful device attempts caused by missing configuration/registration. Notification opt-outs are intentionally acknowledged; unconfigured delivery stays pending. Queue totals accumulate withheld recipients per notification. The cron fallback count objects include `withheld: 0`; withheld counts are not failures.

The existing marketing schema has one skipped column. The action records provider-skipped attempts plus withheld recipients there, and its audit metadata separately preserves `withheld` and `deviceSkipped`. Recipient opt-outs can complete a campaign with zero sends; a policy read failure instead runs the existing failed-state transition and throws. A later healthy invocation can retry that failed campaign. Zero-recipient campaigns retain their existing successful no-op behavior.

The own-device test endpoint now reaches this same consent boundary. All-withheld results return HTTP 409 and `ok:false`. Its existing button checks non-success responses first and displays “Could not send test.”; it does not falsely report delivery or claim an absent subscription for this response. No copy or locale changes were necessary.

## Executed verification

`tests/push-consent-boundary.test.ts` executes the actual marketing action, public sender, child-channel helper, notification dispatcher and test-push route. The administrative authentication boundary is controlled; policy reads and writes use the stateful fixture, and provider transport is stubbed. It covers recipient opt-out, parental opt-out, both together, adult/teen allowance under the existing child-role policy, duplicate recipients, email suppression, multiple devices, zero recipients, failed policy reads and recovery, and action/audit counts. Policy-read failures demonstrate zero sends and campaign `failed`, with no success audit entry. Both direct test-push opt-out cases return 409.

The fixture also verifies a 401-recipient request resolves in 200/200/1 chunks, a failed later chunk sends nothing, and twenty queued notifications share one set of consent reads. Withheld recipients remain distinguishable from unconfigured devices through queue failure → retry → acknowledgement.

At 09:26 EDT the related suite passed **13 files / 144 tests**:

```text
node node_modules/vitest/vitest.mjs run tests/push-consent-boundary.test.ts tests/native-push-provider.test.ts tests/push-native-routing.test.ts tests/push-cursor-fairness.test.ts tests/push-delivery-retry.test.ts tests/push-dispatch-read-boundary.test.ts tests/push-send-at-boundary.test.ts tests/push-request.test.ts tests/push-endpoint-ssrf.test.ts tests/child-channels-delivery.test.ts tests/cron-notification-failure-status.test.ts tests/notification-email-boundary.test.ts tests/marketing-push.test.ts --maxWorkers=4 --reporter=dot
```

Scoped Next lint passed. Existing exact count assertions were updated to include the new explicit zero `withheld` field; provider/pruning/read behavior assertions remain intact. The root owns combined TypeScript, unit-suite and production-build gates.

## Remaining limits

Marketing audience/device enumeration and its earlier profile query remain unpaginated and use an unbounded audience `in` filter. The consent chunks do not prove campaign operation at bulk scale. Device-level delivery counts and recipient-level withheld counts have distinct units; the existing marketing skipped total aggregates them, while audit metadata retains the split.

Existing marketing provider failures can still finish as `status: sent` with a failed-delivery count; a process stopping after a campaign becomes `sending` has no recovery lease. Those workflow concerns are separate from this consent repair. Notification and campaign concurrent workers still lack per-device durable receipts, so partial delivery and lost acknowledgements can repeat sends. Policy can also change after the batch snapshot; no transactional database/provider boundary was added. Deployed RLS, real provider acceptance and physical device behavior remain unverified.
