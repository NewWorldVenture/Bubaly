# Pending PKCE preservation and recovery logout ownership

2026-09-19. Baseline: `43df0881fa7d7fa41a9be68a01c35549db43a63b`.
Permanent records AUTH-001, AUTH-002 and AUTH-003 remain **IN PROGRESS**. This follow-up
repairs the ordinary-refresh loss reproduced during the integration cycle; it
does not complete the broader callback ownership design or hosted auth workflow.
Full verification uses pre-final-evidence staged tree
`543f3a1b58612fc17704020f4397bf68828ffaf1` in a private source copy.
Both full unit runs, build, final strict types, lint, localization and query gates
pass. The first strict run found twelve query-adapter type errors. The voicemail route's
adapter now retains its actual table schema through query inference, with no
`any` or suppression. This is the sole application-source difference after the
freeze: emitted ES2022 JavaScript matches the frozen route byte for byte after
comments are removed (SHA-256
`948cae3be08a92797851f519071e1beefb4a5188533cde40abddf9c87c534f34`).
Subsequent fixture-only corrections are identified below.

## Executed failures and bounded repair

The installed SDK removes its standard PKCE verifier when it saves an ordinarily
refreshed session. Four new browser cases failed before the repair: pending
confirmation-required signup, a signup with a lost response, OAuth initiation,
and self-service recovery. The pending verifier became null even though the
existing user stayed signed in. Log: `Temp/bubaly-pkce-refresh-red-20260919.log`.

The new server regression imports the real application `createServer()` and
middleware, the installed SSR/auth SDKs, and `NextRequest`. Only Next's request
cookie context and exact-origin synthetic provider responses are supplied by
the fixture. All eight verifier-preservation cases failed before the repair;
both no-pending-session controls passed. These cases cover ordinary and chunked
signup/recovery verifiers, including the recovery purpose suffix. The existing
session identity and token rotation passed before the repair, isolating the loss
to the pending handoff. Log: `Temp/bubaly-ssr-pkce-before-20260919.log`.

Ordinary shared browser, server and middleware clients now decline SDK
deletion-only writes for the configured project's verifier and numeric chunks.
They still propagate session rotation and session-chunk cleanup. A new verifier
replacement can remove old chunks in the same batch; unrelated project and
application cookies retain their existing behavior. Explicit application logout
and isolated callback exchange retain their separate retirement rules. No cookie
bytes are restored, no SDK internals are patched, and no sticky transport flag
is used to guess why a storage operation occurred.

The browser singleton no longer automatically exchanges URL codes. Explicit
callback handlers own that operation. All exact `/auth/callback` requests now
bypass middleware's ambient refresh, alongside the existing recovery paths.
Four desired ordinary-callback neutrality cases failed before that change;
13 recovery/adjacent-path controls passed. Log:
`Temp/bubaly-callback-neutral-before-20260919.log`.

Ordinary callback exchanges use the isolated cookie-exchange factory already
used by recovery: ambient session values are hidden from initialization, and
cookie changes are staged. A failed exchange does not publish verifier cleanup.
The successful response still publishes staged cookies, which retains the
separate delayed-response ownership limitation described below.

Executing the actual callback route through the installed SDK also caught an
intermediate implementation publishing staged session cookies after a definitive
user-lookup rejection. Two desired checks failed, then passed after the callback
returned without applying those cookies. This was found during this repair; it
is not recorded as an independently reproduced defect on baseline `43df0881`.
Ordinary callback redirects now carry `Cache-Control: private, no-store` and
`Referrer-Policy: no-referrer`.

Further actual-source/installed-SDK review exposed overlapping staged session
cookies when a near-expiry chunked exchange session refreshed into a smaller
session. The new desired case failed with six leftover chunks. The isolated
cookie view now tracks staged names, values and deletions while initially hiding
ambient session values. Subsequent SDK cleanup sees the current private jar and
retires obsolete chunks before publication. The expanded 226-check run below
supersedes the earlier 150-check callback snapshot.

