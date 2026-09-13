# AUTH-001 existing regression coverage

Read-only production/test review at source `910cd271bc273e68c286c3b10aaf1f27f6b933c2`, on 2026-09-12. This lane writes only this document. Source-flow findings belong to `auth-recovery-discovery.md`; no production, test, SQL, navigation or dependency changes were made.

**Executed result: 200/200 existing unit checks across 13 files and 34/34 existing synthetic Chromium checks across two files passed under isolated Node 24.21.0.** These totals include source-text assertions and supporting session tests. They do not establish a complete signup, email-confirmation or password-reset workflow pass. No live account, database, email or provider operation was performed.

## Executed unit inventory

| Existing file | Cases | Actual execution layer and limits |
| --- | ---: | --- |
| `tests/auth-review-selection-forms.test.ts` | 30 | Actual SignupForm, LoginForm, OAuthButtons and PhoneAuth handlers; custom mocked React hook slots, fake FormData/router and mocked SDK methods. Covers immediate signup, confirmation-required check-email state, redirect options, retry after returned provider errors, SMS verification and localized handoff. It does not mount the forms in a browser or execute signup/verification through the installed SDK. |
| `tests/auth-review-selection-routes.test.ts` | 35 | Actual callback GET, middleware and destination helpers with mocked code exchange, user lookup, membership queries and SSR client. Covers preserved safe destinations, returned exchange/read failures, role landings, cookie forwarding and unsafe/duplicate redirect rejection. Confirmation is represented by a synthetic code and mocked exchange success. |
| `tests/auth-callback-failed-signin-keeps-session.test.ts` | 8 | Actual callback GET with mocked auth/query responses. Covers spent/expired/cancelled/no-code cases, existing-session retention, transient lookup failure and definitive rejection. No real single-use code or PKCE verification. |
| `tests/auth-callback-boundary.test.ts` | 4 | Source-text assertions only. Does not execute the callback or cookie exchange. |
| `tests/auth-redirect.test.ts` | 12 | Executes the pure internal-redirect validator against valid, malformed and hostile destinations. |
| `tests/auth-otp.test.ts` | 6 | Executes pure OTP normalization/length, phone-format, countdown and error-copy helpers. Does not issue or validate a provider OTP. |
| `tests/oauth-code-not-a-logout.test.ts` | 9 | Executes pure OAuth-code routing and verifier-cookie recognition helpers. |
| `tests/middleware-oauth-code-routing.test.ts` | 5 | Executes actual middleware with a mocked SSR auth client; distinguishes unrelated codes from a sign-in with a verifier cookie. |
| `tests/referral-signup-capture.test.ts` | 11 | Two pure cases, five actual referral helper cases with the existing in-memory database/cookie jar, four source-wiring assertions. The “email confirmation in another browser” case only supplies referral metadata to the helper; it does not open a confirmation link. |
| `tests/persistent-login.test.ts` | 26 | Eleven pure session/error helper cases, five actual middleware cases with mocked SDK auth, ten source-wiring assertions for signout/client/session keeper. Supporting session coverage, not password recovery. |
| `tests/auth-refresh-persistence.test.ts` | 48 | Twenty-six executing refresh transport-wrapper cases, eighteen installed SDK browser/server/native persistence cases and four actual middleware/installed SDK refresh cases. All provider responses and storage are synthetic. Tests use existing sessions and refresh-token failures; no signup, confirmation or password-update request. |
| `tests/admin-auth-boundary.test.ts` | 2 | Source-text/admin-file-tree assertions only. A guard name appearing in the admin action file is not execution of the password-reset action. |
| `tests/admin-authz-gate.test.ts` | 4 | Source-text/admin-file-tree assertions only, including layout and marketing guard checks. No reset action or recipient/provider behavior is executed. |

The two JSON unit reports are stored outside the repository at `C:/Users/Daniel/AppData/Local/Temp/bubaly-auth-recovery-tests-20260912.json` (194 passed) and `C:/Users/Daniel/AppData/Local/Temp/bubaly-auth-recovery-admin-static-20260912.json` (six passed). No test was changed or skipped to obtain these results.

## Executed browser inventory

| Existing file | Cases | Actual execution layer and limits |
| --- | ---: | --- |
| `tests/e2e/auth-cache-partition.spec.ts` | 22 | Actual React, production browser-client factory, installed Supabase UMD/SSR client, AppProvider, durable auth store and offline query/cache code. Browser-context routes intercept every request with synthetic auth/database responses. Covers session/owner boundaries, delayed bootstrap and INITIAL_SESSION races, refresh preserving drafts, malformed tokens and restart isolation. It does not render SignupForm or handle an emailed confirmation/recovery link. |
| `tests/e2e/auth-lifecycle-boundary.spec.ts` | 12 | Actual React effects, SessionKeeper, signout form, cache and query hook. Auth/native clients and visual primitives are explicit mocks. Covers signout/owner transitions, asynchronous cleanup, stale query fencing and transient foreground reads. No recovery email or password form. |

