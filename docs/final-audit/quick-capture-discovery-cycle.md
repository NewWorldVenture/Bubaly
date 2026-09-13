# Quick Capture task-save discovery

This is a separate next-cycle read-only audit of source `3effbf41d433c332fe3abb79f88ffe45733941cf`. No application source was changed. It does not establish the cause of the prior hosted CI `Task saved` toast failure, and it does not establish production readiness.

Examined source SHA-256: `components/app/quick-capture.tsx` = `d322ab8be7ada32e0a82df6b01d5802fb46412841069155ab3b448ef39f1fc89`; `lib/capture/save.ts` = `3d913b9867076e90d2539eec1aa95d6ec232862e0d82ff53d7e7f714d1f7c4e2`.

## Permanent inventory references

| Reference | Source/workflow |
| --- | --- |
| COMPONENT-97EAFCA06075 | `components/app/quick-capture.tsx` |
| CONTROL-C7BEF2FB673A | Capture form submit/hotkey |
| CONTROL-B61D321E542A / CONTROL-0516597B3612 | Cancel / Save |
| CONTROL-387ED0558436 / CONTROL-3713E0A66B31 | Floating opener / modal |
| LIBRARY-3010D3A2884E | `lib/capture/save.ts` |
| LIBRARY-D780B569D045 / LIBRARY-E1C046C1283A | Capture parsing / shortcuts |
| DB-TBL-418 / DB-TBL-419 | `todo_items` / `todo_lists` |
| UI-ROUTE-0207 | `/dashboard`, where the first-value journey opens capture |

The immediate task path is QuickCapture form → `saveCapture(kind: task)` → family default-list lookup (and optional list creation) → task insert with `select('id')` → global Task saved toast and Undo descriptor. The returned id receipt is used; there is no separate task GET readback. Task creator/assignee fields reference the acting family member, not the auth user. `useJourney('capture')` emits independent telemetry and deliberately swallows its errors.

Existing `tests/capture-save.test.ts`, `capture-parse.test.ts`, and `capture-shortcut.test.ts` cover helper/parsing behavior. The save fixture normally returns `data:null,error:null` for successful task inserts, so those checks do not verify a durable id receipt or the actual component lifecycle. Those three existing files passed 45 tests in 335 ms in this discovery run.

## Actual execution and limits

`tests/e2e/quick-capture-audit-repro.spec.ts` executes actual QuickCapture, AppProvider, authenticated cache boundary, LocaleProvider, ToastProvider, journey hook, shared form controls, capture save/parse helpers, and installed Supabase SDK in Chromium. The root ToastProvider persists across actual AppProvider ownership changes, matching its position above app children in `app/layout.tsx`. Auth returns a synthetic valid UUID session/user contract; local storage and the real cache boundary run. SDK transport maintains persisted list/task/telemetry rows and applies the supplied filters. No live database or RLS bypass is asserted.

Shortcut content is isolated because its customization/server-action workflow is outside this task-save scope. The navigation case removes the actual QuickCapture child under the providers; it does not claim a complete Next-router navigation test. The empty-id response is an explicit contract probe with a successful empty response and no persisted row; it does not assert that a hosted trigger currently generates that response. Thrown construction is injected at the client factory boundary. All other unexpected browser errors are asserted absent.

Final focused run: **16 characterization cases in 3.0 seconds** — **4 healthy controls, 10 defect scenarios, and 2 additional behavioral characterizations**. Green `defect:` tests mean the unsafe behavior was reproduced, not that the workflow passed. The first fixture version incorrectly included existing rows in an INSERT receipt; this caused one list-error test to fail. The receipt was corrected to return only newly inserted rows, and the complete run passed. That fixture error is not counted as an application defect. Scoped lint passed.

## Reproduced failures