## Recovery result after explicit logout

Four actual-browser cases then reproduced a separate recovery-form ownership
gap: held implicit-recovery preparation or installed-SDK user lookup could install
session A after application logout. Each operation was tested with an initially
empty session slot and an existing session B whose physical cookie deletion was
refused. The session bytes stayed unchanged while real browser logout advanced
its generation; the old form compared those bytes without the generation and
incorrectly adopted A. All four desired cases failed before the repair. Log:
`Temp/bubaly-recovery-generation-red-20260919.log`.

The form now snapshots only the configured project's session/user/verifier cookies
and its logout generation. Advancing the generation retires the held recovery
result even if session deletion fails. An unrelated project's auth-cookie change
does not retire the current operation. The installed-SDK result still supplies
authentication authority; this adds the missing browser ownership boundary.

## Focused evidence

- **141/141 actual Chromium checks across six auth suites pass**, in 11.3 seconds.
  Signup boundaries contribute 56 checks. Confirmation-required and lost-response
  signup cases preserve their exact verifier across singleton refresh and then
  complete a matching isolated installed-SDK exchange. OAuth and recovery retain
  their exact verifier until explicit application logout. The five related suites
  preserve logout, password ownership, persistence and child-login coverage.
  Log: `Temp/bubaly-pkce-refresh-green-20260919.log`.
- Recovery UI initially passed 33/33 after automatic singleton URL exchange was
  disabled. After the explicit-logout ownership repair it passes **38/38** in
  4.3 seconds: the prior 33, four new logout races and the unrelated-project
  positive control. Combined with the separate 141-check run, seven browser
  suites contain 179 passing checks; this is not a single combined execution.
  Logs: `Temp/bubaly-pkce-recovery-ui-20260919.log` (initial 33) and
  `Temp/bubaly-recovery-generation-green-20260919.log` (latest 38).
- **88/88 checks across nine server/middleware suites pass**, in 1.25 seconds.
  The new real-SDK cases verify the refreshed session's user/session identity,
  token rotation, and matching request/response cookies. Middleware's forwarded
  request receives the same refreshed session and unchanged pending verifier;
  neither server nor response publishes verifier deletion. Two no-pending
  controls still refresh normally. Five helper controls exercise mixed cookie
  batches, exact project boundaries and verifier chunk replacement. Callback
  neutrality and adjacent-route controls pass alongside existing API middleware
  boundaries. Log: `Temp/bubaly-ssr-pkce-fixed-20260919.log`.
- **226/226 checks across eleven callback/auth suites pass** in 1.24 seconds in
  the private verification snapshot, including 75 recovery-cookie checks.
  Twelve new actual-route/installed-SDK callback cases
  cover absent ambient refresh, old session-chunk cleanup, role destinations,
  failed-exchange preservation of the existing session and verifier, transient
  user lookup, refusal to publish a definitively rejected candidate, and cleanup
  when a staged chunked session refreshes into an unchunked session.
  Existing mocked routing fixtures now target the isolated factory seam.
  Log: `Temp/bubaly-pkce-callback-final-20260919.log`. This is a separate focused
  run; overlapping suite counts are not added into one acceptance total.
- Scoped lint and whitespace checks pass for the three owned server/middleware
  test files and the signup browser test.

Tests use Node 24.21.0, private installed dependencies, synthetic credentials and
intercepted provider responses. Vitest runs use `--cache=false`. No application
server, real provider operation, SQL or dependency installation is involved.

## Current full local gates

