# SOCIAL-003 protected scheduling implementation

Source lane frozen on2026-09-12 for the parent's combined gate, following the `3effbf41` discovery and `608c9307` contract; current shared checkpoint was `d36602eb`. This cycle changes no SQL, dependencies, credentials or live provider/account state. Local fixture success does not establish a deployed scheduling workflow pass.

## Concrete repair

The actual create action can now authorize a one-off future X text/link post for1–10 connected, distinct accounts. Root owns the absolute ISO/IANA time helper, action preparation/arming, content validation and localized Studio/detail/calendar presentation. The operations lane adds the protected continuation:

1. `lib/social/scheduled-publish.ts:createScheduledPublishReceipt` obtains the real request actor, checks current membership/role, exact persisted content/time/target bindings and present encrypted credentials, then inserts a canonical `unarmed` private receipt. UUID/idempotency collision handling requires an exact verified read; it never guesses a partial-index upsert conflict target.
2. `armScheduledPublishReceipt` rechecks the same initiating actor, immutable rows, settings and credentials, then CAS-arms queued or approval-held authority. A lost arm response preserves the original post identity in the real action; a committed queued receipt can subsequently execute once.
3. `/api/cron/social-publish` uses the existing cron authorization and a service client. The dispatcher registers it every5minutes; Vercel has a daily fallback. A persistent `app_settings` UUID cursor advances through up to20 receipts per tick, including future/held rows.
4. `runPublishNow` retains its exclusive post/per-target claims. The scheduled callback rechecks the immutable snapshot and current actor before each target, claims the exact private target revision, and routes through the actual X connector.
5. `loadScheduledXAccessToken` checks the fresh private receipt/claim, exact payload, actor/member/role, current approval, connected provider identity and canonical encrypted credential. It does not call request-cookie auth in a background worker. Ordinary X calls retain `requireXActor`; the direct pipeline now also checks required approval/settings reads before dispatch.
6. Each confirmed/failed/unknown provider result is saved privately before public target/result/presentation persistence. Confirmed timestamps survive public write failure. Public repair preserves unrelated metadata and updates exact post/schedule/calendar identities. Lost private confirmation responses remain held; neither manual action nor elapsed time permits reposting.

`lib/social/scheduled-authority.ts` strictly validates canonical family/post/schedule IDs, tool namespace, resource binding, system/null references, actor/member IDs, bounded immutable snapshots and versioned output revisions. Inputs/outputs contain no OAuth tokens or raw provider error payloads. Receipt SELECT visibility is manager-readable under existing migration0250; it is server-write-private, not manager-secret.

## Failure and concurrency behavior

