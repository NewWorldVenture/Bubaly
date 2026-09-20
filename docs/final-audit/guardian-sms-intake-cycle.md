# Guardian SMS required storage and replay boundary

## Recorded executing failures before production edits — 2026-09-12

The actual `POST /api/guardian/inbound/sms` route, production HMAC signature verifier, bounded request parser, shared callback helper and installed PostgREST SDK execute against a synthetic database transport. Decision/scam analysis and notification delivery are controlled seams; no live database, SMS, AI or provider call occurs.

Initial focused suite: **3 FAIL / 2 PASS**. A healthy saved communication and invalid-signature rejection are passing controls. The three failures each receive a signed valid request and an injected HTTP503:

- Callback claim insert unavailable: the boolean shared helper returns false; the route responds200 without a communication or durable claim.
- Required member-profile read unavailable: the route treats missing data as no matching destination, writes callback status `processed`, and responds200 without a communication.
- Required communication insert unavailable: the route attempts one notification with no valid related communication receipt, writes callback status `processed`, and responds200 although no message was saved.

These are synthetic executing failures, not production telemetry or assertions about a deployed message. No application source changed before the baseline was recorded. Root already recorded the master findings and authorized a bounded route/typed-helper repair; the sibling owns the new SMS-only claim helper. The existing shared claim helper remains unchanged for other callback routes.

Baseline report: `C:/Users/Daniel/AppData/Local/Temp/bubaly-guardian-sms-intake-red-20260912.json`.

```powershell
$env:PATH = 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0;' + $env:PATH
node node_modules/vitest/vitest.mjs run tests/guardian-sms-intake-execution.test.ts --maxWorkers=1 --reporter=json --outputFile=C:/Users/Daniel/AppData/Local/Temp/bubaly-guardian-sms-intake-red-20260912.json
```

## Completed bounded repair and verification

The SMS route uses the sibling's SMS-only typed claim/lease helper. Only a confirmed processed duplicate returns200 without further work; a busy or unavailable claim returns503. Profile selection requires complete exact-count data, one valid family/member identity and its exact active destination. A clean successful empty lookup remains a deliberate non-delivery outcome; a failed lookup cannot masquerade as that empty result.

Before classification, the handler checks for an existing communication using its unique provider SID. An existing message must match the family, member, destination, sender, body, direction and message type, with valid persisted routing/scam fields and UUID receipt. A saved message supplies its previous classification on retry. After any new insert outcome, including a missing or lost response, the route re-reads this exact receipt before notification or acknowledgement. Required direct reads and writes use five-second abort signals and disable automatic SDK retry. The existing unique `guardian_communications.twilio_sms_sid` is the reconciliation boundary; no timestamp manipulation or SQL change was introduced.

Notification uses the existing real service and `once: true`, preserving quiet-hour scheduling. Its checked summary must establish one created or previously existing family notification, with valid IDs for newly created rows. Failure releases the exact live lease for safe sequential recovery; a failed or stale completion cannot mark the callback processed. Optional contact recency and trust suggestions do not establish receipt of the message.

Signed form input now rejects repeated/non-string fields, missing or noncanonical SM/MM SID, conflicting SID aliases and invalid E.164 destination. An alphanumeric sender remains supported. Configured origin whitespace/trailing slashes are normalized; the request host does not determine the signature URL. Fractional classifier confidence is validated and floored into the existing integer column; this preserves the `>=80` blocking threshold. MM identifiers are accepted for compatibility without claiming attachment/media processing.

Fixture correction after baseline: the controlled healthy decision initially used `routingMode: 'notify'`, which is not a real Guardian enum. It now uses `ai_handle_first`, and exact callback/profile/communication row representations and counts match the actual new query contracts. The original three failure reproductions occurred independently of this classification field. The profile503 fixture returns `Retry-After: 0` so the installed SDK's preexisting GET retries execute promptly rather than timing out the test runner.

Final focused checks under isolated Node24:

- **64 actual route execution cases PASS**. Covers the original three failures and subsequent retry, processed/busy claims, profile ambiguity/count failures, lost/missing communication responses, mismatched saved data, classifier validation and threshold, notification errors/invalid receipts, exact lease completion, malformed inputs, configured origin, and actual request aborts.
- Four of those cases execute the actual `systemScopeForFamily` and `notify` services against installed PostgREST: a committed notification with lost response is found on retry even after it was read; the saved row retains `is_read`, `sent_at` and `pushed_at`; required scope/dedupe failures return503 and recover from the saved communication; real quiet hours defer `send_at` as before.
- Six related files total **153 PASS**, including the sibling's43 claim tests, existing callback static guard checks, pipeline/scam-AI checks and notification service checks. The static callback test changes only the SMS helper/finish names; ordering and input guard assertions remain.
- Scoped strict TypeScript, scoped ESLint and diff-whitespace checks: **PASS**. Root owns full application gates.

```powershell
node node_modules/vitest/vitest.mjs run tests/guardian-sms-intake-execution.test.ts tests/guardian-sms-intake.test.ts tests/guardian-callback-security.test.ts tests/guardian-pipeline.test.ts tests/guardian-scam-ai.test.ts tests/service-notifications.test.ts --maxWorkers=1 --reporter=dot
```

## Explicit remaining workflow limits

This bounded storage/receipt repair does **not** establish complete SMS workflow PASS. There is no durable payload queue before synchronous AI/classification, and503 is not a provider-redelivery guarantee: deployed Twilio retry policy and its callback deadline must be verified separately. Shared `runDecisionPipeline` still treats contact/profile read errors as absence and degrades routing-rule failures to defaults; a returned valid decision is not proof all underlying policy reads succeeded. `systemScopeForFamily` and internal `notify` queries still lack the route's per-query deadline. Quiet-hour settings reads retain their existing documented fallback. No shared helper was broadened to change those contracts.

Notification `once` uses a natural-key read before insertion, without an atomic uniqueness constraint. The tests establish sequential replay preservation, not distributed exactly-once delivery during overlapping workers or a stale-lease takeover. Real PostgreSQL unique constraints/RLS, provider callbacks, notification push/email delivery and deployment retry behavior were not exercised. Existing legacy records with missing or invalid persisted message policy stay unavailable for review instead of inventing a successful receipt. No live database, SMS, AI, user, dependency, navigation or schema mutation occurred.