| Gate | Evidence |
|---|---|
| Full unit suite, UTC | PASS: 16,417/16,417 checks across 1,298 files, zero failed/skipped; `Temp/bubaly-pkce-full-utc-20260919.json` |
| Full unit suite, DST-observing timezone | PASS: 16,417/16,417 checks across 1,298 files, zero failed/skipped; `Temp/bubaly-pkce-full-dst-20260919.json` |
| Production build | PASS: 251 pages; `Temp/bubaly-pkce-build-20260919.log` |
| Strict post-build types | PASS, exit 0: `Temp/bubaly-pkce-types-final-20260919.log`. The initial twelve adapter errors were corrected by type-only schema narrowing; emitted runtime is unchanged |
| Lint | PASS with three existing warnings: document-capture generation ref and two messages-module toastError dependencies |
| Localization and query audits | PASS: 491 tables, 86 functions, 146 routes |
| Changes after full suites | Two SMS fixture setups, finance real-import fixture and its module-graph guard changed. Final graph guard passes 8/8; finance passes 14/14, including the four hosted failures. The only application-source delta is the byte-equivalent voicemail typing correction, with focused 62/62 checks and scoped lint passing |
| Final hosted discovery | 1,086 tests across 47 files discovered; discovery does not prove hosted execution |
| New hosted acceptance | Required after publication; pending |

## Remaining boundaries

This bounded repair preserves the existing standard verifier; it does not create
the attempt-owned handoff records proposed in
[the ownership design](auth-pkce-handoff-next-cycle.md). A direct callback
`Set-Cookie` response still cannot compare browser state changed after its request
began. A delayed successful ordinary or recovery exchange can therefore race
logout, a newer session or a newer handoff. Those flows need guarded browser
adoption and matching attempt consumption before the full callback workflow can
pass. Ordinary failed-link fallback also still calls a publishing `createServer()`
client: middleware neutrality alone does not establish handler-wide neutrality.

Actual confirmation delivery, expired/replayed links, cross-device recovery,
provider redirect policy, deployed session settings and physical-device reopening
remain separate obligations. The earlier integration's full gates belong to its
named source; they do not establish this follow-up. The current local gates above
do not close complete feature or hosted acceptance.

## Hosted baseline evidence

Published baseline `43df0881` completed hosted CI run `35462526440` with a failed
browser gate: **1,072 passed, six failed, 1,078 scheduled**. Four finance tests
could not mount because their fixture graph omitted `@/lib/supabase/errors`;
two SMS fixtures attempted to demote the only parent, which the integrated
last-manager guard correctly refuses. These fixture defects require repair and a
new hosted run; they are not waived as a passing gate. The new SMS ingress fixture
passed. Log: `Temp/bubaly-e2e-35462526440.log`.

The two SMS fixtures now first assert the sole-manager demotion is rejected with
23514, then create a second owned account with verified parent membership before
demoting the original member. Existing receipt/RLS/recovery assertions remain.
Both corrected tests are discovered, and scoped lint/whitespace pass; actual
hosted PostgREST execution remains pending. These are test-only corrections after
the `543f3a1b` application freeze. Discovery log:
`Temp/bubaly-sms-fixture-discovery-20260919.log`.

The finance fixture now includes the actual missing source imports, with its
module-graph guard updated to check the exercised graph. All 14 finance browser
checks pass, including the four previously failing hosted cases; the guard passes
8/8. These also are test-only corrections after the frozen full unit runs. A new
hosted run is still required for the corrected fixtures and current application.
The focused fixture checks used the prior private integrated-verification
workspace, separately from the PKCE full-gate copy. Logs:
`Temp/bubaly-finance-four-20260919.log` (4/4),
`Temp/bubaly-finance-focused-20260919.log` (14/14) and
`Temp/bubaly-finance-graph-20260919.log` (8/8).

The baseline's Web, Database, Mobile and Finance jobs passed. Web ran
16,361/16,361 units in both UTC and the DST-observing zone across 1,294 files,
built 251 pages and passed strict types. Database replay applied 330 migrations,
passed 38/38 boundary probes and reapplied 327 existing-schema migrations without
failure. The checkout was CI merge `29f575be6fcaa52fcd20528c1aaf4c1892fd8417`,
whose tree `111773257287e76f2544c2d33ac067864c03fb2a` equals the published
`43df0881` tree. None of those baseline jobs verifies the new PKCE/recovery or
voicemail application changes in this follow-up.
