# Authentication cookie verification checkpoint

Subsequent logout repairs and their verification are recorded in `auth-signout-cycle.md` and `auth-signout-checkpoint.md`. The statements below describe the earlier source checkpoint.

Application source: `effe6a2edddba707d2bbc5b11cd790071080822a`. This combines the recovery/signup cookie repairs in `33e11d07` with incoming main `d8cd6be1`. The only merge conflict was the locale catalogue test: both branches had replaced costly per-key assertions with complete batched validation. The merged test retains all-key checking and bounded failure output.

The hosted quality run for prior published head `4915cc63` failed eight newly added upstream signup tests. Their direct-component React fixture did not implement the form's current `useMemo`/`useLayoutEffect` hooks. Its receipt, auxiliary-promise and provider-error stubs also predated current contracts. The fixture now models those contracts and asserts an honest uncertain outcome after a lost network response. The duplicate-email anti-enumeration test and validation assertions remain. Seven related suites passed 196 tests before source freeze.

Recovery actions now read a candidate from the exact project cookie without refreshing it or queuing authentication cookies. Cryptographic and provider verification still determine authority. The recovery callback stages SDK cookie changes until the returned token passes recovery verification. Exact public recovery middleware paths skip ambient refresh. Thirteen new actual middleware cases cover those exemptions, ordinary refresh controls and misplaced-code forwarding; four related suites passed 97 tests. See `auth-recovery-cookie-cycle.md` for the 254 focused server/action/callback checks and their limits.

An isolated signup operation preserves its own verifier after uncertain responses and fences session adoption against current form and cookie ownership. The actual SDK/Chromium matrix contains 46 cases. See `signup-verifier-cycle.md` for verified behavior and the remaining later-singleton-refresh limitation. Two independent source reviews found no additional actionable defects in these repairs; review is not a substitute for execution.

## Frozen source gates

The source was exported using Git archive into the existing private clean installation. No tracked files were deleted between the previous archived `bc22dbc9` and this source; the overlay therefore contains the complete new source without stale removed paths. No packages were installed or changed. Node 24.21.0 runs each gate with synthetic reserved-invalid provider configuration and no real account operations.

| Gate | Result |
|---|---|
| Complete unit suite | PASS: 1,168 files / 13,679 tests, 123.92 seconds |
| Production build | PASS: 247 generated pages; compile 43 seconds; 103 kB shared initial JavaScript |
| Post-build strict TypeScript | PASS: no emit, incremental disabled |
| Full lint | PASS: four unchanged baseline warnings |
| Localization and query audits | PASS: all declared locale surfaces; 484 tables, 77 functions, 139 API routes |
| Five controlled Chromium suites | PASS: 107 checks in 17.7 seconds |

Private logs use `Temp/bubaly-auth-cookie-private-<gate>-20260912.log`. The runner is `Temp/bubaly-auth-cookie-gates-20260912.ps1`. The archived source is `Temp/bubaly-auth-cookie-source-20260912.tar`, SHA-256 `960B8013C02847DA624885285C79F4A1AB5637EEDF6C76FCB13740C4194E0E51`. Unchanged package and lockfile SHA-256 values are `B250169455D554EB0CF2603F0E158ED3D33D22327B630319E7DAB3A034A10764` and `58EB5FA3A0EA179B52B37CA5B457778A330A38FBFFE859EB8CA767941EAA4569`. The compiled build-info route contains the exact `effe6a2e` source revision. The source gate completed with exit zero; the subsequent audit-only follow-up does not change application code.

## Hosted evidence and remaining work

Prior published head `4915cc63` passed database, mobile, finance and Vercel checks. Its E2E job `103590978050` completed with 836 passed browser checks in 6.2 minutes, including disposable Auth journeys. The browser log also contains an external Wikimedia image HTTP 429. The quality job's separate upstream fixture failure is described above; the old hosted results do not verify the new cookie repairs. Current-source hosted checks are pending publication.

The source discovery delta covers 23 non-audit files: nine production and fourteen test files, eight new files, six new exported functions and five upstream-retired onboarding action exports. Permanent audit IDs for retired functions are retained. The new source inventory does not pass any whole product workflow.

Production session time-box, inactivity and single-session policy, actual recovery email delivery and physical mobile reopen remain unverified. AUTH-L06 delayed sign-out deletion remains open; see `auth-signout-race-plan.md`. A later ordinary singleton refresh can still remove a pending signup verifier. Server responses and other browser processes do not participate in an atomic cookie transaction. This checkpoint does not complete the full audit or final regression.

Automatic approval review previously rejected local preview startup with only “blocked by policy.” No alternative launch was attempted in this cycle. Controlled Chromium fixtures intercept all requests and do not constitute local or deployed application startup verification.
