# Password recovery UI execution cycle

This bounded lane implements the rendered portion of `AUTH-003`, following the recorded server/callback contract. Related signup repairs remain under `AUTH-001` in `signup-boundaries-cycle.md`. Neither item is a declaration that the complete hosted authentication workflow passes.

## Source and authority boundaries

`components/auth/recovery-form.tsx` handles `/auth/recovery`, the `/login?reset=1` email-request entry, and legacy recovery fragments routed through `components/auth/login-form.tsx`. The new page is `app/(auth)/auth/recovery/page.tsx`. Global navigation, the production browser singleton, SDK dependencies, SQL, and provider configuration are unchanged.

The form captures and removes fragment credentials before constructing the production client. Explicit errors, malformed links, duplicate token fields, query-string tokens, and malformed handoffs cannot fall back to a remembered grant or an existing signed-in session. Preparation, handoff consumption, grant inspection, and password updates delegate to root-owned server actions. Local JWT decoding only compares observed session identity; it does not authorize recovery. The server verifies that authority independently.

Only the signed grant is retained in session storage. Passwords and link token pairs are not stored there. The server grant is a bounded, reusable capability, not a one-time token. A successfully consumed handoff is removed from the URL after grant retention, preserving unrelated query parameters. Reload then inspects the retained grant instead of retrying the shorter-lived callback bridge. Explicit link errors still refuse fallback.

Each opening has a synchronous phase and lifetime guard. Password validation and definitive failures preserve the draft; a dispatched update with a lost, timed-out, or uncertain result removes local grant retention and offers sign-in without a repeat submit. Account changes retire old callbacks and suppress late completion. Same-session token rotation preserves the draft. Grant removal compares the current stored value, so an older completion cannot delete a newer grant. Success and uncertainty clear the former expiry timer.

Implicit-token installation uses a separate, non-singleton SSR browser client with automatic refresh and URL detection disabled. Its actual cookie writes check mounted scope, auth revision, phase, and the captured current-cookie fingerprint. The real SSR adapter handles durable cookie attributes and chunking. The installer skips automatic initialization and presents an empty cookie view while its actual initial-session subscribers settle; only then does guarded explicit `setSession` receive the real cookie view. The instance is disposed in `finally`. These controls matter because disposing the installed SDK does not abort an in-flight user lookup or prevent its later storage write by itself.

The self-service request calls the actual SDK `resetPasswordForEmail` with a normalized email and `/auth/callback?next=/auth/recovery` redirect. It uses a synchronous duplicate guard and generic, non-enumerating success copy. Definitive rejection preserves deliberate retry; lost or timed-out acknowledgement reports uncertainty and suppresses repeat within that opening. No automatic resend or sign-out was introduced. All SDK factories execute within contained error handling. UI waits have a 35-second bound, exceeding the server action's documented maximum two-stage 30-second budget.

## Actual browser evidence and limits

`tests/e2e/auth-recovery-ui.spec.ts` executes real React, RecoveryForm, LoginForm, shared controls, LocaleProvider and catalogue, the production browser factory, installed Supabase SDK, and installed SSR cookie adapter in Chromium. All traffic uses intercepted `.invalid` origins. Request-boundary server-action fixtures return the real discriminated result shapes, UUID identities, bounded expiry values, and synthetic session receipts; they do not replace locale objects with strings or mock SDK session methods. They do not execute the server verifier or callback handler. Those have independent action/SDK suites owned by root and the API lane.

The final matrix has **33 passing Chromium cases in 3.9 seconds**, including the strengthened actual refresh control in the final complete focused run. It covers:

- Implicit credentials stripped before factory construction; validated session installation; only the signed grant retained; handoff consumption, remount, and an actual page reload after six minutes.
- Explicit malformed/error inputs, rejected preparation/inspection, and existing-session-only inputs denied without fallback.
- Same-turn and retained duplicate password submits; confirmation mismatch without a write; definitive rejection with preserved input and deliberate retry; uncertain/lost/timed-out save acknowledgement without repeat or late false success.
- Held preparation after unmount; held actual SDK `/user` installation after unmount, after a newer sign-in, and beyond the deadline, each preserving the newer or existing account's durable cookies.
- Ready and pending-save account changes; actual `refreshSession`/`TOKEN_REFRESHED` with unchanged session ID; compare-current-grant cleanup; Strict Mode preparation deduplication; success surviving its former expiry timer.
- Installer bootstrap observing no ambient session, a session entering the SDK refresh margin during preparation, disposal, and no subsequent installer activity. Only the refresh-margin case explicitly pauses the unchanged singleton's timer in the fixture to attribute traffic to the temporary installer; the installer itself remains real.
- Self-service email normalization, actual SDK PKCE request, correct callback target, duplicate submission, retained callback after success, lost response, invalid email, definitive rejection and deliberate retry; ordinary login link and legacy fragment entry; French account and success copy from the real catalogue.

