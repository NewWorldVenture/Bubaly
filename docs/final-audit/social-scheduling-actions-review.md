# SOCIAL-003 independent action boundary review

Scope: actual `createPostAction` and `retryPublishAction`, schedule-time validation, target creation, and post-detail rendering. This lane owns only this report and `tests/social-scheduling-actions-review.test.ts`. Root owns application fixes; the operations lane owns the private schedule authority, worker, token and provider integration.

## Execution method

The new tests run real action modules with the existing `InMemorySupabase` query fixture, actual time helpers and actual `createTargets`. Private receipt creation/arming and manual publishing are controlled seams; receipt and provider authority are independently exercised in `tests/social-scheduled-publish.test.ts`. Auth/request context, translation and external operations are synthetic. Mutations can commit to the fixture before a malformed receipt or transport rejection is returned. The fixture does not implement PostgreSQL foreign-key cascades, transactions or RLS. Cleanup assertions prove only the parent action's checked behavior, not real database cascade execution.

The post page is actually rendered through React `renderToStaticMarkup`, including posts and targets seeded directly into storage. An unsafe `javascript:` anchor was proven in generated markup; no browser script-execution claim is made.

Run with the isolated official Node 24 runtime on PATH:

```powershell
$env:PATH = 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0;' + $env:PATH
node node_modules/vitest/vitest.mjs run tests/social-scheduling-actions-review.test.ts --reporter=dot --maxWorkers=1
```

## Reproduced boundaries and coordinated fixes

1. **Unsafe stored links (SEC-004, root-owned fix).** A draft with `javascript:alert(document.domain)` was persisted, and the actual post page rendered it as a clickable anchor. Scheduled input also omitted protocol and 4,096-character link validation. The action now validates the URL, and rendering independently fences unsafe legacy/direct-database post and target links. Three direct-storage cases (`javascript:`, `data:`, protocol-relative URL) pass after the root patch. This is a rendering boundary; existing X provider validation already rejected unsupported publishing URLs.
2. **Scheduled input and write receipts (SOCIAL-003).** An unknown submitted platform was filtered away before validation and the action proceeded with X. Malformed schedule/calendar ID receipts reached the controlled private seam. Root added raw-platform rejection and strict UUID/cardinality receipts. The original eight action assertions now pass. Those receipt cases are action hardening: they do not prove that the real private snapshot validator would arm a malformed schedule.
3. **Initial create uncertainty and cleanup (root-owned fix).** A post insert that committed but returned null or threw produced an ordinary editable error without retained review state. Idless/invalid receipts could even return success, directly proven for draft creation. Failed cleanup discarded known post identity; a thrown cleanup escaped the action catch entirely. The additive `reviewRequired?: boolean` result now retains the known post ID when possible and prevents a blind whole-create repeat after uncertainty. Cleanup requires exactly one matching deleted ID. A definitive SQLSTATE 42501 rejection remains an editable failure with no invented saved identity.
4. **Scheduled content must be publishable by the existing X adapter (root-owned fix).** Four additional action cases reproduced a queued success for content the actual provider adapter would reject: 281-character text, 257-character body plus newline and a weighted link, empty payload with only a title, and link-kind content without a link. The pre-write guard now validates the same assembled body/link payload and current `effectiveLength` rules as `providers/x.ts`. Exact 280-character text, 256-character body plus weighted link, and a longer embedded URL that still fits the existing weighting remain accepted. This checks consistency with the repository's existing counter; it is not new proof of complete provider Unicode counting.

Final focused result on 2026-09-12: **75/75 action/render review cases passed; seven related files passed 313 tests; scoped ESLint passed.** Initial review reproduced eight failures, expanded initial-write coverage reproduced 14 failures, and the assembled-content extension reproduced four failures before the corresponding root repairs. The review test and this report are frozen; root owns final repository gates and source pinning.

```powershell
node node_modules/vitest/vitest.mjs run tests/social-scheduling-actions-review.test.ts tests/social-scheduled-publish.test.ts tests/social-schedule-time.test.ts tests/social-scheduling-presentation.test.ts tests/social-publish-execution.test.ts tests/social-publish-persistence.test.ts tests/social-x-execution.test.ts --reporter=dot --maxWorkers=1
node node_modules/eslint/bin/eslint.js tests/social-scheduling-actions-review.test.ts
```

Verified working-source SHA-256 at that run:

| File | SHA-256 |
| --- | --- |
| `tests/social-scheduling-actions-review.test.ts` | `6f271072b84869a61656e11d412ed876f4ebf101cbbdd14ab01a0b23e1eae16f` |
| `app/(app)/dashboard/social/actions.ts` | `ccc1bcf1e8b922c288013203eb0b0295f6be11f3077c57af764397b15ff32338` |
| `lib/social/links.ts` | `55dc71b880a0da3201ce1f7cc8590048d3607c47d37210697d238ea46423c56c` |

## Passing coverage

Pre-write validation covers intent, zone, absolute/local mismatch, past time, DST gap and overlap, unsupported kinds/platforms, recurrence, zero/excess account count and body bounds. Account tests cover disconnected, deleted, foreign-family, wrong-platform, missing provider identity, duplicate provider identity and returned/thrown required reads. Persistence tests cover each required write, exact schedule/calendar receipts, unarmed preparation cleanup, queued/approval-required results, and committed-but-lost arm responses retaining identity without cleanup. Private manual-retry results and errors never fall back to live publishing; only an explicit null uses the existing manual path.

## Worker review notes sent to its owner

Read-only inspection covered `scheduled-authority.ts`, `scheduled-publish.ts`, account token integration and the cron route. No concrete duplicate-send path was found in the reviewed revision claims, immutable content/account snapshot, fresh active-member/permission checks and encrypted credential binding. This statement is bounded review evidence, not proof against all races.

Two concrete accounting/retry checks were fixed by the worker owner and independently rerun in its actual installed-SDK chain suite (44 passed): returned failed/unknown provider outcomes now appear in the cron summary and produce unsuccessful HTTP responses; confirmed 429 work is reported pending; and a mixed non-429 rejection plus 429 batch reuses the non-429 result instead of sending it again automatically. Live provider delivery, deployed scheduler execution and real PostgreSQL isolation remain unverified here.