Both ran in local Chromium without a Next server (`PLAYWRIGHT_EXTERNAL_SERVER=1`) and with all browser requests intercepted. The 34 cases passed in 11.7 seconds. Artifacts were directed to the unique Temp output directory shown below, not the private clean workspace.

Existing `tests/e2e/authenticated.spec.ts` was inspected but deliberately not executed: its setup creates an account through the admin API with `email_confirm: true`, then logs in, onboards and saves a task. Even when enabled, that journey bypasses signup email confirmation. `tests/e2e/concierge.spec.ts` likewise preconfirms its fixture. `authenticated-fixture-ownership.test.ts` checks synthetic setup/cleanup ownership, not signup/confirmation. Public/mobile page smoke tests check rendering and layout, not submission or recovery.

## Uncovered boundaries

1. **Password recovery has no executing regression in the searched repository tests.** Searches across `tests`, `mobile`, `shared` and `lib` found no test/runtime spec invoking `adminSendPasswordResetAction`, `resetPasswordForEmail`, a password-changing `updateUser`, `PASSWORD_RECOVERY`, or the mobile `reset=1` link. The sole source reset sender is `app/(app)/admin/actions.ts:446`, which sends to `/login`; `components/admin/user-security-actions.tsx:31` invokes it. The source-review lane is examining the missing recovery consumer and sender failure handling. The six passing admin checks above cannot verify either behavior.
2. **The visible mobile recovery entry has no destination behavior test.** `mobile/app/(auth)/sign-in.tsx:66` opens `/login?reset=1`; `components/auth/login-form.tsx` has no reset branch. Mobile credential/session tests cover sign-in validation or transient session restoration, not this link or password replacement. This source-backed gap was sent to the source-review lane.
3. **Signup-to-confirmation is tested as disconnected seams.** The form suite checks `emailRedirectTo` and no navigation when the mocked signup response has no session; separate handler tests accept mocked exchange success. No existing test ties the actual production browser SDK's signup/PKCE verifier storage to the actual callback/server cookie exchange and then an authenticated page. Provider one-use/expiry behavior, absent/wrong verifier, another-browser email opening and confirmation resend are not demonstrated by these suites.
4. **Signup failure and lifetime coverage is narrow.** Existing handler cases use valid fixed input and returned SDK errors. There is no discovered direct `signUpSchema` boundary matrix, real DOM invalid/weak-password submission, held signup transport, late result after unmount, simultaneous submits, or accepted signup with a lost response. This is a coverage finding, not a reproduced application defect.
5. **Operational mail behavior is unverified.** No test here establishes configured email templates/redirect allowlists, actual inbox receipt, safe recovery-code consumption, password replacement, expired/replayed recovery links, or the old/new credential behavior afterwards. Supporting refresh/session tests cannot substitute for those boundaries.

## Smallest useful next harness work

Use the existing actual-SDK browser harness pattern from `auth-cache-partition.spec.ts` for a real SignupForm and the eventual recovery form, with all `/auth/v1/*` requests intercepted. Preserve the actual SDK and production browser-client factory; assert PKCE storage, request parameters, cookie/session changes, visible failure/review states and absence of unintended second requests. Pair that with an actual callback handler fixture using the installed SSR client and a controlled cookie jar. This would test repository wiring without live users or email, while retaining an explicit limitation around the real auth server's code semantics.

For the existing admin reset sender, a bounded actual-action test should exercise denied authorization, invalid recipient, returned/thrown provider failures, confirmed request acceptance followed by an audit-log failure, and the real UserSecurityActions busy/error behavior. The current file-level gate assertions provide no such protection.

## Reproduction commands

```powershell
$env:PATH = 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0;' + $env:PATH
node node_modules/vitest/vitest.mjs run tests/auth-review-selection-forms.test.ts tests/auth-review-selection-routes.test.ts tests/auth-callback-failed-signin-keeps-session.test.ts tests/auth-callback-boundary.test.ts tests/auth-redirect.test.ts tests/auth-otp.test.ts tests/oauth-code-not-a-logout.test.ts tests/middleware-oauth-code-routing.test.ts tests/referral-signup-capture.test.ts tests/persistent-login.test.ts tests/auth-refresh-persistence.test.ts --reporter=json --outputFile=C:/Users/Daniel/AppData/Local/Temp/bubaly-auth-recovery-tests-20260912.json --maxWorkers=1
node node_modules/vitest/vitest.mjs run tests/admin-auth-boundary.test.ts tests/admin-authz-gate.test.ts --reporter=json --outputFile=C:/Users/Daniel/AppData/Local/Temp/bubaly-auth-recovery-admin-static-20260912.json --maxWorkers=1
$env:PLAYWRIGHT_EXTERNAL_SERVER = '1'
node node_modules/@playwright/test/cli.js test tests/e2e/auth-lifecycle-boundary.spec.ts tests/e2e/auth-cache-partition.spec.ts --project=chromium --workers=1 --reporter=line --output=C:/Users/Daniel/AppData/Local/Temp/bubaly-auth-recovery-browser-20260912
```
