# PUSH-005 — Complete bounded marketing push audience reads

2026-09-12. Root recorded PUSH-005 before implementation. No SQL, production data, provider credentials, live sends, navigation, dependency, commit or deployment changes were made in this lane.

## Reproduced defect

The marketing push action read enabled device owners and the suppression table without ordering or pagination. Its profile query used one unbounded `in` list. A capped successful response looked complete: missing suppression rows allowed recipients through, while omitted device rows silently reduced the campaign audience. A missing profile email also looked eligible to the pure recipient selector.

At 09:44 EDT, executing the actual marketing action, public push sender and child-channel resolver with the existing stateful database fixture and a simulated 1,000-row response cap produced:

| Fixture | Executed result before repair |
| --- | --- |
| 1,001 suppressions; target recipient in the omitted last row | One provider-stub send; campaign `sent` |
| Identical suppression fixture with no response cap | Zero sends |
| 1,001 eligible users with one device each | Only 1,000 sends; campaign `sent` |

The cap is an execution-fixture condition, not a claim that the deployed database limit was inspected. Migration 0021 establishes the suppression email primary key and exclusion contract; migration 0063 applies that contract to marketing push campaigns.

Before application changes, the new action execution suite had **22 failures and 3 passes**, including both truncation reproductions. Later defensive cases bring the final new suite to 30 tests.

## Repair and behavior

`lib/marketing/push-audience.ts` reads devices in stable ID order, deduplicates their owners, reads profiles in chunks of at most 200 IDs, and traverses suppressions in email primary-key order. Every request is limited to 200 rows. All three sources continue until an empty page; a short page alone cannot end a traversal because the Data API can cap responses below the requested size. Profiles within each ID chunk also use keyset paging, so a smaller response cap cannot hide a profile.

The loader completes before the action invokes the public sender. That sender then completes its existing recipient and parental consent reads before contacting devices. Returned or thrown failures on any audience page reject the action and run the existing conditional `sending` → `failed` transition. No device has been contacted at that point, and a later healthy invocation can retry. Invalid keys, repeated pages and a successful response with absent data also fail closed.

The audience loader allows at most **50,000 returned rows across its three sources and 1,000 read requests**, including empty terminators. Exceeding either bound rejects the campaign before delivery instead of truncating its audience. These are synchronous safety limits, not a bulk campaign completion guarantee. The specific limit error is passed to the existing failure logger; the action returns its existing safe send-failure response and attempts to persist `failed`. If that persistence itself fails, the action still rejects; durable recovery of an abandoned `sending` campaign remains separate.

Suppression traversal preserves each raw database email key, including case and whitespace, when constructing the next query. Matching retains the existing trim/case-insensitive behavior. It does not replace the full suppression traversal with case-sensitive exact-email lookups that would miss existing mixed-case/manual rows.

Missing profiles, missing email values, wrong value types, blank emails and malformed addresses fail closed. Address validation matches the conservative format already used by `lib/marketing/send.ts`, after trimming. A verified profile containing an explicit `email: null` remains eligible for normal push consent checks: the existing `tests/marketing-push.test.ts` explicitly permits null email, migration 0002 makes it nullable, and migration 0003 copies nullable auth email into the profile. This preserves the established phone-account behavior without treating an absent profile as a known null.

A verified empty device audience completes with zero recipients and zero sends without unrelated profile/suppression reads. Existing reservation, deliberate consent-withholding accounting and provider result accounting remain intact.

## Executed verification

`tests/marketing-push-audience-execution.test.ts` executes the actual action → audience loader → public sender → child-channel helper. Administrative authentication, Next cache and provider transport are controlled boundaries. The stateful fixture applies filtering, ordering, limits, writes and an optional independent response cap. Its additions are limited to response caps, `gt` filtering and ordinal thrown failures.

The 30 execution tests cover later-page suppression and recipients, smaller response caps on all three sources, duplicate device owners, mixed-case/whitespace suppression, profile chunk boundaries, all three returned and thrown later-page failures with recovery, missing/invalid profile data, explicit null email, malformed/repeated pages, both global budgets, verified empty audience, concurrent campaign reservation and recipient/parental opt-outs. No test contacts a live provider.

At 09:51 EDT, **11 suites / 164 tests passed**:

```text
node node_modules/vitest/vitest.mjs run tests/marketing-delivery-action-boundaries.test.ts tests/marketing-push-audience-execution.test.ts tests/push-consent-boundary.test.ts tests/marketing-push.test.ts tests/push-native-routing.test.ts tests/push-cursor-fairness.test.ts tests/push-delivery-retry.test.ts tests/push-dispatch-read-boundary.test.ts tests/push-send-at-boundary.test.ts tests/native-push-provider.test.ts tests/child-channels-delivery.test.ts --maxWorkers=4 --reporter=dot
```

The existing static action-boundary test follows the extracted loader and retains reservation, failed-state and final-write protection. Scoped lint passed. A strict TypeScript program using the repository compiler options and the four owned implementation/test roots plus `next-env.d.ts`, including imported dependencies, returned zero diagnostics. This was a scoped check, not the full project gate. Root owns combined project tests, types and build checks.

## Remaining limits

Pagination is not a transactional snapshot. Devices, profiles, suppressions or consent can change during traversal or after selection; a concurrently added suppression whose key has already been passed may be absent from that campaign's selected snapshot. Database reads and provider sends are not atomic. This cycle repairs complete traversal of a stable bounded audience and fails known incomplete reads; it does not establish atomic unsubscribe-to-provider exclusion.

Provider failures or unconfigured skips can still finish a campaign as `sent` with nonzero failed/skipped counts. Process interruption after `sending`, partial provider acceptance, lost acknowledgements and concurrent retries still lack durable per-device receipts/recovery. Sending to all of a user's devices still uses the shared sender's existing device-read behavior. This is not a complete campaign workflow PASS, and neither real provider acceptance, physical device delivery nor deployed database/RLS behavior was exercised.
