# Medication readback confirmation follow-up

This bounded follow-up was authorized after independent review of the DATA-005 repair, against the working tree following checkpoint `572b29c9`. It changes `lib/hooks/use-realtime-query.ts` and `components/modules/medications-module.tsx`; the hydration consumer is a separately owned DATA-006 change. No SQL, dependencies, global navigation or medication schedule policy changes are included.

## Reproduction and repair

The actual React/Chromium medication fixture reproduced a successful dose insert followed by two held reads: the mutation readback, then a newer online-event read. Releasing only the first read discarded its rows because the newer request owned the hook, but the original `refresh(): Promise<void>` resolved normally. Medication actions became writable against the earlier rows while the current read was still pending. The original assertion failed with the dose button enabled. The fixture enforces the existing unique dose slot: this demonstrates repeat/conflicting requests, not duplicate durable dose records.

The shared hook now adds `refreshAndConfirm(): Promise<QueryRefreshConfirmation>`. Existing `refresh`, `setData`, loading and stale-display behavior remain compatible. A successful confirmation requires the latest request's usable rows to have committed in React. A newer ordinary refresh inherits pending confirmations; an older completion cannot resolve them. A committed read error returns `{ ok: false, reason: 'error', error }`; scope retirement, unmount or cache purge returns `inactive`; local `setData` returns `superseded`. These unsuccessful results do not attest that cached or local rows are authoritative.

Medication mutations opt into confirmation and keep the synchronous mutation guard until that confirmation and the released busy state commit. A failed confirmation retains an explicit recovery guard, so unrelated rerenders cannot restore writable old rows. Retry confirms all three required queries. A confirmed medication or schedule insert whose readback fails retains its completion separately: successful Retry closes the already-saved form and emits its deferred success once. It cannot reopen as an unsaved new record and issue the same insert again. Failed-write drafts retain their existing recovery behavior. Retired owners cannot run deferred completion into the next owner.

The final retained-callback review found an additional defect in both forms: after successful POST, failed readback and successful Retry closed the form, invoking its retained actual React `onSubmit` sent a second POST. Both strengthened assertions failed with expected one request and observed two. Each medication or schedule opening now has its own identity, invalidated synchronously on cancellation or confirmed completion. A callback from a closed opening cannot submit against the same owner's newly opened form. The current opening remains valid after a rejected write, allowing explicit draft retry. This final adjustment changes only the medication module and its owned browser tests; the shared hook remains frozen.

## Execution evidence

- `tests/e2e/query-refresh-confirmation.spec.ts`: six actual React/hook/cache tests cover commit observation, superseding success/error, unmount, family change, purge and local updates. Its deterministic asynchronous fetch boundary isolates request ordering; it does not claim provider behavior.
- `tests/e2e/medications-readback-review.spec.ts`: ten actual React/module/hook/installed-Supabase-SDK browser tests cover superseding reads, failed newest read and explicit recovery, owner retirement, successful medication/schedule creation followed by failed readback and Retry, retained submits after completion/cancel/reopen, valid new openings, and rejected schedule-write draft retry. Persisted intercepted HTTP fixtures model the relevant database contract.
- The original supersession reproduction failed before this change and passed after it. The two new regular specs passed **11 Chromium tests** in 3.4 seconds. The existing `tests/e2e/medications-ledger.spec.ts` passed **33 Chromium tests** in 7.3 seconds after the final form-completion correction.
- Scoped ESLint for the two production files and two new specs, and `git diff --check`, passed. Temporary reproduction files were removed after migration into the regular browser suite.
- After the final form-opening adjustment, both formerly failing retained-submit cases passed. The nine then-current review tests plus all 33 existing medication tests passed together (**42 Chromium tests**, 9.6 seconds); the subsequently added schedule-write rejection/retry control also passed (**one test**, 1.6 seconds). The medication module and final review spec passed scoped ESLint and diff checks again. There are **43 passing medication browser cases** in the final source; the earlier six shared-hook cases remain unchanged.

Commands, from the audit worktree, using the existing dependencies and installed Chrome:

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER='1'
$env:PW_CHROMIUM_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'
node node_modules/@playwright/test/cli.js test tests/e2e/medications-readback-review.spec.ts tests/e2e/query-refresh-confirmation.spec.ts --project=chromium --workers=2
node node_modules/@playwright/test/cli.js test tests/e2e/medications-ledger.spec.ts --project=chromium --workers=2
node node_modules/eslint/bin/eslint.js lib/hooks/use-realtime-query.ts components/modules/medications-module.tsx tests/e2e/medications-readback-review.spec.ts tests/e2e/query-refresh-confirmation.spec.ts
```

## Boundaries

This is an opt-in readback guarantee, not a change to all hook consumers. Other mutations awaiting only `refresh()` need their own justified review; Rewards is explicitly outside this follow-up. The hook does not add a timeout to an unresolved provider request or infer a write's acceptance when its response is lost. It cannot retract an issued write or supply database-wide transactional guarantees. Existing live RLS, deployment, multi-device timezone and real provider obligations remain separate. The root owner runs the combined type, build, full-query and release gates; this lane ran no full-project suite, build or typecheck and made no commit or push.
