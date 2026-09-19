# Production rollout — 2026-09-19

The user authorized publishing the current changes to main and production. PR 510 merged at 19:50:26 UTC as `4bee627572be77112b1206f4243841df00f9a181`; its direct parents are prior main `57f22c0b` and audited branch `6353d0d4`. The merge and branch share frozen tree `b039b2c08e994037e65b2677c102b7a338a9bbe5`. No SQL or Supabase configuration changed from prior main.

## Frontend deployment and public checks

Vercel marked deployment `dpl_4pWBho8dManFcsbzy8Z8FDFybTsy` successful at 19:55:32 UTC for that exact main commit. Fresh public `https://www.bubaly.com` HTML identifies the same deployment. The separate GitHub production deployment record belongs to database migrations and is not frontend-success evidence.

Eight read-only HTTP checks pass: home, login, signup, reset, completion and health return 200; unauthenticated meals redirects to login; callback admission redirects to `/auth/complete` with `private, no-store`, `no-referrer` and zero Set-Cookie headers. Core environment, database, auth and service-role health checks remain healthy. Four missing feature settings keep the health response degraded, unchanged from the pre-merge baseline.

A real browser renders login, the email signup path, reset and denied callback completion. All four checks pass with zero unhandled browser exceptions and zero Server Action posts. Observed failed requests are cancelled prefetches (`net::ERR_ABORTED`) during navigation. No real account, recovery email, password or provider mutation is used. Evidence: `C:/Users/Daniel/AppData/Local/Temp/bubaly-production-render-4bee6275.{json,log}`.

The initial public smoke incorrectly expected an email input before selecting the existing signup method. After following that UI, it exposed a test-selector issue: real Next pages include an empty route announcer with `role=alert`, alongside the component's meaningful alert. The two new held-callback tests now select the expected message before asserting its text. No application code changes. Four-test discovery, scoped strict types, lint and whitespace pass; hosted execution of the corrected selectors remains pending. Evidence: `Temp/bubaly-admission-alert-{discovery,types,lint}-20260919.log`.

## Database workflow failure

Automatic production migration run `35465574540` failed while replaying historical `0177_remove_synthetic_auth_users.sql`, with a `family_model_dirty_family_id_fkey` notice and a 120-second statement timeout (`57014`). Its schema and marketing verification steps did not execute. The same failure occurred on prior main ancestor `05a35552` in run `35392709314` on September 18. Package manifest changes triggered this workflow; this release contains no SQL changes.

The retained pre-apply metadata artifact records 192 migration versions through 0176, while the actual catalog contains 444 public tables, 1,002 policies and 102 functions. It is not evidence that all unrecorded migration bodies are absent. The existing 0249 repair addresses a delete-trigger FK path, but normal ordered replay fails at 0177 before reaching it. The available forward-release manifest does not match this database baseline and cannot safely be dispatched unchanged.

0177 has an explicit transaction; cancellation occurs before COMMIT and should abort its ordinary database changes. Post-failure database state and external effects have not been independently verified. No retry, timeout increase, ledger rewrite, SQL edit or direct SQL application was performed. A fresh catalog/ledger check, dependency counts and a reviewed bounded repair are required; deployment of the frontend does not resolve this failure.

Evidence: `Temp/bubaly-production-migrations-35465574540-failed.log` and `Temp/bubaly-production-metadata-35465574540/production-schema-audit.json`. Temp denotes `C:/Users/Daniel/AppData/Local/Temp`.

## Remaining acceptance

The application source retains the local full UTC/DST 16,543-test results, build252, strict types, lint and focused evidence in the admission-witness cycle. Published dc99 baseline hosted checks passed all 1,150 browser tests. New main CI `35465574530` and PR-head CI `35465566214` are tracked separately; at this checkpoint both main unit steps pass and the new browser workflow is still running. No real emailed recovery completion is claimed from discovery or public rendering.

AUTH-001/002/003 and DEPLOY-001 remain IN PROGRESS; audit counts and permanent IDs are unchanged. Production frontend deployment is complete, while the broader production audit remains **PRODUCTION READY: NO**.