| Local finding | Concrete sequence and result |
| --- | --- |
| QCAP-D01: duplicate submission | Hold the task POST, click Save, then press **Ctrl+Enter** in the still-enabled Task field while the Save button is disabled. The actual form hotkey calls `requestSubmit()` and dispatches a second task POST. Two identical tasks persist. Same-turn actual submit callbacks also produce two tasks. |
| QCAP-D02: canceled/retired form changes | Save is pending, Cancel stays enabled, the user closes and reopens Capture with a different draft. The old response resets text and closes the new draft. Separately, a captured canceled form submit can save its old text after a new form opens, again closing the current draft. |
| QCAP-D03: stale owner/lifetime mutation | After the actual AppProvider switches from family A to B, an old retained submit still inserts into A and emits a global success toast. A more direct in-flight path holds the required list GET before any task write, switches family, and then releases the GET: the retired save proceeds into a new task POST for A. Removing QuickCapture for navigation similarly does not retire its retained submit. The fixture assumes the same user can access both families; this is an application ownership/lifecycle finding, not a claim that RLS is bypassed. |
| QCAP-D04: failed list read becomes absence | With an existing To-Do list, a returned error from the required lookup is ignored. The helper inserts a second default list, writes the task into it, and shows Task saved without surfacing the lookup failure. Successful empty lookup must be distinguished from failed lookup. |
| QCAP-D05: no usable id receipt | An explicit empty task insert receipt is treated as one saved task. The visible Undo then no-ops because its id list is empty and reports Undone. The helper validates only `error`, while the success count is hard-coded to one. |
| QCAP-D06: construction exception outside recovery | The client factory is invoked before the save handler's try block. A construction failure escapes as an unhandled rejection, leaves Save disabled, and produces no error feedback. Returned task errors are correctly contained in the positive control. |

The four healthy controls verify actual save/visible Undo with the correct family/member/list fields, successful first-list creation, returned task failure preserving its draft and deliberate retry, and the actual access boundary withholding Capture when the claimed user differs from the SDK identity.

Two additional characterizations require product/contract decisions rather than automatic defect claims:

- An existing global Undo toast remains actionable after a family switch and deletes the previously created A task by id while B is active. The user explicitly clicks Undo and the operation still names the earlier task via its captured ids. The evidence shows cross-family effect; whether Undo should survive that context change must be decided. No privilege escalation is claimed.
- If the optional roster is empty, AppProvider still has its required server membership identity for the cache boundary, but `selfMember` is null. Capture succeeds with null creator and assignee. Nullable schema values are not themselves a proof of failure; the resulting lack of attribution/self-assignment needs a contract decision.

## Bounded repair proposal, awaiting root recording/authorization

Use a synchronous pending guard across click/hotkey/retained submit paths and a per-opening form lifetime that retires on close, completion, owner change, and unmount. Preserve a true failed-write draft; prevent a pending completion from resetting a newer draft. Put client construction inside contained try/finally handling. Validate current ownership before each side effect in the multi-step helper, including after the list lookup and before list/task insertion, rather than checking only after the whole helper returns.

Propagate default-list lookup and creation errors. Require a nonempty valid task id receipt before claiming success or enabling Undo, or use an explicit uncertain-outcome recovery state if the response does not establish it. Preserve successful empty-list creation as a positive control. A stable intent/idempotency identity would be needed to make a retry after an uncertain dispatched mutation safe; a local busy flag alone cannot establish that. Reuse existing application/database capabilities if available; no new SQL is authorized by this discovery.

Owner-scoped Undo semantics and required member attribution should be resolved explicitly. Other capture kinds, shortcut customization, full-page `/capture`, task-service authorization, offline/hosted deployment behavior, and the exact earlier CI flake remain outside this completed discovery scope. No private-clean installation, dependency, SQL, navigation, full suite, build, commit, or push was changed or run by this lane.

## Subsequent authorized cycle

Root later recorded DATA-007 and authorized repair. The original uncommitted characterization spec was renamed to `tests/e2e/quick-capture-task.spec.ts` and its defect assertions were converted into corrected regression assertions. The historical 16-case evidence above is unchanged; final execution, additional consumer findings, compatibility coverage changes, and remaining limits are recorded separately in `quick-capture-ui-cycle.md`.
