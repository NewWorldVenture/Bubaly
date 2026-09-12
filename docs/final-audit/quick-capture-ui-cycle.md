# DATA-007 Quick Capture UI repair

Root recorded DATA-007 before application edits. The pre-repair actual Chromium evidence and permanent inventory references are in `quick-capture-discovery-cycle.md`. Its green defect characterizations are historical failure evidence, not workflow passes.

## Additional consumer finding recorded before editing

`components/capture/capture-shell.tsx` also calls the shared `saveCapture` helper (original line 112). `handleSubmit` checks only nonempty text, sets React routing state, and catches every error generically. Ctrl/Cmd+Enter bypasses its disabled capture button. It supplies no current-owner/lifetime predicate across the helper's list lookup/write awaits. A typed uncertain outcome would therefore leave the input available for a blind duplicate submission. The full-page shell also leaves old submit/Undo callbacks callable after completion or input changes. Root authorized this immediate consumer after this source finding; actual consumer execution is required before claiming the repair verified.

`components/modules/voice-module.tsx` and the shared CommandBar are additional capture consumers. The API lane owns its separately recorded voice repair. Shared navigation remains excluded from this lane. No source inspection alone establishes a complete workflow pass.

## Intended behavior

Quick Capture guards duplicate submits synchronously, retires each form opening on close/completion, and independently retires on owner change/unmount. Pending save close paths are guarded so a dispatched write cannot be falsely canceled. Confirmed failures preserve the editable draft; uncertain outcomes preserve a locked draft and a destination review link, including after closing/reopening the sheet. Undo intentionally retains its earlier captured identity across family changes, with a one-shot callback and contained factory/write errors. Nullable optional roster attribution is preserved.

The full-page shell needs equivalent intent/owner lifetime guards and uncertainty handling. The helper lane owns definitive receipt validation, required list read errors, and before/after-await current checks. No SQL, database idempotency guarantee, global navigation, or private-clean source change is part of this repair.

## Verification and observed repair sequence

- Historical discovery ran 16 characterization cases: four healthy controls, ten concrete defects, and two policy characterizations. These remain described in `quick-capture-discovery-cycle.md`. Root explicitly preserved earlier-task Undo and nullable optional roster attribution.
- The initial repair passed 35 actual Chromium cases in 4.6 seconds. Subsequent focused self-review added two desired assertions and both failed: a retained Note-type callback changed a reopened Task draft; a retained full-page Capture callback dispatched a task after selecting Photo. These were reported before the additional control/mode lifetime edits.
- The first UI freeze of `tests/e2e/quick-capture-task.spec.ts` passed **37 Chromium cases in 4.7 seconds**. The helper owner then added a 15-second per-query deadline; two additional actual UI/SDK clock cases were added, and the final run passes **39 Chromium cases in 5.1 seconds**. A held required lookup unlocks a retryable draft without a task write; a held task POST becomes an uncertain review state, allows closing, blocks repeat after reopening, and ignores a late acknowledged commit. The former uncommitted discovery spec was renamed and its unsafe characterization assertions replaced with desired regression assertions. There are no green defect-characterization assertions in this final spec.
- Four focused unit files pass **58 tests in 1.51 seconds**: `document-capture-ui.test.ts`, `capture-page-localization.test.ts`, `capture-parse.test.ts`, and `capture-shortcut.test.ts`.
- Scoped lint passes for both application components, the Chromium spec, and the updated document UI test. `git diff --check` passes.

The first related-unit run passed 57/58 checks and failed a hand-written React hook fixture: the test directly called `CaptureShell()` and had no valid `useLayoutEffect` dispatcher. This was a test-contract issue, not an application browser failure. Its Photo parent-wiring assertion moved to the real React Chromium fixture, which also checks Scan, return to Type, retained hidden submit, and a subsequent real task save. The unrelated Paperwork composer assertion and all document selection/upload controls remain in the existing unit file. No fake lifecycle implementation or suppression was added.

## Execution scope

The browser fixture loads the actual QuickCapture, CaptureShell, AppProvider, authenticated cache boundary, LocaleProvider, ToastProvider, journey hook, shared form controls, save/parse helpers, and installed Supabase SDK. It uses synthetic valid UUID session/user identities and UUID list/task receipts. Controlled SDK transport applies family/id filters, maintains rows, can hold lookup/list/task writes, and returns definitive errors, empty receipts, or a gateway response lost after a simulated committed insert. The latter proves the UI does not issue another POST when persistence may already have happened. Expected browser errors are empty, including injected client-factory failures.

The 39 cases cover correct family/member attribution and first-list creation; required lookup failure and recovery; synchronous double callbacks and actual hotkey handlers; pending close/Cancel/Escape guards; canceled/completed/failed/reopened callback retirement; edits and mode changes; owner retirement at all three task awaits; navigation unmount; confirmed failure draft preservation; no Saved/Undo from unconfirmed receipts; locked uncertainty across close/reopen; explicit earlier-family Undo with its captured family filter; one-shot Undo and factory/write/receipt failures; full-page destination forwarding; and real French recovery text.

Shortcut customization and DocumentCapture child internals are isolated. Document mode tests execute the real parent and inspect the selected child/props through a small sentinel; document extraction/camera/upload execution is covered separately and is not claimed by this fixture. Next router push/back is a recorded boundary, so destination selection is verified but complete route navigation is not. Auth storage/cache boundary is real but the SDK auth response uses a synthetic contract; no hosted identity provider, live database, RLS, physical mobile device, or provider delivery is exercised.

`UI-ROUTE-0082` is the permanent full-page `/capture` reference. The original QuickCapture component/control/library/database references remain in the discovery document. Root owns the seven-locale appended recovery keys and shared-helper validation; helper-specific test totals are documented by the API lane rather than added to these UI totals.

## Remaining limits

Local synchronous guards prevent duplicate dispatch in the observed component lifetime. They are not durable idempotency or atomic database protection: a browser restart, another tab/client, or direct endpoint caller remains a separate server/database concern. A retired already-dispatched write may finish; the helper prevents subsequent writes and the UI suppresses its stale completion, but this cannot roll back accepted work. Review links intentionally let users inspect the destination before creating again. Existing capture labels, routing heuristics, time parsing, and the exact prior hosted CI toast failure are not proven fixed by this work.

The shared CommandBar remains outside the standing navigation boundary. Voice consumer handling is owned separately by the API lane. No full suite, production build, strict whole-project type check, SQL, dependency change, private clean installation change, commit, or push was performed by this lane. The overall audit remains **not production ready**.


## Frozen UI source fingerprints

- `components/app/quick-capture.tsx`: SHA-256 `fe3c127ec3f8eea654581fda6e56b72084504eaedb34113585e584d05ff23801`.
- `components/capture/capture-shell.tsx`: SHA-256 `634eafaa1259cccf564464a1e87a7a16d5626ad6fbc2652106b10c0a47111306`.
- `tests/e2e/quick-capture-task.spec.ts`: SHA-256 `df22f63d9aa81f457f238cc77b4f90f58c17bbd7b78fd622d9ebdcb2511bea7f`.
- `tests/document-capture-ui.test.ts`: SHA-256 `d8f751d79474b9c3c1fe2e044c3645a5e41308b57961a66446db7efd79c51584`.

A later presentation-fixture review corrected a Windows-decoded French input literal in the capture spec and historical discovery punctuation using explicit UTF-8. The actual French capture browser case passed again (1.7 seconds total); no application source or assertion behavior changed, and the full 39-case source result above is retained with that provenance.