These checks prove the controlled browser behavior described above. They do not prove SMTP delivery, deployed redirect allowlists, hosted password policy, real callback exchange, real signed-grant verification, live RLS, cross-device recovery, or native WebView behavior. A form-local uncertainty lock is not a durable transaction journal across a full browser restart. Signup's independently characterized lost-response PKCE-verifier deletion remains unresolved; this recovery UI does not restore that verifier or declare confirmation recovery complete.

## Findings during implementation

The initial 23 browser checks passed after root identified the need to guard actual SDK cookie writes, clear terminal-state expiry timers, and compare stored-grant cleanup. These were implementation review findings; this lane does not invent a pre-repair browser run for them.

A new constructor isolation assertion then failed: the actual temporary client made three ambient-cookie reads before its held recovery user lookup completed. Setting `skipAutoInitialize` alone reduced that to one read and still failed. Installed `SupabaseClient` automatically subscribes to auth events; its initial callback invokes the SDK's session loader independently of automatic refresh. The final empty bootstrap view plus skipped initialization prevents ambient session exposure to both initial subscriptions. The observation records empty reads, no cookie writes before installation, and no refresh request in the refresh-margin control. It does not claim a normal valid ambient cookie was actually deleted in the initial red run.

The subsequent 32-case run passed. Root then identified the five-minute callback bridge versus fifteen-minute retained grant mismatch. After adding URL cleanup and a true reload case, that new case failed with “The account changed”: fresh singleton initialization emitted an agreeing `SIGNED_IN` event during `getSession`. Remount-only coverage had missed this. Bootstrap now reconciles the read against the latest observed identity; a disagreeing read still retires. All 33 cases passed after this repair. The token-rotation control was then strengthened to call actual SDK `refreshSession`, rather than a second same-ID sign-in, and passed separately.

Root's intermediate strict typecheck also found two in-progress TypeScript issues: an insufficiently discriminated entry union and an unknown prepared-session result. The final code uses separate entry alternatives and explicit session-shape validation, with no suppression. Root owns the final integrated strict typecheck and build.

## Adjacent validation and provenance

After LoginForm imported the recovery flow, the existing auth-selection fixture received an explicit RecoveryForm boundary. Its 30 original signup/login/OAuth/phone/selection/locale cases remain intact. The signup actual-browser fixture continued to pass all 21 cases. The focused Vitest run passed **85 tests in two files**: 30 auth-selection cases and 55 catalogue integrity checks. Seven-file scoped ESLint passed with zero warnings, and scoped diff whitespace checks passed. No full suite, build, private-clean source, account, SMTP operation, dependency installation, commit, or push was performed by this lane.

All seven base catalogues preserve their 13,517 prior entries, values, and order. There are 39 appended entries: root's six earlier auth keys, this lane's 32 recovery keys, and the requested `sms.draftsOnly` copy. Recovery placeholders match, and German, French, and Portuguese copy uses formal address. Root independently verified that prefix and count; the real catalogue integrity suite and French rendered case supply additional checks.

Execution used Node 24.19.0, within the supported Node 24 engine, and installed Chromium. Root owns the pinned Node 24.21.0 combined gate. The final source fingerprints are recorded below; these are working-tree files on top of the separately committed SMS checkpoint `f51bcd40`, not a new committed release claim.

| File | SHA-256 |
|---|---|
| `components/auth/recovery-form.tsx` | `9eac8036027702b1739daebf2019e45de88a4f240beba757c533ebfd930ccf2d` |
| `components/auth/login-form.tsx` | `f39c35ef96b2dd423aa0cd20b686f9946a3f0e893e9e70c84349b922be453611` |
| `app/(auth)/auth/recovery/page.tsx` | `367aed2dbb871a87f6f4d25664b5ae2790e8965b4aa16cdbd19e4d8074daeb66` |
| `tests/e2e/auth-recovery-ui.spec.ts` | `6eff81d89b4ced96f06ba9f5d0575313a4742e36517acf201674fbdbc7f52c6d` |
| `tests/auth-review-selection-forms.test.ts` | `0944bf5fd3ca6a91ab766b81ca08cc635ccbb73932cb65160358278c12c4cb3d` |
| unchanged `lib/supabase/client.ts` | `de4169506c349bff441856947f509b7d3ed829576ec9bbf11d39e6cd2c779085` |

Run only this fixture with `PLAYWRIGHT_EXTERNAL_SERVER=1`, Node 24, and `node_modules/@playwright/test/cli.js test tests/e2e/auth-recovery-ui.spec.ts --project=chromium --workers=4 --timeout=15000`. No local application server is needed because every request is intercepted.
