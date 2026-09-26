# INT-001 — Contact Center callback and intake recovery cycle

Date: 2026-09-12. Baseline: currentmain c7b56eff. Changes began only after root created `finalaudit.md` and recorded INT-001 IN PROGRESS. Root owns the master audit status.

## Verified repository changes

1. `middleware.ts` now allows exactly four provider callback paths to reach their own authorization: `/api/contact-center/email`, `/api/contact-center/sms`, `/api/contact-center/voice`, `/api/contact-center/voice/transcription`. It does not allow the Contact Center prefix or additional descendants. Email secret checks and Twilio signature verification remain unchanged.
2. SMS and voicemail transcription preserve a captured message after planner failure and return HTTP 503 on failed/thrown intake or unavailable family scope. A replay reads that same message's `ai_handled` using both message ID and family ID, retries only unhandled work, and preserves the original provider-ref intake identity. Missing/invalid/unreadable completion state fails with 503. Completed replays do not run intake again.
3. All three voicemail 204 responses use a null body, avoiding the installed framework's invalid-response exception.
4. Urgent SMS/voicemail notification and fallback-SMS effects run immediately after the original inbox insertion, before any planner/replay failure can return early. They avoid repeated escalations when providers redeliver while retaining the original alert even when planning needs a retry.

Owned production files: `middleware.ts`, `app/api/contact-center/sms/route.ts`, `app/api/contact-center/voice/transcription/route.ts`. Added execution suite: `tests/contact-center-callback-boundary.test.ts`. No SQL, schema, dependency, shared navigation or external provider changes.

## Failure evidence before fixes

- Baseline current middleware, executed with real NextRequest/NextResponse and mocked signed-out auth, returned 307/login for all four callbacks. Existing public callback controls passed.
- Actual SMS handler with a failed planner handoff followed by a deduplicated delivery returned [200,200] and attempted planning once, losing the work.
- Actual voicemail handler threw `TypeError: Response constructor: Invalid response status code 204` when constructing an empty-string body at status 204.
- The new middleware→handler regression suite initially had 19 failures / 5 passes. This demonstrates that the tests detect the baseline callback breakage.

## Retest evidence

`tests/contact-center-callback-boundary.test.ts` executes the actual middleware and then the actual handler export using the same request. It uses real NextRequest/NextResponse, the real bounded body parser, real Twilio HMAC verification with test-only credentials, actual inbox/planner-routing services and the existing in-memory Supabase helper. Only user-auth results, AI classification/intake, and outbound sends are mocked. No network or external writes occur.

Covered cases include:

- Invalid Twilio signatures for SMS/voice/transcription and invalid inbound email secret reject with 401 before household access.
- Valid signed voice returns its real TwiML/transcription callback.
- Five neighboring Contact Center paths stay protected by middleware.
- SMS and voicemail return 503 after returned or thrown intake failure; the same persisted message recovers on retry, stamps `ai_handled`, keeps one request identity, and suppresses further intake on completed replay.
- Missing system family scope recovers after the family becomes readable.
- Thrown and returned database errors in the required replay read fail closed.
- A deduplicated message from another family cannot be handed to the current family's planner.
- A failed `ai_handled` write leaves intake persisted; replay uses the same idempotency identity and repairs the completion stamp without creating a second request in the test intake.
- Urgent replays do not repeat SMS/notification effects, including when the first planning handoff returns `intake_failed` or throws. Root's review identified the need to preserve escalation before new early-return paths; four explicit failure→retry cases now verify that ordering.
- Empty family ID, empty transcript and normal voicemail completion produce bodyless 204 responses.

Commands:

```text
node node_modules/vitest/vitest.mjs run tests/contact-center-callback-boundary.test.ts tests/contact-center.test.ts tests/contact-center-routing-to-planner.test.ts tests/inbound-email-entity-retry.test.ts tests/email-attachments.test.ts tests/middleware-public-api-boundary.test.ts tests/middleware-bearer-api.test.ts tests/middleware-oauth-code-routing.test.ts tests/public-webhook-signature-boundary.test.ts tests/cron-auth.test.ts
```

Result: **10 files / 121 tests passed**, including 32 new execution tests; 2.57 seconds. Existing contact routing, email enrichment/attachment retry, middleware and guardian/cron authorization suites passed.

```text
node node_modules/next/dist/bin/next lint --file middleware.ts --file app/api/contact-center/sms/route.ts --file app/api/contact-center/voice/transcription/route.ts --file tests/contact-center-callback-boundary.test.ts
```

Result: **PASS**, no ESLint warnings/errors. Framework printed its existing next-lint deprecation notice.

```text
node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false
```

Initial run found one test-fixture union error (`fields` could contain an undefined value). The empty fixture is now explicitly `Record<string,string>`. The final strict full-project rerun after all 32 execution cases and the urgency-ordering changes **passed with no errors**. `git diff --check` passed.

## Verification limits and remaining workflow scope

The three baseline repository failures above are fixed and locally retested. This does **not** verify deployed middleware, live Supabase RLS/constraints, real provider delivery, AI planning/execution, attachment storage, inbox browser rendering or production provider configuration. Those need the designated test accounts/database and sandbox provider delivery.

The existing outbound design remains a separate actionable reliability item: urgent fallback sends are best-effort and log failures without a durable retry marker, and SMS/email auto-replies can repeat on provider replay. This cycle prevents repeated urgent effects for an already-captured event; it does not claim exactly-once external delivery or durable recovery of failed outbound sends. Reusing the existing outbox/notification infrastructure and testing provider failure/replay is a further repository workflow, not merely an external-credential blocker. AI classification also still runs before inbox deduplication.

Provider request signatures are tested with the canonical configured callback URL. The missing-family acknowledgement fixture uses `?familyId=`; a request whose signed URL omits that query entirely is rejected by the existing URL/signature reconstruction and does not bypass authorization.

Production readiness remains **NO**. Root should mark the specific local defects fixed with the above evidence and continue the remaining Contact Center/provider workflow, rather than mark the whole integration end-to-end passing.
