# Password and child login verification checkpoint

Application source: `16f0f41c33eab1dc5f54ff22743606ed5312c3c7`. The implementation and initial delayed-password reproduction are documented in `password-adoption-cycle.md`.

Password and child PIN login now capture browser ownership before waiting for provider or server responses. The isolated SDK cannot adopt after an intervening login, explicit logout, unmount, method change or timeout. Adoption requires consistent session/JWT data and verified persistent-cookie writes. Pending PKCE verifiers remain intact. Returned child tokens stay bound to their authorized user and, when supplied, session ID through public SDK verification or renewal; mixing an expired A access token with another user's or session's refresh token cannot publish that replacement.

Both forms prevent duplicate submissions and require a current session before navigation. Modified link clicks that open another tab leave the original attempt active. Clicking padding or a disabled OAuth control does not retire the password operation. The child server action preserves throttle checks, uses a disposable client, returns only the authorized token pair, and does not write authentication cookies. The exact child Server Action POST avoids ambient middleware refresh.

## Frozen source gates

Git archive exported the source into the existing private clean installation. No tracked files had been deleted from the prior archived source, and package/lockfile contents were unchanged. With Node 24.21.0 and synthetic provider configuration, the independent unit, browser and build lanes ran concurrently. No installation or local preview startup occurred.

| Gate | Result |
|---|---|
| Full unit suite | PASS: 1,174 files / 13,810 tests in 52.94 seconds, eight workers |
| Controlled Chromium regression | PASS: 454 checks across 20 suites in 51.4 seconds, four workers |
| Production build | PASS: 248 generated pages; compile 53 seconds; shared initial JavaScript 103 kB |
| Strict post-build TypeScript | PASS: no emit, incremental disabled |
| Full lint | PASS: four unchanged baseline warnings |
| Localization and query audits | PASS: 484 tables, 77 functions, 139 API routes |
| Disposable Auth test discovery | PASS: five tests discovered; the new child workflow awaits hosted execution |

The 454-case browser regression includes 32 helper ownership cases, 31 password-form cases and 17 child-form cases. These exercise actual React/public SDK code with controlled transport, including bad receipts, account replacement, empty-slot logout, delayed final writes, timeout disposal, token-pair mismatch, explicit retry and fallback session reconciliation. Child server tests separately exercise the actual action and installed SDK against controlled provider and database boundaries.

Logs: `Temp/bubaly-password-private-<gate>-20260912.log`. Runners: `bubaly-password-unit-gate-20260912.ps1`, `bubaly-password-browser-gate-20260912.ps1` and `bubaly-password-build-gates-20260912.ps1`. Archive: `Temp/bubaly-password-source-20260912.tar`, SHA-256 `4431F68506D8774314D7A138907FF2DACF4C7EE24FDFBE9CDE04E1C817186A21`. The compiled build-info route contains the exact application revision. Package and lockfile hashes remain `B250169455D554EB0CF2603F0E158ED3D33D22327B630319E7DAB3A034A10764` and `58EB5FA3A0EA179B52B37CA5B457778A330A38FBFFE859EB8CA767941EAA4569`.

## Hosted evidence and next acceptance

Published predecessor `980561ff` passed all hosted jobs, including E2E run `34710377277`, job `103597946411`: 932 checks passed in 6.7 minutes, completed 2026-09-12 at 18:24:13 UTC. That run verifies the logout changes and four existing real disposable GoTrue journeys. It does not verify this later password source.

The fifth disposable journey uses the real child form and server action, verifies a persisted child identity, reopens only persistent cookies, performs real renewal, confirms logout through the visible confirmation dialog and waits for provider revocation. It then renews the child's separate device and parent's account to prove local logout preserved them. Only the CI job receives a synthetic child secret. Setup refuses non-loopback providers, owns unique Auth/REST data, keeps PINs/tokens out of assertions and artifacts, and cleans its own records. Current-source hosted execution remains pending publication.

Discovery adds 14 non-audit changed files: five production files, eight test files and CI configuration; six files and three exported functions are new. No routes, locales, SQL, shared navigation or dependencies changed. Exact committed source hashes are in `discovery/password-adoption-inventory.json`.

Production session policy, physical mobile reopening, production child configuration and the new hosted child journey remain unverified. Multi-cookie writes cannot be atomic: partial storage rejection is reported without unsafe restoration. Ordinary OAuth/phone adoption and unrelated server cookie responses remain separate audit obligations. AUTH-002 stays IN PROGRESS and the whole-application release gate remains NO. The user's next requested implementation is an easier weekly meal planner.

Automatic approval review previously blocked local preview startup with only “blocked by policy.” No alternative launch was attempted. Controlled fixture results are not production acceptance.
