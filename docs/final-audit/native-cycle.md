# MOBILE-002 — Native listener lifecycle

Date: 2026-09-12. Baseline: `c7b56eff`. Root owns the master audit status.

## Problem and fix

`NativeBootstrap` originally replaced its cleanup function only after imports, status/splash operations and both asynchronous listener registrations completed. If React unmounted earlier, the old no-op cleanup ran. Initialization then attached listeners that could navigate the application after unmount. Failure while registering the second listener also left the first listener attached.

The baseline actual-component Chromium test unmounted while imports were pending, then resolved them. It expected zero status, splash and listener operations; it observed **one of each**. An earlier in-memory probe independently reproduced two listeners added and zero removed after immediate unmount.

`components/native/native-bootstrap.tsx` now tracks disposal from the start of the effect, checks it after each awaited initialization step, retains each handle as soon as it resolves and removes handles that arrive after disposal. Teardown removes all retained handles once. Partial initialization failure invokes the same cleanup. Native event callbacks check disposal before navigating or exiting, including when a native removal promise fails.

The change preserves existing status/splash fallbacks, Android back/exit behavior and URL path/query/hash routing. It changes neither shared navigation nor deep-link trust policy.

## Targeted execution results

`tests/e2e/native-bootstrap.spec.ts` executes the actual source component with real React, ReactDOM and Chromium. Capacitor imports and plugin promises are controlled boundaries so every race can be reproduced deterministically without a device/account/provider.

| Case | Result |
|---|---|
| Unmount before imports resolve prevents every later native operation | PASS; baseline failed |
| Unmount while status-bar operation is pending stops later work | PASS |
| Unmount while splash operation is pending stops later work | PASS |
| First listener resolves after unmount: remove it and ignore queued back/exit events | PASS |
| Unmount between listeners: remove both handles and ignore late URL/back events | PASS |
| Completed setup preserves back/exit and valid URL routing; normal unmount cleans once | PASS |
| Second-listener failure removes the first and disables its callbacks | PASS |
| Missing native modules cause no listeners or unhandled rejection | PASS |
| Optional status-bar failure preserves other native behavior | PASS |
| Removal failures remain handled and cannot permit stale navigation | PASS |
| Non-native browser imports no native modules | PASS |

Baseline red command, before production edit:

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER='1'
node node_modules/@playwright/test/cli.js test tests/e2e/native-bootstrap.spec.ts --project=chromium --workers=1 --grep 'unmount during imports' --timeout=15000
```

Result: **1 failed** with actual operations `[1, 1, 1, 1]` versus expected `[0, 0, 0, 0]`.

Retest command:

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER='1'
node node_modules/@playwright/test/cli.js test tests/e2e/native-bootstrap.spec.ts --project=chromium --workers=1 --timeout=15000
```

Result: **11 passed** in 1.7 seconds. Focused ESLint and `git diff --check` passed. Full-project `node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false` completed with exit 0 and no diagnostics after both lifecycle fixes and both browser specs were present. Root owns the final build/regression.

## Separate findings and evidence limits

The original URL handler stripped any parseable input URL to its path/query/hash without validating that the resulting path remained internal. Initial discovery treated this as a separate trust question. Subsequent execution established a specific external-navigation defect: `https://www.bubaly.com//outside.example/path?source=native#section` produced the native `router.push` argument `//outside.example/path?source=native#section`. Executing installed Next 15.5.25 `publicAppRouterInstance.push`, `dispatchNavigateAction`, the installed `isExternalURL` function and `navigateReducer` produced `isExternalUrl=true`, `canonicalUrl=https://outside.example/path?source=native#section`, `mpaNavigation=true`, and `pendingPush=true`. The installed `app-router.js` then selects `location.assign(canonicalUrl)` for that state. The probe executed no network requests. This distinct finding was reported to root before further production edits and was repaired in the subsequent SEC-003 cycle below. Origin allowlisting and physical native association behavior remain separate questions.

The targeted lifecycle fix passes controlled-boundary browser tests. Real Capacitor bridge behavior, native package signing/building, physical hardware back, OS deep-link association, OAuth return, push notifications, permission dialogs, status-bar appearance and background/resume are not verified by this suite. No production-ready or complete-native-workflow claim is made.

## SEC-003 — Prevent external destination reinterpretation

After root recorded SEC-003 in the master audit, the handler began validating `parsed.pathname` with the existing `safeInternalRedirect(pathname, '')`. Rejected paths cause no router call. Accepted paths retain the original `parsed.search` and `parsed.hash`. The helper is applied only to the pathname so opaque OAuth query/hash values containing encoded slashes or backslashes remain unchanged; validating the combined string would incorrectly reject those payloads. Incoming provider origin/scheme policy is unchanged and no global router/navigation/helper file was edited.

Four new actual-component browser tests failed before this guard: raw double-slash, backslash-normalized, encoded-slash and encoded-backslash paths all reached `router.push`. They now pass without any router call. Three additional cases confirm an ordinary provider callback, opaque encoded `code`/`next`/`state` and hash values, and a custom-scheme deep link preserve the existing path/query/hash behavior. The ordinary calendar deep-link check from MOBILE-002 also remains passing.

Combined retest:

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER='1'
node node_modules/@playwright/test/cli.js test tests/e2e/native-bootstrap.spec.ts tests/e2e/register-sw.spec.ts --project=chromium --workers=1 --timeout=15000
```

Result: **31 passed** in 3.5 seconds: 18 native lifecycle/destination tests and 13 PWA lifecycle tests. The browser suite executes the actual redirect helper alongside the actual native component; the router/plugin boundaries are controlled and do not navigate to an external host. Focused ESLint and diff checking passed. Existing redirect/PWA regression command passed **5 files / 28 tests**:

```text
node node_modules/vitest/vitest.mjs run tests/auth-redirect.test.ts tests/mobile-pwa-update.test.ts tests/offline-cache.test.ts tests/mobile-sw-auth-cache.test.ts tests/mobile-sw-notification-focus.test.ts
```

The final full-project typecheck after SEC-003 reported no diagnostics in the two lifecycle components or two browser specs, but exited 1 for two concurrent `TS7053` errors in another audit scope, `tests/cron-dispatch-execution.test.ts:18`. Root was notified so that file's owner can repair and rerun the global check. The earlier full-project typecheck after both lifecycle fixes was clean; neither result is a production-build or full-application sign-off.
