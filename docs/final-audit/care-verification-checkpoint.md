# Care, delivery and runtime verification checkpoint

Verified source: `608c93071a88bf8211f1dda5ecbce3454c18b751`, following published baseline `05e1b69bf78bebe76a71f8b0eaf83a8921d171f3`. These are local execution results, not a complete application or production sign-off. Quick Capture and social scheduling discovery/repairs are separate next-cycle work and are excluded from these counts.

## Changes covered

- Medication, hydration and rewards actions require current household/day data and successful required reads. The additive query confirmation API waits for the latest committed read, including when another request supersedes it. Each form opening retires its own callbacks; acknowledged creates finish once after required readback recovery.
- Contact Center intake stores a durable private urgent-delivery receipt before inbox capture, repairs required notifications independently and retains provider uncertainty. Only confirmed rate-limit rejections receive bounded retries. A secret-authenticated worker drains pending work with a time budget. Checked insert/duplicate verification replaces an incompatible partial-index upsert target without changing SQL.
- Marketing push records provider acceptance separately from skipped devices and excluded users, claims attempts before dispatch, permits whole-campaign retry only with proof of a pre-dispatch failure, and preserves active/uncertain attempts for review.
- Web runtime requires Node `>=24.15.0 <25`; web CI uses Node 24. A reproduced Node 22 response-stream cancellation race is absent in the isolated Node 24 verification. Dependency versions and integrity/resolved entries are unchanged. Browser auth fixtures own separate identities across projects; the multipart fixture now models incoming HTTP bytes and verifies real Next request-adapter cancellation.

## Final executed gates

All commands used a private clean installation at `C:/Users/Daniel/AppData/Local/Temp/bubaly-audit-clean-install-20260912`. Its dependencies came from the earlier successful private `npm ci`; shared `node_modules` was untouched. The checksum-verified official portable runtime was Node 24.21.0. Command-local PATH also selected that runtime for child processes. Production provider credentials were blank; unavailable database transport used an explicitly invalid fixture host.

| Check | Final result | Local log under `C:/Users/Daniel/AppData/Local/Temp/` |
| --- | --- | --- |
| Complete Vitest suite, two workers | **1,151 files / 13,003 tests passed**, 124.53 seconds; exit 0, no unhandled error | `bubaly-care-final-units-recheck-20260912.log` |
| Actual React/Chromium workflows | **265 checks passed**, 38.2 seconds | `bubaly-care-final-components-20260912.log` |
| Production build | Passed; 245 static pages generated, shared first-load JS 103 kB, middleware 92.5 kB | `bubaly-care-final-build-20260912.log` |
| Final strict TypeScript after build | Passed, no emit and incremental disabled; exit 0 | `bubaly-care-final-types-20260912.log` |
| Full lint | Passed with four unchanged baseline warnings | `bubaly-care-final-lint-20260912.log` |
| Query/schema source audit | Passed: 484 tables, 77 functions, 138 API routes | `bubaly-care-final-query-audit-20260912.log` |
| Translation gate | Passed | `bubaly-care-final-i18n-20260912.log` |
| Final production browser startup | Home 2,064 ms; feature navigation 1,631 ms; no page errors | `bubaly-care-final-public-probe-20260912.log` |
| Homepage HTTP cancellation | Five response cancellations; zero internal stream errors; probe exit 0 | Same probe log; server output in `bubaly-care-final-public-start-20260912.log` |

The build and 265-browser run used `3effbf41d433c332fe3abb79f88ffe45733941cf`. The sole change from that commit to `608c9307` is an obsolete static assertion in `tests/health-read-boundaries.test.ts`; production, runtime configuration and browser-test sources are byte-identical. The final complete unit rerun, strict types and startup probe used the final archive. Build output includes expected unavailable fixture-database read/timeout diagnostics and fallback rendering; it is not evidence of successful live database reads. The production probe had a 30-second watchdog and terminated its local server/browser on completion.

