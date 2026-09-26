# Weekly meal planning

Status: IN PROGRESS. Feature record MEAL-001; existing workflow records FLOW-F146172C0036, FLOW-121DB83BE141 and FLOW-7AA5EB472A55 remain permanent.

The requested workflow is: open `/dashboard/meals`, choose a week in the household timezone, pick or replace seven dinners, save a custom dish or select a saved recipe with its ingredients, and add the persisted week's ingredients to the household grocery list. Other meal slots and existing recipe, favorites and grocery features remain available. Each save must have a verified receipt; failed reads and uncertain writes must not appear as empty data or success.

## Discovery before implementation

- The existing screen opens all 28 slots, has no replacement picker for a filled cell, and searches neither saved meals nor recipes in the picker.
- New meals and the AI recipe conversion lose ingredients, so planning a dish does not reliably produce a grocery list.
- Browser-local midnight converted to UTC can shift the saved date; date-only labels also need calendar-day formatting.
- Meal persistence returns empty ingredients and validates counts rather than the exact requested slots. A later deletion failure can leave earlier groups cleared.
- Grocery aggregation drops repeated equal quantities and substring matches. Selected list ownership and exact write receipts need explicit verification.
- Async results must remain attached to their original family, week and open picker. Mobile controls and keyboard access need real component checks.

## Test plan

- Seven household-local days across UTC offsets, DST and year boundaries; localized date labels.
- Saved meals, saved recipes and custom ingredients through server-derived family authorization, exact save/readback, replacement and removal.
- Search, keyboard and mobile interaction, duplicate submissions, errors, retry and family/week/modal changes using the actual React component with controlled transport.
- Grocery quantities, repeated ingredients, substitutions, pantry uncertainty, owned lists and complete receipts.
- Related service/action tests, full units, browser regression, build, strict types, lint, localization and query audits after source freeze.

Fixtures do not establish deployed RLS, physical-device behavior or database transaction atomicity. No new SQL, shared navigation or dependencies are part of the meal implementation.

## Concurrent upstream integration

GitHub could not start pull-request CI for auth publication `644a9cbe` because main advanced to `9719a486` (#513, recurring social ads). The only merge conflict is the expected cron route list; retain both the new marketing-social route and this branch's contact-center/social-publish routes. The incoming SQL migration and admin-local subnavigation are integrated unchanged from main. Two new test harness issues were reproduced: Windows path concatenation and an unintended request-authenticated connector import in pure schedule tests. Fix the path using `path.relative` and make unexpected provider calls throw in the schedule fixture. All five integration suites pass, 176 tests, in the existing private installation. Main's new workflows still require their own complete audit.

## Results

Implementation is published in source `21bbfae1` through checkpoint `68f1a8f5`. Full private gates pass: 14,021 unit tests, 496 controlled browser tests, a 249-page production build, strict types, lint, localization and query audits. The meal suite includes 42 actual-component cases and inspected desktop/mobile layouts. Hosted run34712568165 passed 1,055 browser cases and failed one broad receipt locator in the new real Next/PostgREST meal journey. Real login, recipe/custom writes, replacement, reload and initial grocery amounts passed before that assertion. Test-only follow-up14935e33 narrows the receipt selector and passes lint/discovery/strict types; hosted checkpoint1956a9e0 subsequently passed all1,056 browser cases, including retry equality, selected-slot removal, reload and retained meals. All other hosted gates pass. See `weekly-meal-checkpoint.md` for exact source, test scope, defects, fixes and remaining limits.

The persistent-login integration `674f7a24` passed every hosted check, including 1,013 browser cases and the real child PIN session journey. Production session settings and physical-device acceptance remain separate.
