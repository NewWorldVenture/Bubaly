# Production rollout — 2026-09-19

The user authorized publishing the current changes to main and production. PR 510 merged at 19:50:26 UTC as `4bee627572be77112b1206f4243841df00f9a181`; its direct parents are prior main `57f22c0b` and audited branch `6353d0d4`. The merge and branch share frozen tree `b039b2c08e994037e65b2677c102b7a338a9bbe5`. No SQL or Supabase configuration changed from prior main.

## Native-form follow-up on main 70789485

Main `70789485cd5e8ad00d49c2834e5c2aebf6941679` is live on Vercel deployment
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

Only SEC-005 becomes FIXED + PASS: exact production native credential exclusion
and the repaired source's normal hosted hydrated login both pass. AUTH-001/002/003
and DEPLOY-001 remain IN PROGRESS. All 14,020 IDs and every other status are
preserved. Frontend deployment and this narrow boundary pass; broader production
readiness remains **NO**. Initiation implementation remains a separate unpublished
cycle and is not covered by these hosted results.
