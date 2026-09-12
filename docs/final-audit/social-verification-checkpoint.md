# Rewards and social publishing verification checkpoint

Application source: `6094eb04045326fdd18a1a67785188cc805c2612`. This continues draft [PR #510](https://github.com/NewWorldVenture/Bubaly/pull/510). Complete application auditing and production sign-off remain unfinished.

## Changes verified

- DATA-004: reward balances and actions require verified catalogue and ledger reads; duplicate callbacks are fenced, write errors recover, and successful mutations refresh unpublished tables. Browser execution covers catalog CRUD, request/approve/fulfill/reject and failed readback.
- AUTHZ-002: failed permission or membership reads cannot grant a broader social role. Current active membership is required before private provider access, and clean absent overrides retain the established role defaults.
- SOCIAL-001: X OAuth and text/link publishing now have an implemented encrypted account-token path, replay/owner/family/permission/expiry checks, guarded reconnect/disconnect, bounded provider requests and safe recovery. Eighty execution cases include the real connect action, callback, create-post action, pipeline and X registry against controlled database/provider transport.
- SOCIAL-002: exclusive post and target claims prevent concurrent duplicate sends. Confirmed receipts precede target completion; uncertain sends retain review state. Aggregate status preserves earlier platform success. Studio keeps the existing post identity after a publish attempt and prevents duplicate creation; retry/history copy is honest, including under the actual French locale provider.

## Combined local gates

| Check | Result | Evidence |
| --- | --- | --- |
| Full Vitest suite | PASS | 1,143 files / 12,923 tests, 144.60 seconds with two workers. |
| Final strict TypeScript | PASS | Full no-emit, nonincremental check after the production build, with no diagnostics. |
| Browser regression | PASS | 177 actual Chromium checks, 24.1 seconds: prior 144 auth/cache/lifecycle/display/finance checks plus 21 rewards and 12 social consumer checks. |
| Production build | PASS | 244 generated pages; shared first-load JS 103 kB, middleware 92.5 kB. |
| Full lint | PASS | Four unchanged baseline hook warnings. No suppressions added. |
| Query/schema reference audit | PASS | 484 declared tables, 77 functions, 137 API routes. Not live RLS proof. |
| Translation gate | PASS | Declared gated surfaces are clean; 17 new strings per base catalogue for this cycle. |
| Final-build startup | PASS | Home 2,101 ms; feature navigation 1,675 ms; no page errors. Bounded localhost runner terminated normally. |

Source was copied by git archive into the existing private clean npm-ci installation. Shared dependencies were not modified. The browser run used d8b276db; its complete runtime/test sources are identical to 6094eb04, whose only follow-up change adds two TypeScript Update fields for existing SQL columns. The final full suite, build, strict types and startup use 6094eb04. No SQL, production configuration, live OAuth, social posts, payments or messages were changed by these local checks.

The first combined check caught missing `provider_account_id` Update declarations for social_accounts and social_account_tokens. The columns already exist and are mutable in migration0034; the declarations were aligned without a cast, error suppression or SQL change. The first unconstrained full unit run, concurrent with types/browser work, timed out in six files and produced twelve failures including subsequent state-dependent cases. All 66 tests in those six files then passed in isolation; the complete two-worker rerun passed all 12,923 tests. Test timeouts and assertions were not weakened.

Host evidence is under the temporary directory with prefix `bubaly-social-` and suffix `-20260912.log`: `units`, `units-recheck`, `units-final`, `types`, `types-final`, `components`, `build`, `lint`, `query-audit`, `i18n`, `public-start`, and `public-probe`. Frozen source archive: `bubaly-social-source-20260912.tar`. Discovery hashes and unchanged canonical ID mappings are in discovery/social-rewards-inventory.json.

## CI and deployment provenance

The preceding published source19a6907f passed all four jobs in [run34698217047](https://github.com/NewWorldVenture/Bubaly/actions/runs/34698217047), including 576 disposable Supabase/authenticated browser tests. Its Vercel deployment succeeded, but bounded anonymous probes reached Vercel's authentication gate; deployed Bubaly behavior was not visible. This new source requires its own CI result after publication.

## Remaining scope

AUTHZ-003 remains a critical database policy gap: a restricted member can delete their explicit role and regain the household fallback. Private family media exposure remains open separately. These prevent production sign-off; no SQL was changed. X live account/provider entitlement proof, automatic token refresh, interrupted publication reconciliation, other social platforms/media, scheduling dispatch and full database authorization remain open. Rewards server-side authorization, point reservation and atomic concurrent affordability are not proven by component fixtures.

Next-cycle medication and urgent-delivery reproductions began after this source freeze. They are tracked separately in the master and are not included in this checkpoint's completion claims or test counts. The final second whole-application regression remains NOT STARTED. Production readiness is NO.
