# DATA-006 hydration ledger repair

Root recorded DATA-006 High / IN PROGRESS before source edits. The original read-only findings and baseline provenance remain in `hydration-discovery-cycle.md`. This bounded repair does not establish full application or production readiness.

Permanent references: `UI-ROUTE-0166` (`/dashboard/habits`), `COMPONENT-B87AB8900CCC`, `LIBRARY-CB8E96747381`, `LIBRARY-FA44063B4059`, `DB-TBL-168`, and `DB-TBL-169`; existing feature identity TODO-0416.

## Resulting behavior

`components/modules/habits-module.tsx` now requires usable catalog and log reads before exposing count actions or derived progress. Loading and stale cache data no longer masquerade as zero. Read failures use the existing ErrorState retry, including an accessible retry inside an open habit modal so a same-owner draft can survive recovery.

Count handlers read the latest verified rows and reject retired family/member ownership, unmounted callbacks, changed habits and members, and old UTC day actions. A synchronous owner guard prevents duplicate same-turn submissions and conflicting writes. Successful writes and returned/thrown failures are contained and followed by explicit catalog/log confirmation before another relative count change is accepted. Edit, archive, preset creation and the modal Cancel handler use the same pending-write boundary so they cannot race a count update. A confirmed created row closes its new draft even if subsequent readback fails, preventing a second new submission for a known existing habit.

The shared query hook is owned by the operations lane. This module consumes its additive `refreshAndConfirm()` result rather than interpreting the older `refresh(): Promise<void>` completion as success. Confirmation waits for the newest query result committed by React: if online refresh supersedes the initial readback, the old response cannot unlock count actions. Failed confirmation leaves a local recovery error and requires a usable retry. Hook scope retirement also releases waiters; the module checks its owner before applying completion effects. The synchronous write guard is released only when React commits the non-busy state, after confirmed rows are available to retained handlers.

Existing log updates and deletes now match id, family, habit, UTC date, previous count, and member, and require a returned row. Concurrent count changes and duplicate day inserts therefore produce a conflict/readback instead of overwriting a newer total. Existing preset target values and UTC day policy are preserved. A periodic/focus/online/visibility day check advances open pages, and the action itself rejects an old-day invocation before refetching the current day. The log query/cache identity includes that day.

## Verification

The renamed `tests/e2e/hydration-ledger.spec.ts` executes the actual component, React, shared UI, actual LocaleProvider, authenticated cache boundary, query/cache code, habit helpers, and installed Supabase/PostgREST SDK against an intercepted persisted fixture. Auth identity and realtime are controlled. The fixture enforces the existing habit/day uniqueness and supplied conditional predicates; it does not prove deployed SQL or RLS behavior.

The first focused Chromium freeze had **27 tests passed in 4.2 seconds**. Subsequent independent rewards review prompted an actual hydration self-review probe: capturing a new HabitModal submit, saving and closing it, then invoking the retired callback created a second identical habit. The desired one-row assertion failed with two persisted rows. Root recorded this extension before approving the narrow thaw. A component-local lifetime reference now retires in layout-effect cleanup and rejects submits from the unmounted modal, including after another modal opens.

The final focused run passed **30 hydration cases plus 7 independently owned rewards review cases (37 total) in 5.4 seconds**, four workers, with no external application server and no unhandled browser errors. Hydration coverage includes:

- Preset creation, assigned-member cup logging, increment/decrement/delete-to-zero, and target-of-one check-in toggle.
- Catalog and required-log loading/error recovery; stale cached total versus newer persisted total; stale active catalog versus archived habit.
- Same-turn duplicates, retained callback after readback, family switch, unmount, and late old-family acknowledgement while the new family has a draft.
- Returned and thrown writes, failed readback, discarded GET1 followed by newer GET2 success or failure, concurrent count updates, and unique day insertion conflicts.
- Draft preservation and modal retry; pending create/Cancel guards; confirmed create followed by failed readback; edit/archive readback and retired count handler.
- Action-time and periodic UTC midnight rollover, plus new conflict copy through the real French locale provider.
- Retained submit after successful modal closure, after reopening a different form, and after Cancel followed by reopening. The current form still saves deliberately; the retired callback cannot duplicate its old record or discard the new draft.

Four related unit files passed **29 tests in 1.22 seconds** before the final modal-lifetime extension: habits-hydration, habits-presets, habits-streaks, and habits-ai. The prior total was 30; one obsolete source-string assertion required id-only count writes and duplicated inline error checks. With root approval it was removed in favor of the actual component/SDK execution cases above. Its two unrelated preset/streak assertions remain. No placeholder assertion checking whether another test exists was added. Final scoped lint passed for the component, hydration browser spec, independent rewards review spec, and amended unit file; scoped diff whitespace check passed. The temporary hydration form probe was removed after its regressions were integrated into the permanent spec.

Root appended `habitsModule.dataUnavailable` and `habitsModule.habitChanged` in all seven base locale catalogues. This lane did not edit catalogues or the shared hook. Owned changes are the component, browser spec, amended static unit file, and the two hydration cycle documents. No SQL, migration, dependency, shared navigation, private clean installation, full suite, build, commit, or push was performed by this lane.

## Limits

Conditional compare-and-set prevents a stale known count from being silently overwritten, but this is not an atomic cross-client increment endpoint. Database authorization, direct raw-client bypass, cross-table active-habit changes between reads and writes, and multi-client atomic amount semantics remain separate server/database obligations. No schema or policy change was made. Existing clinical preset values, timezone-policy selection, AI coaching, and broad localization were not redefined. Full-project type/build/release verification remains the root lane's combined gate.
