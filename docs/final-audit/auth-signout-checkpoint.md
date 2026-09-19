# Persistent login and explicit logout verification checkpoint

Application code is pinned to `44811fb61c750a95d048be4998b4197fc357dce4`. Follow-up `c4d4ea1eda5eebd7c2ec0f24816cf5e019ef9895` changes only the explicit type of the cross-origin header table in `tests/signout-bridge.test.ts`; it does not change application code. Discovery is pinned to that follow-up. The implementation and focused race reproductions are described in `auth-signout-cycle.md`.

Six web controls now clear the intended local session synchronously, then request revocation of its exact token. Delayed success, rejection or network failure cannot clear or redirect a replacement login. A changed account requires a new explicit decision. The ordinary browser storage adapter fences old renewal success and old rejection cleanup; its public process lock also prevents an overlapping caller from hanging after rejected cleanup. Token-free tab notifications force fresh session and cache reconciliation.

The compatibility POST sends no authentication-cookie writes. Its short-lived receipt binds browser completion to the submitted session, and both logout paths avoid middleware refresh. JavaScript is required for conditional local completion. Ordinary hydrated controls clear immediately. A denied storage read or failed deletion reports an unavailable outcome rather than pretending logout succeeded.

## Frozen gates

Git archive exported the application checkpoint to the existing private clean installation. No tracked files were removed from the previously archived source, and dependencies were unchanged. Node 24.21.0 ran with synthetic provider configuration. The later test-only correction was copied into that installation and verified byte-for-byte before resuming the remaining gates.

| Gate | Result |
|---|---|
| Full unit suite at application checkpoint | PASS: 1,172 files / 13,761 tests, 124.94 seconds |
| Production build at application checkpoint | PASS: 248 generated pages, compile 46 seconds, shared initial JavaScript 103 kB, middleware 92.6 kB |
| Corrected route test at follow-up | PASS: 21 tests, 348 ms |
| Strict post-build TypeScript at follow-up | PASS: no emit, incremental disabled |
| Full lint | PASS: four unchanged baseline warnings |
| Localization and query audits | PASS: 484 tables, 77 functions, 139 API routes |
| Seventeen controlled Chromium suites | PASS: 374 checks in 58.5 seconds |

The initial type gate found an inferred optional `undefined` header value in the test table. Its explicit `Record<string, string>[]` annotation fixes the fixture without changing cases or assertions. The complete unit suite and production build were not repeated for that type-only test edit. Hosted checks will run the complete current-source matrix.

The archived application source is `Temp/bubaly-signout-source-20260912.tar`, SHA-256 `CC61F04F1139CC82299762D8E5A27F49777D84B85C902EBCE83FE1C02227977D`. Package and lockfile SHA-256 values remain `B250169455D554EB0CF2603F0E158ED3D33D22327B630319E7DAB3A034A10764` and `58EB5FA3A0EA179B52B37CA5B457778A330A38FBFFE859EB8CA767941EAA4569`. The compiled build-info route contains the exact application revision. Private logs use `Temp/bubaly-signout-private-<gate>-20260912.log`; the two runners are `bubaly-signout-gates-20260912.ps1` and `bubaly-signout-remaining-gates-20260912.ps1`.

## Discovery and hosted evidence

The source delta contains 48 non-audit files: 19 production files, 22 test files and seven locale catalogues; 16 files and 16 exported functions are new. The new page is `/auth/signout/complete`. Three new review/completion controls have permanent audit records. `discovery/auth-signout-locales.json` verifies all 13,556 previous entries, values and their order in each base catalogue, with exactly five appended keys per locale.

Prior published `e0abcbeb` completed hosted quality, database, mobile, finance and Vercel checks. E2E job `103593845774` passed 861 checks in 4.9 minutes, including disposable Auth journeys; one external Wikimedia image HTTP 429 remains in its log. Those results establish the earlier recovery/signup checkpoint. The logout source was subsequently published as980561ff: all hosted jobs PASS, including932 E2E checks in6.7 minutes in run34710377277. The later password cycle is recorded in password-adoption-checkpoint.md.

## Remaining acceptance

The production project's time-box, inactivity and single-session settings have not been inspected. The exact required Supabase configuration is documented in `docs/runbooks/persistent-sessions.md`; these are not Vercel environment variables. Physical mobile reopen, production revocation and the complete new hosted logout journey remain unverified. Local browser tests use controlled transport and do not substitute for those boundaries.

Cookie comparison is not atomic across browser processes, and unrelated server responses may still carry stale cookie writes. Auxiliary verifier removal from an already delivered ordinary SDK operation remains outside this fence. AUTH-002 stays IN PROGRESS. The broader audit retains public family-media storage and restrictive social-role DELETE policy failures, and the second whole-application regression has not started. SQL, shared navigation and dependencies are unchanged.

Automatic approval review previously blocked local preview startup with only “blocked by policy.” No alternative launch was attempted. Controlled Chromium fixtures intercept requests; hosted disposable Auth verification remains a separate gate.
