# Guarded browser adoption for authentication callbacks

2026-09-19. Baseline: `4ccc57fc884306f0482d8566a05508e461cb33a8`.
Claimed records: **AUTH-001, AUTH-002 and AUTH-003 — IN PROGRESS**.
This cycle passes focused execution, independent review and all required local
gates. New-source hosted execution remains pending. No complete workflow is
passed, and production readiness remains **NO**.

Publication follow-up: exact `dc99dc83` subsequently passes CI `35464679043` and
Finance `35464679048`, including 1,150/1,150 hosted browser cases and both
16,495-check full unit runs. Source/tree provenance and logs are recorded in
[the next admission cycle](auth-callback-admission-witness-cycle.md#published-baseline-ci).
This resolves this cycle's hosted-gate wait, without passing the broader audit.

The previous [PKCE/recovery cycle](auth-pkce-refresh-preservation-cycle.md) retains
pending verifiers during ordinary renewal and fences delayed recovery-form work
after explicit logout. Its callback still publishes staged session cookies in a
server response. That response cannot compare browser state changed while the
request was in flight. Source review also identifies the publishing ambient
client in failed/no-code callback fallback. Eight desired admission checks failed
against that baseline. A separate installed-SDK test held the final refresh
cookie write after the SDK's stale-session check, installed a newer login without
logging out, and then reproduced the stale overwrite. Holding only the HTTP
response already passed because of the SDK's own guard; it is not counted as a
new defect.

## Current ownership contract

Callback admission redirects to a completion page without authentication
cookie writes or ambient session refresh. The browser captures the configured
project's verifier, logout generation and starting session ownership before an
isolated action exchanges the code. That action returns verified token,
destination and optional recovery-grant data without publishing auth cookies.
The browser checks ownership again during actual session writes and consumes
only the matching verifier after confirmed adoption.

The review covers same-user/session token rotation, failed-link session
fallback, safe destinations, selected plan, admin/guest/onboarding routing,
legacy verifier cookies and implicit administrator recovery. Provider evidence
remains authentication authority; local session identity is only an ownership
check. A fallback session cannot authorize password recovery.

Exercised interleavings include logout, a newer session, a newer verifier, unmount,
deadline, duplicate completion, refused cookie deletion and partial writes.
Admission itself also needs review: a held callback redirect arriving after
logout but before the completion page mounts can otherwise capture the newer
generation beside an undeletable old verifier. Action-time ownership alone does
not establish that earlier boundary. Attempt-owned initiation records remain a
separate design obligation until explicitly implemented and tested.

The action validates the exact verifier fingerprint before constructing its
isolated SDK client, hides ambient session cookies, bounds provider headers/body
and routing work, and checks refreshed token user/session continuity. Its receipt
contains no cookie publication method. Recovery receipts bind their signed grant
to the session identity; the UI checks receipt shape and recovery mode before
adoption. Browser adoption checks ownership at the actual writes, reads them back
and consumes only the captured verifier. A newer recovery grant also retires
adoption. Optional visitor attribution cannot block an adopted login or reset a
different visitor. Failed/no-code ordinary fallback uses guarded browser renewal;
it never grants password recovery authority.

Independent review caught and corrected an early completion-path redirect loop,
private refresh continuity missing `session_id`, lost visitor-fork signaling, and
recovery-grant ownership/receipt checks that had initially occurred too late.
Direct completion admission initially serialized unadmitted token query values
in its client element key; an executing page test reproduced that intermediate
failure. The page now admits only its code/destination contract, and the browser
replaces history with an explicit allowlist before asynchronous completion.
These were intermediate implementation findings, not additional reproduced
defects on the published baseline.

## Evidence status

- Desired old-admission failures: **8/8 RED** in
  `Temp/bubaly-callback-admission-before-20260919.log`.
- Installed-SDK final-refresh-write ownership: **1 desired RED**, then repaired,
  in `Temp/bubaly-callback-refresh-red-20260919.log`.
- Callback/action/cookie/middleware/routing gate: **319/319 PASS across 12 files**
  in `Temp/bubaly-callback-combined-final-20260919.log`. Four later attribution
  tests bring the actual-SDK callback suite from 35 to **39/39 PASS** in
  `Temp/bubaly-callback-attribution-final-20260919.log`; these numbers overlap.
- Browser helper/auth matrix: **165/165 PASS** in
  `Temp/bubaly-callback-browser-green-20260919.log`; the final cleanup refinement
  passes **78/78** affected tests in `Temp/bubaly-callback-browser-final-20260919.log`.
  Six additional fallback/partial-write controls pass separately in
  `Temp/bubaly-callback-fallback-20260919.log`. There are 171 distinct cases across
  those six suites, not one reported 171-test run.
- Actual completion UI plus recovery UI: **60/60 PASS** (22 + 38) in
  `Temp/bubaly-callback-recovery-ui-final-20260919.log`. Eleven further malformed
  recovery receipt/no-code fallback cases pass in
  `Temp/bubaly-callback-ui-receipt-20260919.log`; final UI evidence follows below.
- Direct completion page: **29/29 PASS** in
  `Temp/bubaly-callback-page-green-20260919.log`, following one desired failure
  among 24 earlier cases in `Temp/bubaly-callback-page-red-20260919.log`.
  An additional actual UI history-allowlist case passes in
  `Temp/bubaly-callback-history-green-20260919.log`; no browser RED is claimed
  because the source correction preceded that test's first execution.
- Guest/admin/plan routing and portal compatibility: **67/67 PASS across three
  files** in `Temp/bubaly-callback-routing-grandparent-20260919.log`, including
  the 44 routing cases already inside the combined 319 gate. Scoped lint and
  whitespace checks pass.
- Independent transport/schema/authority review: bounded findings above repaired;
  initiation ownership and complete deployed workflows remain open.
- Final actual completion UI: **34/34 PASS**, superseding its prior 22/33-case
  runs, in `Temp/bubaly-callback-ui-final-20260919.log`. The integrated browser
  run passes **133/133** (33 completion, 38 recovery, 62 password cases) in
  `Temp/bubaly-callback-integrated-browser-20260919.log`; the additional history
  case is included in the later 34-case UI run. Do not sum overlapping runs.
- Frozen application source: `2af81377bad3f91849d6edac7823b2cf352ba4c3`.
  Final test-only tree: `8966b9747f61acb3be181a1f6042142fc1920013`; every production
  blob is unchanged from that application freeze.
- Final build: **252 pages PASS**. Optional marketing reads in the synthetic
  provider environment reported timeout diagnostics; this is a successful build,
  not live-provider workflow evidence. Full lint passes with the same three
  existing warnings. Strict post-build types pass in
  `Temp/bubaly-callback-types-final-20260919.log`. Localization passes; query
  audit passes **491 tables / 86 functions / 146 routes**. Build/lint evidence:
  `Temp/bubaly-callback-{build,lint}-final-20260919.log`.
- Discovery: **1,150 tests across 48 files**. Discovery is not hosted execution.
- The first full UTC attempt passed 16,449/16,451. One new bounded transport
  helper was absent from the static fetch guard, and one SMS suite's cold import
  exceeded five seconds. The guard now recognizes the precise AST contract with
  adversarial mutation controls; application source and SMS tests did not change.
  Private focused guard/transport/SMS retest passes **49/49** in
  `Temp/bubaly-callback-guard-sms-private-20260919.log`; standalone SMS passes
  **31/31** in `Temp/bubaly-callback-sms-isolated-20260919.log`.
- Final full UTC and DST: **16,495/16,495 PASS across 1,301 files in each run**,
  zero failures or skips. Reports and logs:
  `Temp/bubaly-callback-full-{utc,dst}-final-20260919.{json,log}`. These final runs
  include the test-only guard corrections and supersede the incomplete first
  run. New-source hosted execution remains pending.

`Temp/` means `C:/Users/Daniel/AppData/Local/Temp/`. Synthetic installed-SDK,
React/Chromium and disposable hosted fixtures are distinct from live provider
configuration or real recipient delivery. Do not sum overlapping run totals.

## Permanent discovery accounting

[The compact inventory](discovery/auth-callback-browser-inventory.json) pins
35 changed files (21 production and 14 test files), including ten new files, to
the final test tree. It records the completion route/action/component, callback
libraries and exported helpers, two rendered controls and new test sources.
Twenty-one newly discovered structural obligations are added as NOT STARTED;
the prior 13,985 IDs and statuses remain intact. The master therefore contains
14,006 records: 13,817 NOT STARTED, 186 IN PROGRESS and three FAIL, with no PASS,
FIXED + PASS or BLOCKED records. Its 0.00% measures fully verified audit records,
not product-development completion.

The retired `createRecoveryCookieExchange` alias retains SERVICE-86704CB6F260.
`createPkceCookieExchange` already existed on the baseline but lacked an
individual service record; its newly discovered ID is SERVICE-53E5EBACB86B.
Neither the archived generated registry nor preserved upstream audit narrative
is regenerated or overwritten.

## Published baseline CI

Hosted runs `35463644948` (CI) and `35463644960` (Finance) target exactly
`4ccc57fc884306f0482d8566a05508e461cb33a8`; both are terminal **SUCCESS**.
CI checks out merge `52f5c9a3de22e087351b27f4d6dd72565c276227`, whose parents are
main `57f22c0b` and head `4ccc57fc`. Its tree
`7c39fb76557f3df5111286c704b949a81ea997d0` equals the published head tree.

- Browser acceptance: **1,086/1,086 PASS**, six minutes, with authenticated and
  durable-session flags both `1`. The six older fixture failures are absent.
- Web: UTC and DST each **16,418/16,418 PASS across 1,298 files**, 251-page build
  and strict post-build types pass.
- Database: **330 migrations, 38/38 boundary probes and 327 existing-schema
  reapplications** pass. Mobile passes.
- Finance: **66 explicit `0274 PASS` notices**, including the independent-session
  concurrency/retry checks.

Evidence: `Temp/bubaly-{e2e,web,database}-35463644948.log` and
`Temp/bubaly-finance-35463644960.log`. These checks concern the published baseline;
they do not cover the new callback ownership source or verify real provider
delivery, production policies or the remaining audit obligations.
