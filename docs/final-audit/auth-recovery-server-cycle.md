# AUTH-003 server recovery boundary

Implemented after root recorded AUTH-003, against the `ea3d6e40` checkpoint plus coordinated auth work. Owned production path: `lib/auth/recovery-server.ts`; owned tests: `tests/auth-recovery-server.test.ts`. No other production paths, SQL, dependencies, environment templates, credentials, browser singleton or provider configuration were changed. Root owns cookie/action/UI orchestration and combined verification.

**82 focused tests pass using the actual installed Supabase SDK, synthetic provider transport and real locally generated ES256 signatures.** Scoped TypeScript checking of the two owned files reports zero diagnostics; scoped ESLint and `git diff --check` pass. This does not establish live email receipt, deployed Auth policy or the complete browser recovery flow.

## Implemented contract

The module exports `RecoveryError` with a safe `authRecovery.*` key, `RecoveryIdentity` (`userId`, `sessionId`, `email`, `expiresAt` in milliseconds), `RECOVERY_HANDOFF_COOKIE = 'bubaly-recovery-handoff'`, `prepareImplicitRecovery`, `createRecoveryGrant`, `verifyRecoveryGrant` and `updateRecoveryPassword`, matching root's agreed signatures.

- Every authority check uses the exact candidate token with SDK `getClaims(token)` and fresh `getUser(token)`. Required project issuer, authenticated audience/role, UUID subject/session, expiration, issued/not-before times, bounded email and recent `otp`/`recovery` AMR are checked. AMR freshness lasts 15 minutes; up to 30 seconds of positive clock skew is allowed. Token and AMR/grant expiry are checked again after the required user lookup.
- Recent OTP is deliberate compatibility with existing implicit admin links. It proves a verified recent bearer session, not a uniquely distinguishable recovery purpose. URL labels and SDK event/redirect hints never grant authority. The provider-source basis and distinction are retained in [auth-recovery-contract-review.md](auth-recovery-contract-review.md).
- Grants use a domain-separated SHA-256 HMAC with the existing server-only `SUPABASE_SERVICE_ROLE_KEY`. Values are trimmed/unquoted consistently with the repository's server factory. The signed version/purpose payload binds subject, session, method/authentication time, issuance/expiry and a random nonce. It contains no access/refresh token or email. Grant expiry is capped by the original AMR time and never renewed by refresh. Key rotation invalidates old grants. The public anon key authenticates provider HTTP; the service key is never sent to the provider by this module.
- Implicit preparation rejects an expired original access token, validates original evidence, performs exactly one isolated refresh, validates the returned token/user/pair against original subject/session/method/time, and returns the rotated pair plus grant. The explicit refresh POST avoids the SDK refresh retry loop. No session is installed, persisted, refreshed in the background or signed out by this helper.
- Password mutation validates the grant against exact token T and sends one fixed-provider PUT using T, with only the validated 8–72-character password. It never rereads cookies/storage, chooses a new session, refreshes, writes SDK session state, calls the admin API or retries. A matching returned user confirms `updated`; definitive 4xx rejection yields `failed`; transport failure, 408/5xx, redirect or malformed/mismatched success remains `uncertain`.
- Each exported operation has a 15-second HTTP/body budget and 65,536-byte response cap. Requests use the configured provider origin, bounded endpoint paths, manual redirects and no-store. Held bodies are cancelled. SDK fetch exceptions are converted to sanitized responses because Auth-js otherwise logs thrown transport errors. No token/provider diagnostic is logged or returned.

Safe error suffixes are `invalidLink`, `expiredLink`, `sessionChanged`, `temporarilyUnavailable`, `setupRequired`, `invalidPassword`, `passwordRejected`, `weakPassword`, `samePassword`, `mfaRequired`, `reauthenticationRequired`, `currentPasswordRequired`, `rateLimited`, and `saveUncertain`. Root owns all seven locale translations.

## Executed evidence

Tests were written before the module: the first run failed because its import did not exist. During implementation, three new expiry-during-read regressions failed before the post-read expiry checks were added. Two malformed provider-email cases also failed before explicit runtime string validation was added. These now pass normally; no expected-failure annotations remain.

The 82 cases cover real ES256 JWT signature validation/JWKS, forged signatures, the SDK's symmetric-token provider-verification fallback, malformed/missing/foreign claims, stale/future evidence, changed user/session, required read failures, HMAC tampering/purpose/expiry/key rotation, unchanged-session token rotation, expired original access, mismatched access/refresh identities, malformed/failed/held refresh, exact-token password mutation, provider MFA/current-password/reauthentication failures, confirmed and uncertain outcomes, malformed/oversized response bodies, and held JWKS/user/refresh/PUT/body deadlines. Transport fixtures assert the expected provider origin, anon authentication, manual redirects, no-store and absence of service-key transmission.

Executed with isolated Node 24.21.0:

```powershell
& 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0/node.exe' node_modules/vitest/vitest.mjs run tests/auth-recovery-server.test.ts --maxWorkers=1 --reporter=dot
& 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0/node.exe' node_modules/eslint/bin/eslint.js lib/auth/recovery-server.ts tests/auth-recovery-server.test.ts
git diff --check
```

Final focused log: `C:/Users/Daniel/AppData/Local/Temp/bubaly-auth-recovery-server-20260912.log` (82 passing cases). A scoped TypeScript API program reused repository compiler options with only the two owned roots, `noEmit:true` and `incremental:false`; it wrote no config/build artifacts. No full suite/build or live provider call ran in this lane.

## Scope limits

The module intentionally does not create, clear or install auth cookies, manage a browser form lifetime, consume grants globally, or preserve a user's UI through concurrent owner changes. Root's action/component layer must bind the HttpOnly grant and current cookie identity, reject failed explicit links without falling back to another session, install only the verified prepared pair, and retire/lock forms on confirmed or uncertain mutation. HMAC grants are replayable within their limited validity; a nonce is not a distributed single-use ledger. No exactly-once claim is made for separate concurrent requests/tabs.

Successful provider updates leave the session intact because this helper does not sign out. Provider-side revoked-session, MFA, reauthentication, password policy and current-password enforcement remain authoritative. A failed implicit refresh may have rotated the candidate before its response was lost; the helper reports failure and does not repeat it. Live SMTP/template/redirect settings and real recovery-link expiration/replay behavior remain unverified external dependencies.
