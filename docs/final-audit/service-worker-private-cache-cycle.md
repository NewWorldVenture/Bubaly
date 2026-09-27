# Service-worker private image cache

## Current integration and read-side findings — 2026-09-27

The saved September 19 work was reconciled with incoming main `06dd3f7e6d9c0304c9556a4e17c815fa8389a085`. Claude already repaired the original optimizer/cache-write disclosure in v5 (C1-K-18/Q58) and exercised it with native Chromium, a registered worker and the real Next image optimizer against a production build, plus VM regressions. That scoped repair and its successful controls remain valid evidence. Q59 also moved family-media consumers to signed reads; the production bucket is still public, so SEC-001 remains FAIL independently.

Root executed **five desired failing regressions against the exact incoming 06dd worker** in a fresh private verification runtime, with no product change: `Temp/bubaly-sw-main-06dd-red-20260927.log`. These show that cache-first reads can still return:

- Seeded bytes for an unreviewed `/family/photo.png` request.
- A cached static-icon response marked `private, no-store`.
- A cached static-icon HTML response with the wrong MIME type.
- A cached static-icon 403 body.
- Private navigation HTML from a v4 cache recreated after activation, instead of the public offline page.

The handlers, Chromium CacheStorage and application logout are real; request delivery and response seeding are controlled synthetic fixtures. This new evidence does not claim private production content was fetched, native worker installation was tested here, or the Next optimizer regressed. It extends the previous cache-write fix to the previously unverified cache-read and cache-ownership boundary. `SUPPORT-98FD1D4C44AD` is therefore reopened IN PROGRESS, preserving its earlier v5 FIXED + PASS provenance.

The merged v6 repair restricts eligible public paths and reads/writes to the current named shell cache, validates cached and fetched response metadata, excludes authenticated/dynamic paths and preserves the separately owned explicit-download library cache. Exact merged worker blob `dd571476aeb5e8c2adc24de3e7e2b298fd187781` and fixture blob `9c46c199690d05bd930766919d4f90fb04940af4` pass **85/85** controlled browser checks in 3.9s: 72 new cache cases plus 13 registration cases, using the actual incoming logout import graph (`Temp/bubaly-sw-integrated-browser-20260927.log`). The cache fixture also passes scoped lint (`Temp/bubaly-sw-cache-lint-20260927.log`). The 85 count contains the 72 and 13; it is not additional to them. Native-worker and new hosted acceptance remain pending. The additional controlled-browser fixture has permanent ID `SUPPORT-1A08672F87F3` (`tests/e2e/service-worker-cache.spec.ts`), using the existing SHA-256 canonical-path convention. No SQL, production bucket setting or provider configuration is changed in this cycle.

Incoming main itself is already released: CI 36320217255 passes all four jobs; Vercel `dpl_8AwmjjnWmYs4nWfCjzg77DFi3QaF` succeeded at 12:52:24 UTC, and the public build endpoint identified exact 06dd with HTTP 200/private/no-store at 15:39:23 UTC. Those gates do not cover this unpublished additional fixture or merged v6 source. Broader production readiness remains NO.

## Native fixture and whole-source gates

`SUPPORT-827E4294FC10` inventories `tests/e2e/service-worker-native.spec.ts`, blob `48330763cc3754c01c7a713850804bc00e36f84a`. The one discovered case passes strict types and lint. It uses the hosted E2E runner's existing Next server for actual `/sw.js`, install documents and the public icon; synthetic private-cache controls avoid real accounts, authenticated content and provider actions. Native registration/offline runtime has not executed yet. Neither discovery nor type/lint success is a native-worker PASS.

The initial Windows full-suite attempt reported 37 failed / 1,571 passed files and 89 failed / 20,488 passed assertions. Its verification environment was invalid: repository lookup climbed to `C:/Users/Daniel`, POSIX path/glob assumptions differed and build-stub environment variables did not match CI. This failed attempt is retained, but cannot establish a product regression or full-source acceptance. A private WSL Linux tree with the proper Git index, exact Node 24 and CI environment is being prepared; full unit/build/type/lint gates and native hosted execution remain pending. The existing 85/85 controlled browser result remains its own narrower executed evidence.

