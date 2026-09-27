# Production rollout — 2026-09-19

## Status reconciliation — 2026-09-27

Current follow-up checkpoint: main e14 CI `36332799249` was automatically cancelled after another session merged documentation-only f03a5457; it is not full acceptance. Corrected PR candidate CI `36332783206` remains pending. The first local four-file media integration ran20,721 passing tests and one failure: the existing fixture-graph guard detected the new browser-storage import missing from the manual display fixture. That failed run is preserved. The repaired display fixture passes25/25 browser cases; corrected full integrated gates remain pending. A permanent serverless suite, `tests/e2e/family-media-session-ownership.spec.ts` (`SUPPORT-4CE6A54076E4`), now retains four actual React/SDK two-tab cases plus three actual component SSR/hydration controls and passes7/7 in2.6s, with strict fixture types and lint passing. Its required collector registration also passes the37/37 fixture-graph guard. Logs: `Temp/bubaly-media-browser-retained-20260927/{browser,types,lint,guard}.log`. This is targeted local repair evidence, not a deployed media fix or a new product finding.

The local owner-cache change also exposed an actual SSR/hydration mismatch: FamilyMediaImg rendered a non-busy placeholder in Node, then added aria-busy during initial browser hydration with a valid cookie; actual React emitted one mismatch warning. The hydration-aware repair preserves a busy placeholder through hydration, settles to denial without an owner, preserves external images immediately and still renders an owned cached image immediately on a later SPA mount. Actual renderToString/hydrateRoot RED→GREEN receipts: `Temp/bubaly-media-hydration-{current,candidate}-20260927.{log,json}`. The adopted hook is bloba782289083275d8d10f1b3dc90353b7e1fa82a94; retained fixturee169fe97a845cb2ba1fa4d0117a94d3b2ce6dfa2 passes all7 cases (four ownership plus three hydration controls), scoped strict types/lint and the37-case fixture graph guard. The prior four-case passing receipt remains dated history. The new complete source still awaits final full gates, hosted execution and deployment; neither this local repair nor its proof is attributed to e14 production.

