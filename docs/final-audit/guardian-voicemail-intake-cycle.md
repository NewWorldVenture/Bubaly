# Guardian voicemail intake — 2026-09-19

Status: IN PROGRESS. Production-ready: NO.

This cycle repairs the remaining voicemail consumer of the callback failure
boundary tracked by `LIBRARY-10D7AA8F3175`. It is a follow-up to
published PR 510 head `43df0881fa7d7fa41a9be68a01c35549db43a63b`; hosted results
for that head do not cover this repair.

## Reproduction

The signed production-mode voicemail POST was executed with the installed
Supabase/PostgREST client and synthetic intercepted transport. Required
communication reads/writes, family scope, notification reads/writes and callback
finalization could fail while the route acknowledged HTTP 200. Some raw transport
rejections also exceeded the test's five-second deadline. The existing shared
callback claim additionally acknowledged a currently processing event as a
duplicate, so simply returning 503 on the first failure would still lose the
immediate retry.

Before repair: 12 desired failures and 4 passing controls across 16 cases.
Log: `C:/Users/Daniel/AppData/Local/Temp/bubaly-voicemail-before-20260919.log`.

## Repair and limits

The voicemail route now owns a token-fenced lease under the original permanent
`RecordingSid` primary key. Only verified processed receipts acknowledge a
duplicate; active processing and unavailable storage return 503. Confirmed
failures release only the worker's own token and can be reclaimed immediately.
Stale workers cannot complete or release a newer lease. New receipt markers also
bind the recording ID to its original communication ID across retries.

Required communication reads and recording writes have exact readback. A lost
write response can be reconciled without inventing success. The existing checked
Guardian family-scope and notification primitives retain family quiet hours and
provide a stable notification identity, including when a previous notification
has already been read. Notifications and finalization require the current lease.
The main operation has a five-second deadline; token-fenced failure cleanup is
separately bounded to two seconds. No SQL or shared SMS implementation changed.

This does not prove provider delivery, deployed configuration, live database
state or the wider voice/WhatsApp/escalation routes. Existing processed legacy
receipts remain completed for compatibility; this repair does not recover events
that older code already acknowledged without saving or bind legacy completions
to a communication retroactively. Other shared callback consumers still
acknowledge active claims; this cycle changes only voicemail. Retry availability still
depends on the provider's configured delivery policy. No provider call, production
database operation or local server was used for this verification.

## Verification

- 25 signed-route execution cases cover ordinary success and completed replay,
  all seven required failure phases as database errors and raw rejections,
  lost committed write responses, active claims, stale-worker fencing, original
  communication binding, cancellation-ignoring transport and family quiet hours.
- Focused four-suite run: 62/62 checks pass.
  Log: `C:/Users/Daniel/AppData/Local/Temp/bubaly-voicemail-after-20260919.log`.
- Guardian and notification regression: 648/648 checks across 26 files pass.
  Log: `C:/Users/Daniel/AppData/Local/Temp/bubaly-voicemail-guardian-regression-20260919.log`.
- Scoped lint on the five changed source/test files and whitespace diff checks
  pass. Full build/types and hosted acceptance for the next commit remain pending.
- Runs removed project environment variables and Vercel credentials, used
  synthetic Supabase values, disabled Vitest caching, and prohibited live fetch.

## Files

- `app/api/guardian/status/voicemail/route.ts`
- `lib/guardian/voicemail-intake.ts` (new)
- `tests/guardian-voicemail-intake-execution.test.ts` (new)
- `tests/guardian-callback-security.test.ts`
- `tests/notification-write-boundary.test.ts`

The two structural guard updates recognize the stronger voicemail-specific
claim/completion and checked notification paths. They retain pre-effect claim,
family-timezone and quiet-hours requirements; actual execution cases prove the
replacement behavior.
