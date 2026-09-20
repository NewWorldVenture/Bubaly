# Request-time callback ownership witness

2026-09-19. Published baseline:
`dc99dc83976e7b3d6270e51dcaf44060a7423d7c`.
Existing records **AUTH-001, AUTH-002 and AUTH-003 remain IN PROGRESS**.
The application repair passes independent review and required local gates.
The final hosted fixture and disposable CI setup pass discovery/types/lint but
have not executed. Complete audit readiness remains **NO**.

The [browser adoption cycle](auth-callback-browser-ownership-cycle.md) fences
state changes after completion mounts. Its browser initially captures ownership
at mount time. A callback GET response held across logout or a newer login can
therefore arrive with an old code while completion captures the newer browser
state. Two installed-SDK desired regressions now reproduce that boundary: capture
request cookies, then explicitly log out with verifier deletion refused or sign
in as a newer user before completion captures its owner. The old flow adopted
the old account in both cases. The repair checks the original request witness
before the same actual adoption path.

## Intended bounded contract

Capture a comparison witness from the original callback request's cookies. Carry
that same witness through neutral admission and completion; compare it with the
browser before exchange, fallback or adoption. A direct completion request may
capture its own original request state only when no witness was supplied. A
supplied malformed, duplicate or incompatible witness must never trigger
recapture from newer state. Both callback GET and completion preserve an already
supplied canonical witness; routing it through callback GET does not reissue it.

The bounded witness hashes configured-project verifier state, logout generation
and starting session ownership. Stable user/session identity permits ordinary
token rotation; identity-less or malformed session state requires exact bytes.
Provider verification remains authentication authority. The witness must not
publish raw verifier, token, email or user/session identifiers in URL, HTML,
history or diagnostic text. Hashing and asynchronous comparison need the same
ownership checks as other delayed work. The current comparison-only format has
no timestamp: unchanged-owner age alone does not invalidate the witness. Provider
code/token expiry and the existing mounted-operation deadline remain separate
controls; no new witness-expiration guarantee is claimed.

The installed SDK's whole-header parser collapses duplicate cookie names. The
shared admission parser parses bounded individual cookie segments so duplicate
configured-project cookies reach the rejection checks. Direct page capture uses
the original raw request header, started before awaiting query admission, rather
than a cookie map that would discard this ambiguity. Both entrypoints remain
cookie-neutral and perform no provider operation.

This witness describes request admission, not initiation. It does not establish
which browser attempt originally requested a provider link, turn cookie reads
and writes into a cross-tab transaction, or prevent intentional fresh navigation
after state changes. Those scopes remain separate audit obligations.

## Evidence status

- Browser helper ownership: **2/2 desired RED** against the old path in
  `Temp/bubaly-admission-browser-red-20260919.log`; **79/79 PASS**, including 17
  new cases, in `Temp/bubaly-admission-browser-green-20260919.log`. These use the
  installed SDK and mandatory production witness assertion, including mutations
  during hashing and ordinary same-session rotation. They also retain a passing
  characterization that a request first sent after logout beside an uncleared
  verifier is admissible; this does not close initiation ownership.
  Two additional actual browser path-duplicate cases first fail in
  `Temp/bubaly-admission-duplicates-red-20260919.log`, then the final ownership
  suite passes **81/81** in `Temp/bubaly-admission-duplicates-green-20260919.log`.
  Both real cookie paths are present before the assertion; no mocked cookie
  getter conceals the original ambiguity.
- Server admission/page: **12 desired RED** against dc99dc83 in
  `Temp/bubaly-admission-witness-before-20260919.log`; initial witness/middleware
  gate **33/33 PASS** in `Temp/bubaly-admission-witness-after-20260919.log`.
  Expanded final server/routing/middleware gate passes **147/147 across seven
  files** in `Temp/bubaly-admission-witness-combined-20260919.log`, including 24
  witness admission cases. Duplicate collapse first reproduced two failures
  before the shared parser correction. This combined gate overlaps the smaller
  runs; it is not an additional 147 distinct cases.
- Selection/routing compatibility: **35/35 PASS** in
  `Temp/bubaly-admission-routing-20260919.log`, scoped lint/whitespace clean.
  The middleware-only mock retains the real installed SSR parsing exports.
- Actual completion UI request-to-mount execution: **2 desired RED**, then
  **36/36 PASS**, in `Temp/bubaly-admission-ui-{red,green}-20260919.log`. The final
  completion/recovery run passes **82/82** (44 + 38), including mandatory
  malformed-witness, no-code pre-mount logout/new-login, recovery and ordinary
  token-rotation controls, in `Temp/bubaly-admission-ui-final-20260919.log`.