- A current or original approval requirement, or public pending/rejected/changes-requested/**unverified approved** state, holds the schedule. This cycle does not invent an approval product. Editing public approval fields cannot release held private authority.
- Failed required membership/permission/settings reads remain visible as a safe diagnostic and can retry later. Confirmed revoked membership/permission or changed immutable rows are held as failed. Unsent held schedules are not labeled actively publishing. A fresh valid manual actor can publish the original immutable schedule under its own current authority.
- Manual-now and simultaneous cron starts share a private revision CAS. Existing public post/target claims remain active. Previous confirmed targets never resend, including when another target receives429.
- Only the429 target retries automatically, at5/10minute backoff and at most3 total attempts. A different400 failure in the same batch does not silently retry alongside it. An explicit manual action can retry a confirmed failure after current checks.
- Transport timeout, HTTP408/5xx, missing/malformed acceptance and inconsistent result remain unknown. A provider acceptance whose private write response was lost remains dispatching/unknown. No age-based provider reclaim exists.
- Dispatch has a70second budget. Every query maps deadline cancellation to AbortError, preventing the installed SDK's automatic GET retry on TimeoutError. Credential reads carry the same cancellation. Finalization shares a100second cap; the route limit is110seconds and dispatcher HTTP limit120seconds. X requests retain fixed host/manual redirects and their15second cap.
- Held dispatching receipts remain in discovery for display repair after120seconds, beyond the operation budget. That repair never calls a provider, changes the private revision or clears the active claim. Completed/unknown display repair clears its repair flag through revision CAS.
- Cron reports `inspected`, `attempted`, `published`, `pending`, `unknown`, `failed`; attempted rejected/unknown work returns503/`ok:false`. A429 retry wait is explicitly pending rather than published.

## Focused execution evidence

`tests/social-scheduled-publish.test.ts` has **58 passing cases**. It runs the actual root action, installed Supabase/PostgREST builders, new authority/worker, existing publish pipeline, real encrypted token loading and real X adapter. An in-memory database transport applies request filters/mutations and returns synthetic PostgREST HTTP; X HTTP and request auth are synthetic. This proves module/wire contracts and behavior under controlled races, not deployed PostgreSQL RLS or real X acceptance.

Covered cases include: due/future/no-cookie worker; ten accounts; simultaneous worker/manual CAS; fresh manual actor; original/current approval holds; required-read failure/recovery; role revocation; per-target and token-time membership rechecks; changed body/variant/link/time/account/provider; creator-field forgery; corrupted private bindings; expired/blocked/ambiguous tokens at enqueue and dispatch; direct forged claim; mixed429/400/confirmed targets; timeout/408/5xx/malformed responses; lost private arm and provider-write responses after commit; public result write repair with confirmed timestamps; aged held display repair without reposting; real installed-SDK held credential GET cancellation with one request and zero sends; durable cursor fairness; protected cron and honest failure counts.

Final focused command, tool output chunk `65aa54` (11:43:44,1.84seconds):

```text
node node_modules/vitest/vitest.mjs run tests/social-scheduled-publish.test.ts tests/social-publish-execution.test.ts tests/social-publish-persistence.test.ts tests/social-x-execution.test.ts --maxWorkers=2
Test Files 4 passed
Tests 171 passed
```

These are tool-output evidence; no separate raw log file was created. Final scoped ESLint was clean for the nine owned production/test files (tool output `40cd63`). Root owns authoritative combined strict TypeScript, browser suites, clean production build and aggregate logs. The earlier four discovery characterizations were retired; the implementation regressions replace their deliberately broken assertions.

## Source ownership and remaining limits

Owned production files: `lib/social/scheduled-authority.ts`, `lib/social/scheduled-publish.ts`, `lib/social/publish.ts`, `lib/social/account-tokens.ts`, `lib/social/connectors.ts`, `lib/social/providers/x.ts`, `lib/social/x-oauth.ts`, `app/api/cron/social-publish/route.ts`, `scripts/cron-dispatch.mjs`, `vercel.json`. Owned regression: `tests/social-scheduled-publish.test.ts`. Root owns action/UI/time/catalogue changes and existing fixture adjustments. API sibling reviewed worker accounting and mixed-rejection retry behavior independently; both findings were repaired and executed above.

Existing schema references were reviewed, not changed: migration0034 social schedules/calendar text statuses, publish tables/account/token schema; migration0250 private tool ledger, unique indexes and manager SELECT policy. The unregistered `social.scheduled_publish` name is not an AI executable tool; null run/step references prevent generic run dispatch. This isolation conclusion is source review, not a newly executed live SQL/RLS test.

Open boundaries remain explicit:

- **AUTHZ-003**: current client DELETE policy can remove a restrictive explicit social role, restoring household fallback. Live restricted-role publishing remains blocked pending authorized database hardening. This code does not claim to repair RLS.
- Existing provider setup, approved application access, current connected tokens and deployed cron secrets/cadence are environment-dependent. No live credentials or sends were requested or used. Existing environment names only: `CRON_SECRET`, `CRON_BASE_URL`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, `SYNC_TOKEN_KEY`, existing Supabase service/client configuration.
- Automatic X token refresh, other platforms/media, recurrence, editing/rescheduling/canceling existing schedules and independent approval capability remain separate work. Expired credentials require reconnect.
- A partial dispatch interrupted before later targets starts is conservatively held as unknown; it does not automatically resume unattempted targets. There is no user-facing operator tool to reconcile an ambiguous acceptance safely. Held rows can require manual operational review.
- Private confirmation repairs visible post/target/calendar state but does not fabricate missing historical `social_publish_results`, usage events or completed job rows after a pipeline persistence failure. Those historical artifacts may remain incomplete/failed; private provider proof remains authoritative for preventing resend.
- Multiple-table snapshots and live permission checks are not a cross-table database transaction. They recheck before every provider call and at token access; a concurrent revocation after the final check cannot cancel an already accepted external request. No new SQL transaction/locking guarantee is claimed.

## Pinned-suite cron fixture correction

Root's full pinned `f6e17ef` suite recorded1154passing files/13251passing tests and three failures in two existing cron fixtures. The failure log at `C:/Users/Daniel/AppData/Local/Temp/bubaly-capture-schedule-full-units-20260912.log` showed only stale expectations: the fixed five-minute tick now has five routes, and the Vercel-versus-dispatcher cadence list now includes `/api/cron/social-publish`.

The authorized follow-up updates `tests/cron-dispatch-execution.test.ts` and `tests/cron-dispatch.test.ts` only. The real child-process CLI still executes. Exact expected route identities include all four previous routes plus social publishing; the failed-tick check now asserts every attempted URL, not only a count. Existing authorization, invalid configuration, redirect, HTTP failure, redaction and cancellation coverage is retained. No production source changed.

```text
node node_modules/vitest/vitest.mjs run tests/cron-dispatch-execution.test.ts tests/cron-dispatch.test.ts tests/social-scheduled-publish.test.ts --maxWorkers=2
Test Files 3 passed
Tests 93 passed (35 cron +58 scheduling)
Duration 1.82s
```

Actual captured output: `C:/Users/Daniel/AppData/Local/Temp/bubaly-scheduling-cron-fixtures-20260912.log`. Root owns any final aggregate rerun and publication; this focused result does not replace the pinned full-suite record.
