# Auth persistence audit and repair cycle

Audit source: c7b56eff plus the current uncommitted final-audit changes, 2026-09-12. Owner main was independently inspected at 5c60d05d; the three new OAuth merges do not change the browser client, server client, SessionKeeper or shared refresh adapter inspected here. No live credentials, provider requests, SQL, native device writes or dependencies were used. Root owns the combined release gate.

## Proven local behavior

The browser has explicit persistent sessions, automatic refresh, PKCE URL completion and a page singleton in `lib/supabase/client.ts`. `lib/auth/session.ts:13` gives cookies a 400-day lifetime, path `/`, SameSite Lax and Secure on HTTPS. The request-scoped server client in `lib/supabase/server.ts` reads/writes the request cookie store; middleware also propagates rotated cookies to both the current request and outgoing response. This supports persistence across a fresh browser context; it does not by itself prove indefinite survival under every browser or project policy.

`shared/auth/refresh-fetch.ts` only rewrites retryable POST refresh-token failures at the configured provider origin/path. It makes 408, 429 and 5xx responses retriable by the installed SDK instead of treating them as a definitive token rejection. Definitive invalid/revoked refresh tokens remain terminal. Browser, server, middleware and Expo use that adapter. `lib/supabase/auth.ts` distinguishes unavailable auth from a normal missing session. Middleware's retryable-cookie allowance does not establish a user identity; protected data reads still use their server auth boundary.

`components/auth/session-keeper.tsx` reconciles token/auth changes and visibility, focus, online, pageshow and Capacitor resume events with the server tree. It fences obsolete reads using auth revisions/read order/disposal. Transient refresh failures retain the saved session and current tree. `app/(app)/layout.tsx` mounts it in the authenticated app layout; its presence is not independent proof of authorization.

`app/auth/signout/route.ts:20` uses local-device sign-out by default, with explicit `scope=global` supported, and expires the auth cookies on its redirect. `components/auth/sign-out-button.tsx:40` already clears every `bub:cache:` entry only after confirmation. The actual form-handler browser test proves cancellation preserves cache, confirmation removes it, and unrelated localStorage preferences survive. The server route cannot directly clear browser localStorage; auth reconciliation is also required for other tabs and non-form sign-out paths.

The separate Expo application uses SecureStore through `mobile/src/lib/chunked-storage.ts`, a singleton persistent SDK in `mobile/src/lib/supabase.ts`, and foreground refresh in `mobile/src/lib/auth.tsx`. `mobile/src/lib/auth-session.ts` retries unavailable storage/auth without treating a transient null snapshot as definite sign-out. `mobile/src/lib/sign-out.ts` fences stale writes during device sign-out. Existing execution tests cover chunk commits, storage failure, late bootstrap, auth changes and concurrent sign-out/session writes. The installed SDK also contains refresh-storage-change/removal-epoch protection; this audit found no executable evidence that its old refresh can restore an explicitly removed session.

The Capacitor wrapper is a hosted WebView configured by `capacitor.config.ts`, ordinarily at `https://www.bubaly.com`. It uses the browser cookie session, unlike Expo's SecureStore session. No built iOS/Android projects or physical signed shell were exercised here.

## Concrete findings and repairs

| Finding | Before-change execution | Current disposition |
| --- | --- | --- |
| AUTH-L01: offline cache survives definitive identity transition | Real React SessionKeeper called `router.refresh()` on SIGNED_OUT and different-user SIGNED_IN but left A's rows in localStorage. Remounting the actual shared hook for B in the same family while offline rendered A's cached row. | Repaired in SessionKeeper: clear cache before those definitive events and before successful foreground reconciliation to a different/no user. Failed foreground refresh preserves cache and identity. |
| AUTH-L02: pending old request can refill purged cache | Start the actual hook for A, emit SIGNED_OUT, verify cache empty, resolve A's pending read: `late-user-a-private` reappears in cache. The table/family/deps scope is unchanged while the server refresh is pending. | Repaired after separate root authorization: central cache generation, subscribed hook scopes and synchronous request/setter fences. Failed physical cache deletion is also fenced in memory. |
| AUTH-L03: native cleanup escapes error handling | Actual React effect, mocked Capacitor transport: a rejected `handle.remove()` produces unhandledrejection both when registration finishes before unmount and when it finishes after unmount. | Repaired: shared removal wrapper catches both synchronous native bridge throws and asynchronous rejection. This contained error was not proven to log out a user. |
| AUTH-L04: persistent cache identity/permission partition | Cache identity is table, family and serialized caller deps. A user/role/permission identity exists only when supplied by the caller. SessionKeeper auth events do not prove every initial mount or same-user permission change has been observed. | Open security boundary. Clearing known transitions and fencing outstanding requests cannot establish full user/role isolation. No claim that all 231 consumers are authorized or partitioned; no consumer expansion in this lane. |

AUTH-L01 and AUTH-L03 source changes were authorized by root after controlled reproduction. No change removes revoked-session enforcement or alters the handling of transient refresh failures.