- Final shared/server/page gate passes **77/77** (24 pure contract, 24 admission,
  29 page cases) in `Temp/bubaly-admission-shared-server-20260919.log`. This overlaps
  the earlier server/routing matrix.
- Shared parser/hash, provider expiry boundaries, duplicate input, metadata disclosure, fallback and
  same-session rotation controls: review and tests in progress.
- Full UTC and DST each pass **16,543/16,543 across 1,303 files**, zero failures or
  skips. Reports: `Temp/bubaly-admission-full-{utc,dst}-20260919.json`.
  Frozen application build passes **252 pages**, strict types pass, lint retains
  three existing warnings, and localization/query checks pass (491 tables,
  86 functions, 146 routes). Logs:
  `Temp/bubaly-admission-{build,types,lint}-20260919.log`.
- New hosted execution remains pending. Local application/unit gates do not
  execute the new HTTP fixture or its later test-environment refinements.

Application source is frozen at `ee0038989221edfaf148150f6e1dc28301f7f6bf`.
Six changed production files are pinned by the
[compact inventory](discovery/auth-callback-admission-witness-inventory.json).
Final test/infrastructure tree `d0adca170e65ca15ce48d678ce1d6ac1b2273ef6` pins the
four-case HTTP fixture (Git blob `f5d8c07e8717d0c291348cf50433dcfd1808f343`) and CI
redirect setup. All six application files remain unchanged. Three cases hold the
real callback redirect across logout or a newer login, reject stale completion
before a Next action, and preserve a login through an invalid-code control. The
fourth drives the production reset-email form, exact owned-recipient Mailpit
lookup, provider verification, callback/action/adoption, password save and
logout/new-password sign-in. **Four cases are discovered, typechecked and linted;
none was executed locally.** Logs:
`Temp/bubaly-admission-email-{discovery,types,lint}-20260919.log`.

The CI workflow alters only the disposable Auth site URL and redirect allowlist
to localhost:3107 before starting its local server. Product
`supabase/config.toml` and SQL are unchanged. The extracted setup was dry-run
checked for exactly those two changed fields and refusal on unexpected drift.
Workflow guards pass **66/66 across seven files** in
`Temp/bubaly-admission-ci-guards-20260919.log`. Final Playwright discovery lists
**1,183 tests across 49 files** in
`Temp/bubaly-admission-final-discovery-20260919.log`. Discovery is not acceptance;
successful hosted Mailpit/PKCE completion and production delivery remain unproven.

`Temp/` means `C:/Users/Daniel/AppData/Local/Temp/`. Focused helper, route and
browser results have different scopes and may overlap in later combined runs.

## Published baseline CI

CI `35464679043` and Finance `35464679048` target exactly `dc99dc83`.
Finance is terminal SUCCESS with 66 explicit `0274 PASS` notices in
`C:/Users/Daniel/AppData/Local/Temp/bubaly-finance-35464679048.log`. Mobile is
SUCCESS. Database subsequently completed 330 migrations, 38/38 probes and 327
existing-schema reapplications in
`C:/Users/Daniel/AppData/Local/Temp/bubaly-database-35464679043.log`. Web is also
SUCCESS: UTC/DST each 16,495/16,495 across 1,301 files, build252 and strict types,
in `Temp/bubaly-web-35464679043.log`. CI checks out merge
`344b38b6d3db61db6716cb6c65ece780df62776b`, whose tree
`d41ed6fa72de428b50a1ea592db9eca57ab7d445` equals published dc99dc83. E2E is terminal
SUCCESS: **1,150/1,150 PASS**, 7.7 minutes, authenticated and durable flags both `1`,
in `Temp/bubaly-e2e-35464679043.log`. All baseline gates are green.
These baseline runs cannot verify this new admission-witness source.

## Permanent records

The existing 14,006 IDs and statuses are preserved. This cycle uses AUTH-001,
AUTH-002 and AUTH-003 for workflow evidence. Twelve new NOT STARTED structural
obligations cover two witness modules, seven exported helpers, two new unit-test
files and the hosted fixture. The inventory pins 15 changed files: six production,
eight test and one existing CI support file, including five new files. CI retains
DEPLOY-B803FCB7F17E. The master contains 14,018 IDs:
13,829 NOT STARTED, 186 IN PROGRESS and three FAIL, with zero PASS, FIXED + PASS or
BLOCKED. Its 0.00% measures fully verified audit records, not product completion.