Browser coverage includes auth/cache partition and lifecycle, browser session storage, service worker/native bootstrap, display ownership/clock, finance read states, rewards, social publish consumers, medications, shared query confirmation and hydration. Controlled SDK/provider transports exercise real components, hooks and handlers; they do not establish live RLS, deployed provider delivery or physical-device behavior.

## Failed checks and verified corrections

The intermediate `572b29c9` suite had 12,995 passes, two obsolete source assertions and one unhandled error. The assertions referred to the old marketing claim helper and old notification-writer exemptions; their replacements retain prerequisite/claim checks and scan upserts as well as inserts. The unhandled error came from the outgoing Undici FormData encoder used by an oversized inbound-body fixture. A preserialized incoming stream and actual loopback HTTP → Next adapter → email handler test now verify 413, bounded reads, cancellation and no database/provider reads. Production cancellation and size limits were not weakened. The focused correction passed 30 related cases.

The first combined final suite on `3effbf41` passed 13,002 tests with no unhandled errors and failed one obsolete health source assertion. That assertion was updated to the combined required loading/error gates; the actual medication/readback browser checks remain. The fresh complete `608c9307` rerun passed all 13,003 tests. An earlier strict type check caught seven receipt-output spread errors; using `Omit` before typed input/output fields corrected the JSON intersection, without casts or runtime changes. Final strict types passed.

The published documentation checkpoint `d36602ebf154f1ebbd35fac0876839fd8c369705`, whose application source is the pinned `608c9307` source above, passed all four hosted CI jobs: <https://github.com/NewWorldVenture/Bubaly/actions/runs/34701809388>. Quality passed the 13,003-test suite; database checks passed all 11 probes; mobile and E2E passed. The hosted browser result is **697 passed in 5.3 minutes**, with no flaky result in its final summary. Web jobs selected Node 24.20.0. The retrieved log contains no `TransformStream` or `ERR_INVALID_STATE` match. These facts do not establish that either condition caused the earlier task-toast failure. Vercel's deployment check also succeeded; this does not verify live credentials, scheduled delivery or production database policy. The complete retrieved CI log is `C:/Users/Daniel/AppData/Local/Temp/bubaly-care-hosted-ci-20260912.log`.

The prior hosted run on `05e1b69b` passed all four CI jobs: <https://github.com/NewWorldVenture/Bubaly/actions/runs/34700241919>. That result belongs to the prior source. The older `8b3df5e1` hosted run had 608 browser passes and one retried task-toast failure, plus a quality catalogue timeout. Catalogue validation was optimized without reducing checked keys or increasing deadlines. The task-toast failure preceded the first logged stream error; neither stream behavior nor fixture ownership is claimed as its proven cause.

## Independent integration and discovery

`care-integration-review.md` independently checks the exact source delta and `discovery/care-delivery-inventory.json`: 56 changed non-documentation files, 15 new files, 16 production sources, 28 tests, seven catalogues and five support/configuration files; 96 exported symbols. All committed hashes, baseline hashes, byte counts, API paths, methods and environment names match. All 13,477 existing keys retain their values/order in all seven catalogues; the same 19 keys are appended, giving 13,496 keys each. No SQL, generated schema, shared navigation or dependency version changed.

## Remaining scope and release decision

The full-suite execution record passes for the pinned source. Medication/hydration/reward workflow records remain in progress pending complete live authorization/concurrency/persistence verification. Urgent provider acceptance does not prove handset delivery; unknown attempts require review. The new five-minute urgent worker requires the existing default-branch dispatcher plus `CRON_BASE_URL` and `CRON_SECRET`; Vercel supplies only the daily fallback. No deployed schedule or provider operation was performed here.

Public family-media storage (SEC-001) and the restrictive social-member DELETE-policy gap (AUTHZ-003) remain release failures. No SQL was authored or applied. Other unfinished inventory items and the second whole-application regression remain open. **PRODUCTION READY: NO.** Audit counts measure separate verification obligations, not a development-completion percentage.