The AUTH-L02 repair is central: cache invalidation advances a generation even when storage is unavailable; mounted hooks subscribe through `useSyncExternalStore`; generation forms part of their in-memory scope; every response/cache commit and retained setter also synchronously checks its captured generation. The synchronous guard is needed because a previous response can finish before React processes an invalidation render. Old data is masked on the invalidation render, then a fresh read can produce success or an explicit error.

If `removeItem` throws while reads remain available, generation alone would let the replacement scope hydrate old physical entries. After a purge, `lib/offline/cache.ts` therefore only hydrates exact serialized values that were successfully written after that purge in this module lifetime, tracked per Storage object. This accepts fresh writes in the same millisecond without treating old rows as fresh. Real React tests cover failed deletion, unavailable-then-recovered storage, remounts, retained old requests/callbacks and same-instant writes. A failed physical purge followed by a browser restart can still leave old disk entries; durable authenticated owner/role partitioning remains open.

## Executed checks

Baseline auth subset: **15 files, 222 tests passed**:

```powershell
node node_modules/vitest/vitest.mjs run tests/auth-refresh-persistence.test.ts tests/session-keeper.test.ts tests/auth-server-unavailable.test.ts tests/auth-signed-out-is-not-an-error.test.ts tests/auth-context-integrity.test.ts tests/auth-context-error-contract.test.ts tests/auth-callback-failed-signin-keeps-session.test.ts tests/auth-callback-boundary.test.ts tests/middleware-oauth-code-routing.test.ts tests/middleware-bearer-api.test.ts tests/mobile-auth-session.test.ts tests/mobile-family-session.test.ts tests/mobile-session-storage.test.ts tests/mobile-device-sign-out.test.ts tests/durable-session-fixture.test.ts --reporter=dot --maxWorkers=4
```

New `tests/e2e/browser-session-storage.spec.ts`: **2 passed**. Runs the actual browser factory, installed SSR cookie adapter and installed auth SDK inside Chromium. Provider HTTP is entirely fulfilled locally with synthetic credentials. It proves page singleton, Secure/Lax/path/400-day cookie attributes, restoration in a new context with cookies alone and no new token request, and local SDK sign-out removing cookies before a fresh signed-out context. This is not a real GoTrue refresh/revocation or OS profile restart test. No token/storage-state artifacts are written; tracing/screenshots/video are disabled.

New `tests/e2e/auth-lifecycle-boundary.spec.ts`: original reproduction had 1 passing positive control and 5 explicitly expected failures. All are now ordinary passing regressions. Expanded coverage has **12 ordinary passes, zero expected failures**, including AUTH-L02. Real React, localStorage, SessionKeeper, sign-out handler, cache and shared hook run in Chromium; auth/native transports and visual primitives are controlled fixture boundaries.

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER = '1'
node node_modules/@playwright/test/cli.js test tests/e2e/realtime-query.spec.ts tests/e2e/auth-lifecycle-boundary.spec.ts tests/e2e/browser-session-storage.spec.ts --project=chromium --workers=2 --reporter=dot
```

Final focused browser gate: **46 passed** (32 shared-hook, 12 auth lifecycle, 2 installed-SDK cookie tests). Final existing unit gate: **12 files / 436 passed**, combining the 9-file DATA-002 regression subset with `session-keeper`, `auth-refresh-persistence`, and `mobile-device-sign-out`. The existing files-hub fixture emitted React key warnings. Scoped lint passed for SessionKeeper, cache, shared hook and all three browser test files; diff whitespace check passed. No repeated full-project tsc/full suite in this lane.

## Explicit deployment/device limits

- Supabase normally permits indefinite sessions, but project time-box/inactivity/single-session settings, revocation, refresh-token reuse protection and account/security changes can legitimately end them. The production project's settings were not read. Keeping the session until explicit sign-out therefore still requires verifying the intended project policy without weakening security enforcement. [Supabase session configuration](https://supabase.com/docs/guides/auth/sessions).
- `tests/e2e/durable-session.spec.ts` already contains four disposable local-GoTrue journeys: cookie-only restart, expired access-token refresh, parallel middleware requests, and local logout preserving another browser session. They were not run here: `E2E_DURABLE_SESSION=1` requires a coordinated disposable local provider/admin fixture that creates accounts and family records. Passing fixture guards is not passing those journeys.
- Real app/browser return after hours/days, full OS/browser restart, WebKit/Capacitor storage retention, native keychain lock/unlock, reinstall/OS data eviction and actual refresh rotation against the deployed project remain unverified. The browser context test intentionally has a narrower claim.
- Production canonical host, HTTPS/proxy header and public environment configuration must match the cookie/provider origin. `.env.example` supplies both app/site URL names, but no deployed values were inspected. The three incoming OAuth commits were reviewed without duplicating their credential/configuration fixes.
- Global sign-out currently ignores the SDK's returned error before clearing local cookies. Local-device clearance is intentional and tested; successful revocation on other devices during a provider outage is not established by that route. No UI in this trace submits global scope, and no provider outage/global-device workflow was executed.
- The separate DATA-002 report documents the 22 directly destructured query callers that omit error handling. That presentation gap remains separate from session persistence and was not expanded into this lane.

These results establish local module and controlled-browser behavior. They do not establish a full deployed login-to-restart-to-revocation workflow pass.
