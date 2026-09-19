# MOBILE-001 — PWA registration lifecycle

Date: 2026-09-12. Baseline: `c7b56eff`. Root owns the master audit status.

## Problem and change

`RegisterSW` originally registered only in a future `window.load` handler. The authenticated `AppFrame` can mount through client navigation after the page has already loaded, leaving that session without a registration attempt. A new browser execution test failed against the unchanged component: document state was `complete`, expected registration attempts **1**, actual **0**.

`components/pwa/register-sw.tsx` now registers immediately when document loading has finished and otherwise waits for one load event. It tracks component disposal so a late registration resolution cannot attach observers after unmount. Registration and worker listeners are named, deduplicated and removed during cleanup, including workers already installing when registration resolves. Controller tracking distinguishes first installation from a later update even within the same session.

Registration denial and offline update checks retain the existing graceful behavior: the online application continues, no false update banner appears and no rejected promise escapes. Registration is retried on a later mount. This change does not grant permissions, unregister a browser-owned worker, change cache policy or touch shared navigation.

## Execution evidence

`tests/e2e/register-sw.spec.ts` loads the actual component through TypeScript transpilation and executes it with real React 18, ReactDOM and Chromium DOM events. Service-worker registration/EventTargets are controlled boundary doubles; actual component effects, rendering, unmounting and button clicks run in the browser. No Next server, Supabase, production account or external provider is used.

| Browser case | Result |
|---|---|
| Mount after actual document load attempts registration | PASS; failed before the fix |
| Pre-load mount waits, then registers once even after duplicate load dispatch | PASS |
| Pre-load unmount cancels registration and poll | PASS |
| Pending registration resolving after unmount attaches no observers | PASS |
| Already-installing worker is observed | PASS |
| Waiting update renders and Later dismisses it | PASS |
| Reload button causes a real page reload | PASS |
| Duplicate update events attach one worker observer; all observers clean up | PASS |
| Remount leaves one live observer and still detects later updates | PASS |
| First installation does not show an update prompt | PASS |
| Registration SecurityError causes no false update/unhandled rejection | PASS |
| Offline polling rejection is handled; poll stops after unmount | PASS |
| Unsupported browser does not register or poll | PASS |

Baseline red command (before production edit):

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER='1'
node node_modules/@playwright/test/cli.js test tests/e2e/register-sw.spec.ts --project=chromium --workers=1 --grep 'registers when first mounted' --timeout=15000
```

Result: **1 failed**, expected 1 registration, received 0.

Retest command:

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER='1'
node node_modules/@playwright/test/cli.js test tests/e2e/register-sw.spec.ts --project=chromium --workers=1 --timeout=15000
```

Result: **13 passed**. Final run after the test typing cleanup: 2.6 seconds. Existing PWA regressions also passed:

```text
node node_modules/vitest/vitest.mjs run tests/mobile-pwa-update.test.ts tests/offline-cache.test.ts tests/mobile-sw-auth-cache.test.ts tests/mobile-sw-notification-focus.test.ts
```

Result: **4 files, 16 tests passed**. Focused ESLint, standalone strict TypeScript checking of the new spec, and `git diff --check` passed. Full-project `node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false` subsequently completed with exit 0 and no diagnostics after both PWA/native fixes and browser specs were present. An initial standalone typing check rejected the test-only browser-global assertion; that harness typing was corrected and rechecked without suppressions or `any`.

## Limits and remaining workflow evidence

The component lifecycle defect is fixed and its targeted execution tests pass. Service-worker installation, cache/offline operation, authenticated first-login integration, actual update delivery, mobile overlap/keyboard behavior and physical PWA/native devices are not verified by this controlled boundary suite. Existing cache tests are regression evidence, not a complete installed-PWA journey. Root's final build/typecheck and final regression remain authoritative.
