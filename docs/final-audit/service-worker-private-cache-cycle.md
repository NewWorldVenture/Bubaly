# Service-worker private image cache

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
