# Pending signup and explicit logout

Date: 2026-09-19. Baseline: `dcbccaa1382aa8b712a358722d8a50724f3359fe`; focused verification used its auth source while integrating main `57f22c0b61e25afa471eb9e997e3480592a22248`. Related permanent records: AUTH-001 and AUTH-002. This is controlled browser evidence, not deployed provider verification.

## Reproduced defect

When no authenticated session existed, the browser snapshot ignored a pending PKCE verifier. Application logout consequently reported success but left the verifier in cookies. The per-request signup client compared session and verifier cookies without the logout generation, so an already dispatched signup could later install its returned session after that logout. A held actual SDK response reproduced this: application logout returned `signed-out`, then the returned synthetic user B was persisted.

Five new executing React/Chromium/installed-SDK cases failed before the repair. They covered late lost, confirmation-required and session-bearing signup responses; a stale empty logout intent; and refused verifier deletion. The previous raw SDK sign-out cases did not cover application logout because the SDK removes the verifier through a different path.

## Repair

Logout explicitly requests a snapshot that includes pending project auth cookies. Its existing comparison can now retire that exact verifier and reject an older intent when a newer handoff is present. Ordinary session snapshots still exclude verifier-only storage, preserving authenticated-session and cache semantics. Clearing an absent snapshot cannot silently accept pending auth cookies, and completion checks all selected project cookies were removed.

Signup ownership now includes the logout-generation cookie. A logout therefore retires an earlier signup even if cookie deletion was refused. Cleanup checks the full owned snapshot before deleting its verifier, preserving newer work. No prior cookie value is restored, no SDK dependency is modified, and neither ordinary refresh classification nor provider authentication is bypassed.

Further independent review reproduced a stale session-kind logout intent consuming a newer pending signup verifier beside an ambient session. Session-kind intent now includes the exact pending verifier cookies when they exist; absence remains optional for ordinary session intents. An old intent preserves the newer handoff, while a fresh logout retires both the current session and handoff and fences the held signup response. Ordinary session-token rotation without a pending handoff still completes logout. This adds three unit cases and two executing browser cases.

## Focused results

- Five new red cases pass after the repair in 2.3 seconds.
- The initial six-suite actual-browser run passed 136 checks in 10.9 seconds. After the additional session-intent repair, the final six-suite run passes **138/138 in 11.0 seconds**: signup boundaries, logout/refresh storage, browser sign-out flow, password ownership, browser persistence and child-login boundaries. Coverage includes chunked pending verifiers, default session-only snapshots, unrelated project cookies, newer handoffs and ordinary token rotation. Signup alone passes 53 checks.
- The earlier seven-suite unit run passed 150 checks, including child login, username matching, logout, cache ownership, retryable renewal and modal contracts. After the additional repair, logout and bridge suites pass **36/36 checks across two suites**. The frozen integrated source also passes **16,360/16,360 unit checks across 1,294 files**, with zero failed/skipped.
- Lint on all ten changed auth/merge/test paths passes without warnings; scoped whitespace checks pass.

The merge also retains exact username equality from main together with branch-specific `user_id` selection and token/user binding. The three blocking app gates retain guarded SignOutForm behavior and gain main's focus handling. The upstream structural username test was updated to expect the combined selected fields.

Logs are local: `Temp/bubaly-signup-logout-before-20260919.log`, `Temp/bubaly-signup-logout-after-20260919.log`, `Temp/bubaly-signup-logout-regression-20260919.log`, `Temp/bubaly-auth-merge-20260919.log` and `Temp/bubaly-auth-owned-lint-20260919.log`. Tests used Node 24, installed versions matching the lockfile, intercepted synthetic provider responses, and `PLAYWRIGHT_EXTERNAL_SERVER=1`. No application server or live provider operation ran. Vitest used `--cache=false`.

Final browser evidence is `Temp/bubaly-auth-verifier-final-20260919.log`; full UTC unit evidence is `Temp/bubaly-integration-units-final-20260919.json`. The pre-final-evidence frozen staged source is `4ac44596e1f91234ee9822b9ca2027d0fd62fdb2`. After a medication test-only timezone correction, the full DST-zone run passes 16,361/16,361 across 1,294 files; corrected medication tests also pass 16/16 in UTC. Application source remained unchanged after the passing build and strict type check. Completed local gates and pending integrated hosted verification are recorded in [the integration cycle](main-integration-cycle-20260919.md); these focused passes do not close AUTH-001 or AUTH-002.

## Remaining boundaries

These were the remaining boundaries at this cycle's frozen source. The subsequent
[refresh-preservation cycle](auth-pkce-refresh-preservation-cycle.md) repairs and
tests ordinary browser/server/middleware verifier loss. Delayed callback ownership
and hosted authentication remain open; the reproductions below remain historical
evidence for the defect that motivated that repair.

Ordinary successful singleton refresh still consumes a pending signup verifier through the installed SDK's `_saveSession`. The existing known-limitation test reproduces this separately; the current repair does not claim to fix it. A safe continuation must distinguish refresh cleanup from explicit logout and matched code-exchange consumption without using a sticky last-request flag or restoring retired verifier bytes. Hosted confirmation delivery, cross-device recovery, project session settings and the final full regression remain open.

The same issue was independently executed with the installed SSR client: one synthetic successful refresh retained user A but emitted both a session-cookie write and a deletion of the pending verifier cookie. `Temp/bubaly-ssr-pkce-refresh-probe-20260919.log` records `hadVerifier: true`, `hasVerifierAfter: false`, `userRetained: true` and the exact cookie-name-only writes. No provider or server process ran. Middleware and generic server clients use this SDK cookie contract, so a browser-only deletion filter would not complete the repair.

A coherent follow-up needs attempt-owned PKCE handoff state isolated from ordinary session refresh, plus explicit consumption by the matching exchange and retirement by logout. It must cover browser creation, middleware/server renewal, ordinary and recovery callbacks, and browser ownership when a delayed callback completes after logout or a newer handoff. A direct SSR Set-Cookie response cannot compare the current browser's newer state. No such redesign was applied during this merge gate; this workflow remains unresolved and is not PASS.
