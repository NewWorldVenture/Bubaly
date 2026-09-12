# Weekly meal planning checkpoint

Application source and full private gates: `21bbfae1b3fdba8c6ca8520826edfff674df3dca`. Test-only follow-up: `14935e3309ed3af5dac9c974037a0c932c2bf383`. The implementation starts at `669c521d`; the final change rejects duplicate rows for a single meal slot. Main is integrated through `9719a486` in merge `674f7a24`.

## Family workflow

`/dashboard/meals` opens seven dinner cards in the household's Monday-to-Sunday week. Families can change weeks, choose or replace saved meals and recipes, or enter a custom dish with ingredient amounts and units in the selected day. An optional view includes breakfast, lunch and snacks. Existing slots remain intact when changing views.

Successful saves require server-derived family scope, the requested persisted slot and a matching refreshed screen. Confirmed saves that cannot reload retain their receipt and offer a read-only retry. Closing a dialog or changing households/weeks retires its pending result. The library-only creation and AI planning paths have the same pending/readback safeguards. A conflicting second row for one date/type prevents success confirmation.

The grocery action reads persisted dishes, preserves both recipe ingredient dialects, and retains repeated quantities and fractions. Full ingredient requirements are included by default. Families can explicitly choose to skip pantry ingredients; existing service callers retain their prior pantry behavior. Allergy and preference checks remain active. Missing ingredients/read failures produce an error; unavailable data cannot become a successful empty list. Existing unchecked grocery items are reported as already present, rather than silently increasing their amounts on retries.

AI planning uses the same meal service and exact sparse-slot replacement. Saved recipes retain their ingredients and source URL; bounded generated ingredients are preserved when provided. The response carries the verified saved slots, and the screen compares those slots after refresh. Different date/type combinations are not deleted as a rectangle.

## Reproduced defects and fixes

- Same-name recipes/custom meals no longer discard differing ingredient/source intent. Matching variants can be reused on retry without modifying the other variant.
- Exact row/ingredient receipts replace count-only confirmation. Replacement deletes only captured prior IDs, detects concurrent rows and restores previous rows only into still-empty slots when a later operation fails.
- Repeated ingredient quantities survive both initial aggregation and convergent substitutions: `1 cup + 1 cup` remains two requirements; `12 oz` does not absorb `2 oz`.
- Date keys and labels avoid browser-local/UTC shifts and preserve the household week across DST, midnight and year changes.
- Actual browser tests reproduced dialog focus theft and duplicate-row false success. Removing initial autofocus preserves the triggering control; exact-one-slot verification rejects ambiguous readback.
- The first full unit run passed 14,020 cases and found one stale service-fork exception. Removing `meals` from the remaining-forks list and adding it to the zero-browser-write assertion repairs the test's inventory claim; the focused five-case suite passes.

## Verification

Final frozen unit and combined browser gates pass in the existing private installation under Node 24.21.0: 1,178 files / 14,021 unit tests in 52.47 seconds with eight workers, and 496 Chromium cases across 21 suites in 1.1 minutes with four workers. The final source builds 249 pages (60-second compile) and passes strict post-build types, lint, localization and query audits. Four baseline lint warnings remain; the query audit resolves 486 tables, 77 functions and 140 API routes. The compiled build-info route contains the exact `21bbfae1` revision. No dependency installation or local preview startup was performed. Frozen archive SHA-256: `437423518557CDD31A8F0BFDC238642558EE37FA837E014C9CF06EE242147BF2`. Logs: `Temp/bubaly-meal-final-private-<gate>-20260912.log`.

The bounded meal browser suite passes 42 cases in 18.4 seconds with actual React, query hooks, inputs, Modal, icons and application CSS under controlled transport. It covers manual/AI/library saves, ingredient forms, searches, replacement/removal, retries, malformed receipts, duplicate callbacks, family/week/modal retirement, concurrent rows, keyboard focus and touch. Desktop and 390-pixel mobile screenshots were inspected; 280/320-pixel overflow checks pass. The screenshots do not include the authenticated Next shell or a real backend.

`tests/e2e/weekly-meal-durable.spec.ts` adds one hosted disposable-backend phone journey. It signs in through the real password form, saves a recipe, replaces another dinner with a custom dish, reloads, verifies persisted ingredients and exact grocery amounts, retries without duplicate additions, removes only one selected slot and verifies the remaining records. It refuses remote origins, creates only its own Auth/REST fixtures, disables credential-bearing artifacts and cleans its own family/account. Discovery, lint and strict types pass. Hosted checkpoint `68f1a8f5` ran the test in CI `34712568165`, E2E job `103603871709`. The run completed at 2026-09-12 19:08:10 UTC with 1,055 passing cases and one failure in 7.4 minutes. Both meal attempts reached real login, recipe/custom saves, replacement, reload and exact initial grocery amounts, then a broad text selector matched both the receipt list item and toast container. Follow-up `14935e33` scopes the assertion to the exact list item; lint, discovery and strict types pass. Grocery retry equality and removal assertions after the failed locator still require successful hosted execution. Other hosted quality, database, mobile, finance and Vercel checks pass. Current CI does not silently skip this journey: the workflow supplies the durable-session flag, the runner propagates it and missing or non-local backend configuration fails explicitly.

Seven base catalogues preserve every prior 13,561 entry, value and order and append 37 translated messages. Regional overlays inherit their base catalogues. Package and lockfile contents are unchanged. Incoming SQL and admin-local subnavigation match main byte-for-byte; the meal implementation authors no SQL or shared navigation changes.

## Persistent-login hosted acceptance

The auth integration commit `674f7a241e116f0961f6d2f04f16f59a01ac8878` passed all hosted checks. CI run `34711793751`, E2E job `103601761830`, passed 1,013 browser tests in 5.6 minutes at 2026-09-12 18:49:45 UTC. This includes all five real disposable Auth journeys, including child PIN login, persistent-cookie reopening, renewal and local logout that preserves another child device and the parent account. Quality, database, mobile, finance and Vercel also pass. Production Supabase session settings and physical-device reopening remain separate verification obligations.

The application preview for `68f1a8f5` deployed successfully: [weekly meal planner](https://bubaly-l1mmgypq0-newworldventure.vercel.app/dashboard/meals). Deployment success is separate from complete workflow acceptance.

## Remaining scope

No database uniqueness or transaction migration is introduced. Compensating writes cannot guarantee atomic concurrent weekly replacement; detected conflicts fail visibly and preserve another editor's row where possible. Existing grocery items are deduplicated and reported, not recalculated from all previous plans. Pantry skipping means excluding stocked names, not measuring whether inventory covers every quantity. Newly generated dishes without ingredient data must have ingredients added before grocery creation. Real external AI behavior, physical devices and all recipe/voting/nutrition subfeatures remain separate audit obligations.

MEAL-001 and AUTH-002 remain IN PROGRESS. The broader audit still has public family-media storage and the restrictive social-role DELETE policy release failures; the second whole-application regression has not started. Production readiness is NO.

Automatic approval review previously blocked local preview startup with only “blocked by policy.” Hosted disposable-backend acceptance is used without attempting another local launch.