## Retained September 19 checkpoint

The remainder is the original dated observation, preserved for source and failure provenance. Its old status counts and running/pending statements are historical. Run35471471192 later completed with E2E failure; main subsequently repaired the synthetic paste and pre-hydration phone-entry defects and passed the full hosted matrix.

2026-09-19. Baseline main `75a1f3c6b9874e0228af2c81f072e7cc068d1c9e`, tree `2f4cb2f980b1a92c4313d3af4ea7fe514630a648`. SEC-001 remains FAIL and existing SUPPORT-98FD1D4C44AD (`public/sw.js`) remains IN PROGRESS. This cycle addresses the browser cache boundary; it does not make the family-media bucket private or complete the full SEC-001 rollout.

## Reproduced boundary

Actual `public/sw.js` event handlers run with controlled synthetic event/network delivery, real Chromium CacheStorage and actual `signOutBrowserSession`. A synthetic same-origin `/_next/image` response with `Cache-Control: private, no-store` enters `bubaly-v4`. Actual logout clears session cookies and partitioned query storage but leaves those bytes. After B is installed, offline lookup returns A's image without another fetch: the count remains one. The desired privacy regression fails. API and cross-origin image exclusion, old-v3 cache purge and library-cache retention controls pass.

Evidence: `Temp/bubaly-sw-private-image-repro-20260919.{log,json}`; baseline worker SHA256 `e7655b4571857cfaa3c2689b5a2bb055f0d75ac2ae6f6e29aa0a070693396ac4`. Temp means `C:/Users/Daniel/AppData/Local/Temp`. The test executes real handlers, cache storage and logout code; it does not register a native service worker, run a real Next optimizer, start a local app server or access production private content. No SMS, provider mutation or SQL operation is involved.

The six-writer family-media map and downstream renderer/cache requirements remain in SEC-001's master detail. Home uses Next Image, whereas the worker skips direct cross-origin Supabase requests. Cache isolation is therefore a separate requirement from bucket access or signed URL expiry.

## Repair and acceptance in progress

Implementation and regression work are active. The intended boundary is to prevent private or account-dependent image bytes from entering or being reused by the shared app-shell cache while preserving permitted public shell/static assets and the separately owned offline library cache. Existing contaminated entries, logout/account replacement and delayed cache writes require explicit coverage. No repair PASS or release claim is made at this checkpoint; exact source, executed tests and remaining limits will be recorded after evidence is supplied.

No new route, runtime export or permanent inventory ID is assumed here. All 14,038 current IDs and statuses remain unchanged: 13,842 NOT STARTED, 192 IN PROGRESS, one FIXED + PASS and three FAIL. The worker support item was already IN PROGRESS before this cycle. Broader production readiness remains NO.

## Published baseline, separate from this work

Release `75a1f3c6` is verified on Vercel `dpl_6KZy5vXVRZSQW5zF4qckk8pZQdbW`, GitHub Production `6546108247`, immutable URL [bubaly-rdlt5ry45](https://bubaly-rdlt5ry45-newworldventure.vercel.app). At 21:51:25 UTC, the public build response returns200, identifies exact revision75a1f3c6 and has private/no-store headers. The final release record at21:51:48 UTC contains passing exact-deployment public auth and phone readiness, zero page errors/failed assets, and no authentication action, cookies or SMS dispatch. Evidence: `Temp/bubaly-75a1f3c6-production-release-20260919.json`.

Hosted CI `35471471192` is still running at this checkpoint. The prior2a5 run remains 1,293/1,296, with all three phone cases failing before code entry; its repaired durable signout and six callbacks pass by complete enabled-matrix inference. The75a1 CI configuration repair and pending new phone runtime are separate from this unpublished worker change. No existing hosted result is attributed to new worker source.