**Worker release verified in production; corrected hosted CI pending.** PR592 merged at 16:19:13 UTC as `e14b12e899fe62cf5a3993cfbe92121aab0a41f9`, tree `52e0d1e72ee23f67369d68e255c42958926252b7` identical to candidate850cc4. Vercel `dpl_57FH8FY8JZsuTFEo68uwkWJ7A34h` succeeded at16:22:37UTC; GitHub Production6694707719 succeeded at16:22:38UTC, immutable URL [bubaly-iu3lsdhzd](https://bubaly-iu3lsdhzd-newworldventure.vercel.app). At16:23:30–35UTC, the public probe passed exact revision/worker-hash checks, protected-meals→login, hydrated login/phone readiness without submission and actual publishedv6 installation. The production-only native wrapper then passed **1/1 in4.3s** with the final507a6cd assertions unchanged except origin admission and before/after revision/worker-hash guards: real public install/icon, synthetic private-cache image rejection, public image/publisher-fetch preservation and scripts-disabled top-level navigation returning the exact public offline shell. Receipts: `Temp/bubaly-sw-production-e14b12e8-20260927.json`, `Temp/bubaly-native-production-e14b12e8-20260927.log`, and `Temp/bubaly-native-production-e14b12e8-retained-receipt-20260927.json`. The retained native receipt is derived from the passing log and validated wrapper source; the line reporter did not persist the inline attachment. No authentication/provider writes or private production content were involved. Corrected candidate CI [36332783206](https://github.com/NewWorldVenture/Bubaly/actions/runs/36332783206) remains pending at this checkpoint. These results certify the worker scope, not the local media change below.

This is retained September19 history. Run35471471192 for75a1f3c6 ended in E2E FAILURE with the other three jobs successful; later Claude fixes repaired the synthetic clipboard event and pre-hydration phone-entry controls. Incoming06dd CI36320217255 passed all four jobs and its exact deployed build was checked at15:39:23UTC. Latest incoming main7563462e merged PR591 at16:01:34UTC; sourcee7988141 passed all four jobs in CI36329827922. These parent results are separate from the new combined worker source and do not prove production SMS delivery or physical-device persistence.

Current combined tree65719886c4cc6483a0be7d1b5f32f292119570e3 passes UTC20,701/20,701 across1,621files, build247, strict types and lint with15existingwarnings; its controlled worker matrix passes85/85 in3.8s. Both parent three-zone unit passes remain parent-scoped. Full combined gates precede the latest native-test-only correction. Final fixture-only delta tree `878a17b644c5b1b6106de465841d413a4d4f2a86` verifies all 5,191 files/modes against combined65719886 plus only native fixture507a6cd. Full generated-route strict types and lint with 15 existing warnings pass; discovery is 1/1, not runtime. Receipt: `Temp/bubaly-sw-reconcile-20260927/linux-combined-65719886/final-native-fixture-receipt.json`. Original59f03 CI36331147265 has Web/Database/MobilePASS and E2E1,369/1,370: the new native-worker test failed at iframe navigation. Corrected native fixture507a6cd109def62f6053ff1ebd82f8a701b9ca7d uses top-level navigation after CDP disables scripts; supplemental actual-engine v6 install/icon/offline-navigation proof passes, but corrected hosted CI remains pending. The later actual e14 production acceptance is recorded above; it does not cover the local media follow-up. Details and retained failed Windows/type checkpoints are in [the worker cycle](service-worker-private-cache-cycle.md).

SEC-001 stays FAIL for the public bucket and the separately reproduced Q59 media-cache observer gap. Real mounted React/SDK with synthetic intercepted provider/image transport confirms B's ready session can render/request A's cached signed capability after all observers unmount, without asking Storage asB. Active observed switching correctly purges. No private production data or live authorization was tested. A bounded local media repair has now been adopted after e14: `lib/storage/use-family-media.ts` binds cached capabilities and pending signing work to the readable browser user/session/logout generation, so B cannot reuse or join A's signing work while ordinary same-session rotation retains reuse. **It is not deployed in e14.** Existing helper IDs `LIBRARY-8223CBE7FA46` / `LIBRARY-99CA5C569F65` and SEC-001 retain the finding; new test records `SUPPORT-302F04E15861` (`tests/family-media-owner-boundary.test.ts`) and `SUPPORT-BC0F2BFDBFD6` (`tests/media-session-gap.test.ts`) are IN PROGRESS. The matching isolated prototype passes33/33 across three files (12 existing,19 owner/inflight and2 session-gap cases), scoped types/lint; baseline control fails17/passes16. Actual React/installed-SDK browser proofs pass2/2 for active-switch/observer-gap plus2/2 held-signing settlement orders, using only the one-module overlay. B requests its own signing before A settles; neither completion order returns A's image or erases B's pending slot. Evidence: `Temp/bubaly-sw-reconcile-20260927/q59-owner-prototype/receipt.json`, `Temp/bubaly-media-react-session-gap-prototype-20260927.json`, `Temp/bubaly-media-react-pending-prototype-20260927.json`. Full integrated gates and deployment of this local follow-up remain pending; synthetic provider/image transport is not live bucket authorization. SEC-001 remains FAIL. The three worker/support rows stay IN PROGRESS; AUTH-001/002/003 and broader production readiness remain open.

The latest e14 public acceptance at16:23:30–35UTC confirms HTTP200 health with env/database/auth/serviceRole OK, overall degraded and six missing feature settings: `CRON_SECRET`, `CHILD_LOGIN_SECRET`, `MARKETING_UNSUB_SECRET`, `GUARDIAN_INTERNAL_SECRET`, `FCM_PRIVATE_KEY` and `APNS_PRIVATE_KEY`. It agrees with the16:01:24UTC baseline. Earlier four-setting observations remain dated history; no secret values or provider settings were changed.

All pending/running statements below describe their original dated checkpoint, not current release status. Current evidence is not retroactively attributed to those old revisions.

The user authorized publishing the current changes to main and production. PR 510 merged at 19:50:26 UTC as `4bee627572be77112b1206f4243841df00f9a181`; its direct parents are prior main `57f22c0b` and audited branch `6353d0d4`. The merge and branch share frozen tree `b039b2c08e994037e65b2677c102b7a338a9bbe5`. No SQL or Supabase configuration changed from prior main.

## Verified CI follow-up release: 75a1f3c6

Release `75a1f3c6b9874e0228af2c81f072e7cc068d1c9e`, tree `2f4cb2f980b1a92c4313d3af4ea7fe514630a648`, publishes the two-file disposable phone CI repair and four audit documents. Application runtime and product Supabase configuration/SQL are unchanged from2a5. Vercel deployment `dpl_6KZy5vXVRZSQW5zF4qckk8pZQdbW` succeeds, GitHub Production `6546108247`; the immutable URL is [bubaly-rdlt5ry45](https://bubaly-rdlt5ry45-newworldventure.vercel.app).

At21:51:25 UTC, public build200 identifies exact revision75a1f3c6 with private/no-store headers. The21:51:48 UTC release record verifies exact-deployment public auth/phone readiness, disabled native credential controls/POST with no credential serialization, cookie-neutral invalid callback and clean history; zero page errors, failed public assets or authentication/SMS dispatch. This is public readiness, not production OTP delivery or verification. Evidence: `Temp/bubaly-75a1f3c6-production-release-20260919.json`. Hosted CI `35471471192` remains active; new phone acceptance is pending. The separate service-worker cache repair is now in progress and has no deployment or acceptance claim in this checkpoint.

## Verified application release: 2a5e7e7a

Application release `2a5e7e7a15b93f544660b41c0f3185b4865e80ed` was verified live at www.bubaly.com at21:29:31 UTC. Application commit `837b210106e48fe43023df352a4b84bed6200552` contains frozen source/test/workflow tree `f75e7febdf01bf944fa35a505745001533c80028`; the final release tree is `10034dc3858d7894fb8e302d259e33ad605294ed`. Vercel deployment `dpl_8oWh1TNVFNbmGissmnvmA11P6ECT` succeeded at 21:28:59 UTC, GitHub Production record `6545922576`. The immutable deployment is [bubaly-hkto1x84l](https://bubaly-hkto1x84l-newworldventure.vercel.app).

Public acceptance matches that exact deployment: login with JavaScript disabled retains disabled credential controls and POST; intercepted native submission contains no credential fields in query or body. Hydrated login/signup/reset are ready, and invalid callback admission is cookie-neutral with private/no-store and no-referrer headers, a clear invalid-link result and clean history. Phone selection/input and return to password login render correctly; an empty number cannot continue. Both scripts report zero page errors, zero failed public assets and no authentication cookies, actions or SMS dispatch. The phone check passes using system CA trust with certificate validation retained. These are public rendering/readiness checks, not production OTP verification or delivery.

Evidence: `Temp/bubaly-phone-production-release-20260919.json`, `Temp/bubaly-auth-initiation-production-acceptance-2a5e7e7a-20260919.log` and `Temp/bubaly-phone-production-readiness-2a5e7e7a-systemca-20260919.log`. Earlier phone smoke diagnostics remain retained; no certificate-validation bypass was used for the passing check.

Exact CI `35470363378` has successful Web, Database and Mobile jobs. Web `105970089770` passes both UTC and DST full runs at 16,703/16,703 tests across 1,305 files, a 252-page build, lint and strict types (`Temp/bubaly-2a5-web-105970089770.log`). E2E `105970089707` fails with **1,293/1,296 passing in 8.3 minutes**. All three new phone HTTP cases fail waiting for the code-entry heading after Continue, before genuine OTP verification. The repaired durable-signout case and six callback HTTP/Mailpit cases pass by exact-source/discovery and the all-other-cases matrix, not individual named success lines. No phone HTTP PASS is claimed. Pinned CLI validation disables SMS signup without a concrete provider, despite the disposable test OTP/hook configuration. The CI-only provider/hook and failure-diagnostic repair is frozen at workflow blobddc304a3fe92dd6bb19d1f601a5299c137a2cfd7 and fixture blobc37916a3b3049d62fc1aab71cac3b966d5583678. Application code, product Supabase configuration and SQL stay unchanged. The two-file CI follow-up passes strict fixture types, lint, all three phone-case discovery, 66 workflow guards, and the exact YAML/Python/TOML rewrite with unrelated fields unchanged, six negative controls and existing-SMS/hook refusal. Logs: Temp/bubaly-phone-ci-repair-{types,lint,discovery,guards,config}-20260919.log. The pinned CLI is not installed in the private verification environment: source/config checks are not a disposable-stack runtime pass. New hosted phone acceptance remains pending. Failed-run evidence: Temp/bubaly-2a5-e2e-105970089707.log; actual /otp status was not captured there.

All 14,038 permanent audit IDs remain. Follow-up SEC-001 discovery executes a desired failing cache-isolation regression, so existing SUPPORT-98FD1D4C44AD (public/sw.js) advances from NOT STARTED to IN PROGRESS. The executed disposable SMS failure/repair also advances existing DEPLOY-B803FCB7F17E (CI workflow): 13,842 NOT STARTED, 192 IN PROGRESS, one FIXED + PASS and three FAIL. Actual worker handlers, Chromium CacheStorage and actual logout show synthetic A image bytes reaching B offline after logout; native worker registration, real Next optimizer and production private content are not tested. This follow-up includes no media privacy repair. AUTH-001/002/003 and SEC-001 remain open; only the existing narrow SEC-005 is closed. Historical production migration failure below remains unresolved. Broader production readiness remains **NO**.

## Native-form follow-up on main 70789485

Main `70789485cd5e8ad00d49c2834e5c2aebf6941679` was verified live on Vercel deployment
`dpl_4e2X1mo4taDXyYNnd38F36DP7M4r`, successful at 20:20:47 UTC, with GitHub
Production record `6545293519`. Its immutable URL is
[the verified deployment](https://bubaly-gqgndu7rm-newworldventure.vercel.app).

The exact deployment identifier matches all three HTML responses in
`Temp/bubaly-native-form-production-70789485.log`. JavaScript-disabled login
renders email, password and submit disabled with method POST. A native submit is
intercepted before dispatch: POST, no credential fields in its query or body.
With JavaScript enabled, all controls become ready. There are zero page errors,
no actual POST delivery and no provider operation. This verifies deployed native
submission without a real credential or account mutation.

Four separate production renders pass for login, signup, reset and denied
callback, with zero Server Action posts or page errors. Six `ERR_ABORTED`
prefetch/script requests occur during navigation. Evidence:
`Temp/bubaly-production-render-70789485.{json,log}`.

## Initial frontend deployment and public checks

Vercel marked deployment `dpl_4pWBho8dManFcsbzy8Z8FDFybTsy` successful at 19:55:32 UTC for that exact main commit. Fresh public `https://www.bubaly.com` HTML identifies the same deployment. The separate GitHub production deployment record belongs to database migrations and is not frontend-success evidence.

Eight read-only HTTP checks pass: home, login, signup, reset, completion and health return 200; unauthenticated meals redirects to login; callback admission redirects to `/auth/complete` with `private, no-store`, `no-referrer` and zero Set-Cookie headers. Core environment, database, auth and service-role health checks remain healthy. Four missing feature settings keep the health response degraded, unchanged from the pre-merge baseline.

A real browser renders login, the email signup path, reset and denied callback completion. All four checks pass with zero unhandled browser exceptions and zero Server Action posts. Observed failed requests are cancelled prefetches (`net::ERR_ABORTED`) during navigation. No real account, recovery email, password or provider mutation is used. Evidence: `C:/Users/Daniel/AppData/Local/Temp/bubaly-production-render-4bee6275.{json,log}`.

The initial public smoke incorrectly expected an email input before selecting the existing signup method. After following that UI, it exposed a test-selector issue: real Next pages include an empty route announcer with `role=alert`, alongside the component's meaningful alert. The two held-callback tests were corrected to select the expected message before asserting its text. That test-only correction later passed hosted acceptance at a70d27c4. Evidence: `Temp/bubaly-admission-alert-{discovery,types,lint}-20260919.log` and `Temp/bubaly-a70-e2e-105958766889.log`.

## Database workflow failure

Automatic production migration run `35465574540` failed while replaying historical `0177_remove_synthetic_auth_users.sql`, with a `family_model_dirty_family_id_fkey` notice and a 120-second statement timeout (`57014`). Its schema and marketing verification steps did not execute. The same failure occurred on prior main ancestor `05a35552` in run `35392709314` on September 18. Package manifest changes triggered this workflow; this release contains no SQL changes.

The retained pre-apply metadata artifact records 192 migration versions through 0176, while the actual catalog contains 444 public tables, 1,002 policies and 102 functions. It is not evidence that all unrecorded migration bodies are absent. The existing 0249 repair addresses a delete-trigger FK path, but normal ordered replay fails at 0177 before reaching it. The available forward-release manifest does not match this database baseline and cannot safely be dispatched unchanged.

0177 has an explicit transaction; cancellation occurs before COMMIT and should abort its ordinary database changes. Post-failure database state and external effects have not been independently verified. No retry, timeout increase, ledger rewrite, SQL edit or direct SQL application was performed. A fresh catalog/ledger check, dependency counts and a reviewed bounded repair are required; deployment of the frontend does not resolve this failure.

Evidence: `Temp/bubaly-production-migrations-35465574540-failed.log` and `Temp/bubaly-production-metadata-35465574540/production-schema-audit.json`. Temp denotes `C:/Users/Daniel/AppData/Local/Temp`.

## Remaining acceptance

Exact earlier a70d27c4 CI `35466125080` completed all four jobs successfully and
passed 1,183/1,183 browser cases with zero failures/skips. All four HTTP callback
cases and the genuine emailed recovery/password-save/logout/new-password-login
journey passed. That is disposable hosted acceptance, not production email delivery.

The new native-form source passes 130 focused browser checks, 122 compatibility
units, scoped lint, a 252-page build and full strict types. Exact source hashes
and earlier reproduction are in [the native cycle](auth-native-form-cycle.md).
Exact 70789485 CI `35466913827` now completes Web, Database, Mobile and E2E
successfully. E2E job `105960830821` passes 1,186/1,186 in 8.1 minutes, with zero
failures/flakes/skips and authenticated/durable flags enabled. The three readiness
and four HTTP callback cases are included, with genuine emailed recovery through
password save, logout and successful new-password sign-in. Passing case names
are inferred from exact source/discovery and the all-pass matrix; the github/dot
reporter does not print individual successes. Web job `105960830743` passes both
16,543-check full unit runs across 1,303 files, build 252, lint and strict types.
Evidence: `Temp/bubaly-707-e2e-105960830821.log` and
`Temp/bubaly-707-web-105960830743.log`.

At the 70789485 checkpoint, only SEC-005 became FIXED + PASS: exact production native credential exclusion
and the repaired source's normal hosted hydrated login both pass. AUTH-001/002/003
and DEPLOY-001 remain IN PROGRESS. All 14,020 IDs and every other status are
preserved at that checkpoint. Frontend deployment and this narrow boundary pass;
broader production readiness remains **NO**. Later initiation and phone/signout
releases have their own evidence above and in the linked cycle records; these
70789485 results do not cover their changed source.
