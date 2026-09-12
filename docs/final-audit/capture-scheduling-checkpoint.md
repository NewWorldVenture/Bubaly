# Capture and scheduled publishing verification checkpoint

Final verified source: `910cd271bc273e68c286c3b10aaf1f27f6b933c2`, after published care checkpoint `d36602ebf154f1ebbd35fac0876839fd8c369705`. Build, browser and startup checks used `f6e17ef65431786874178916c03f343183357ec1`; the sole follow-up changes two obsolete cron fixtures and their evidence document. All production, configuration and browser sources are byte-identical. Final complete units and strict types use the final archive. This record does not declare the application production-ready.

## Changes and behavior

QuickCapture, CaptureShell and VoiceModule guard each submission against duplicate, retired or changed-owner callbacks. Required list reads and writes must return valid identities before success or Undo. Each request has a 15-second deadline; an unconfirmed mutation preserves the draft and requires review. Optional voice history does not delay confirmed capture feedback. Explicit Undo still targets the originally confirmed household and IDs. The unchanged global CommandBar and cross-client default-list uniqueness remain separate limitations.

Social scheduling accepts explicit future UTC instants and visible IANA timezones, rejects DST gaps/folds and checks the complete weighted X payload before persistence. Strict create/schedule/calendar/cleanup receipts preserve honest recovery. The Studio retires stale input and submission callbacks, settles changes during dispatch into review and retains a known post ID when possible. Stored links are validated at both write and rendering boundaries.

The worker executes only server-created private intent with immutable content/account bindings. Revision claims, current actor/approval/token checks, per-target receipts and bounded dispatch prevent an uncertain attempt from becoming an automatic resend. Only known rate-limit rejections retry automatically. Private proof repairs displayed post/target/schedule/calendar outcomes; interrupted dispatch stays held. The existing dispatcher registers a five-minute cadence and Vercel a daily fallback. No SQL or live provider operations were performed.

## Executed verification

Root archived the exact commit into the existing private clean installation at `C:/Users/Daniel/AppData/Local/Temp/bubaly-audit-clean-install-20260912`. Its independently installed dependencies are unchanged; shared `node_modules` was untouched. All commands select checksum-verified Node 24.21.0, including child-process PATH. The private archive has only `.env.example`. Production build/start use an invalid fixture database and blank provider keys.

| Check | Result | Local log under `C:/Users/Daniel/AppData/Local/Temp/` |
| --- | --- | --- |
| Final complete unit suite | **1,156 files / 13,254 tests passed**, 128.09 seconds; exit 0, no unhandled errors | `bubaly-capture-schedule-final-units-20260912.log` |
| Combined actual React/Chromium checks | 336 passed in 53.0 seconds | `bubaly-capture-schedule-components-20260912.log` |
| Production build | Passed; 246 generated pages; shared JS 103 kB; middleware 92.5 kB | `bubaly-capture-schedule-build-20260912.log` |
| Final strict TypeScript after build | Passed; no emit, incremental disabled; exit 0 | `bubaly-capture-schedule-final-types-20260912.log` |
| Full lint | Passed with the four unchanged baseline warnings | `bubaly-capture-schedule-lint-20260912.log` |
| Query/schema source audit | Passed: 484 tables, 77 functions, 139 API routes | `bubaly-capture-schedule-query-20260912.log` |
| Translation gate | Passed | `bubaly-capture-schedule-i18n-20260912.log` |
| Built application startup | Home 2,076 ms; feature navigation 1,647 ms; no page errors | `bubaly-capture-schedule-public-probe-20260912.log` |
| Response cancellation | Five homepage cancellations, zero internal stream errors | Same probe log; server log `bubaly-capture-schedule-public-start-20260912.log` |

The 336-browser suite combines the previous 265 cases with 39 capture, nine voice and 23 scheduling cases. The 12 existing social-publish consumer cases are counted once. These execute real components/hooks/handlers with controlled SDK/provider transports; they do not prove deployed RLS, live external delivery, microphone recognition or physical-device behavior. Build diagnostics for unavailable fixture reads exercise fallback rendering rather than successful live reads.

Independent focused verification includes 75 action cases, 37 page-render cases, 58 actual private-worker/installed-SDK scheduling cases, 62 capture-helper cases and the related integration runs documented in each cycle report. Root's ten-file 320-case focused run and 83-case new/related browser run also pass. All seven base catalogues preserve their 13,496 existing values and order, adding the same 21 keys; placeholders and formal DE/FR/PT copy were independently reviewed.

## Failed checks and corrections

The initial complete suite on `f6e17ef6` passed 1,154 files / 13,251 tests and had exactly three assertion failures in 132.04 seconds. Actual dispatcher execution calls `/api/cron/social-publish` alongside the four prior five-minute routes, while two CLI fixtures still expected four calls and a four-route failure summary. A cadence mapping fixture also omitted the newly slowed Vercel route. The correction retains actual CLI execution, all existing routes and failure propagation; it also checks the exact attempted URLs in a failed tick. The focused 35-cron/58-scheduler run passed all 93 tests. The fresh complete `910cd271` rerun passed all **13,254 tests** with no unhandled errors. Initial evidence remains in `bubaly-capture-schedule-full-units-20260912.log`; focused evidence is `bubaly-scheduling-cron-fixtures-20260912.log`.

Earlier actual reproductions and repairs remain in the capture, action, presentation and scheduler cycle reports, including missing mutation receipts, retired form callbacks, unsafe URLs, invalid weighted payloads, incorrect abort-signal placement, mixed retry outcomes and interrupted display reconciliation. Test-only context/UUID/encoding corrections are distinguished from production fixes.

## Source discovery

`discovery/capture-scheduling-inventory.json` pins the complete non-audit-document delta from `d36602e` to `910cd271`: 47 files, 13 new files, 22 production sources, 16 tests, seven catalogues and two support/configuration files. It records 115 exported symbols, 29 newly exported functions, one GET route and two cron registrations. Exact committed hashes, bytes, previous master identities and catalogue preservation were checked. New source/function/job/control obligations retain the original permanent-ID rules; discovery itself does not pass their workflows. Four new capture-review/timezone controls are explicitly recorded in the renderer.

## Remaining verification and release decision

The prior care checkpoint passed all four hosted CI jobs and 697 hosted browser tests on `d36602e`; those results do not apply to this new source. The published capture/scheduling checkpoint `ea3d6e40284e403a5ec986e993886420785f4162` subsequently passed all four jobs in [hosted CI run 34703680247](https://github.com/NewWorldVenture/Bubaly/actions/runs/34703680247): Typecheck · Lint · Test · Build; Mobile (Expo) · Typecheck · Config; Database (migration replay · RLS boundary probes); and E2E (public · a11y · authenticated · mobile device matrix). This terminal result was read with `gh run view` on 2026-09-12. It does not cover the subsequent uncommitted authentication work or prove live provider delivery.

Live cron/default-branch deployment, current external account credentials and publication are unverified. Approval workflow, token refresh, legacy schedule adoption, recurrence, editing/cancellation, interrupted target continuation and operator reconciliation remain separate work. Private receipts can repair visible outcomes without recreating missing historical result/job/usage rows. Multi-table rechecks do not claim a database transaction or cancellation after a provider accepts a request.

SEC-001 public family-media storage and AUTHZ-003 restrictive social-member DELETE policy remain unresolved release failures. Shared navigation, database SQL, dependency versions and financial operations were not changed. Other inventory obligations and the second whole-application regression remain open. **PRODUCTION READY: NO.**
