# Display ownership, availability and timezone rendering

2026-09-12. UI-003 / KITCHEN-D07 owns local display state. The separate calendar/read-status rendering below coordinates with the API lane's KITCHEN-D01–D04/D08 work, documented in `kitchen-calendar-cycle.md`. Root owns the master audit and combined release gate.

## Existing behavior and reproduced failure

The original `DisplayShell` initialized tiles, settings and setup dismissal once. Reset changed only the layout draft; cancel copied current incoming props; save and setup dismissal upserted the complete layout/settings row using the handler's family and user IDs. Successful writes updated local state, while a thrown promise left the busy state unresolved. A later family prop change could therefore render a new family with the previous family's editor state.

Four maintained actual React/Chromium cases failed against the original grid after correcting the harness:

| Case | Original execution result |
| --- | --- |
| Idle persisted refresh | Requested reminders layout was absent; old schedule remained. |
| Family change while editing | Editor remained open instead of resetting to the new family's layout. |
| Same-family refresh followed by cancel | New layout/settings were restored, but the setup card ignored the refreshed persisted dismissal flag. |
| User change within the family | Previous user's editor remained open. |

The fixture initially needed two corrections: disable the display's optional burn-in drift so clicks can become stable, and select the real combobox by accessible role. A concurrent calendar-helper change then required loading its actual calendar/ICS imports. Those fixture/mount failures are excluded from the four behavioral results above. The corrected four-case baseline completed in 7.1 seconds with four expected assertion failures.

## Ownership repair

The exported `DisplayShell` now keys an inner stateful component by `[familyId, userId]`. A changed owner remounts local tiles, settings, editing/busy flags and setup dismissal together. Keeping the boundary inside the exported component also protects direct consumers; `display-shell-client.tsx` did not need a production change.

Incoming persisted props are tracked separately from the active editor draft. A same-family refresh updates the cancel baseline and immediately updates the visible layout/settings when idle. An active editor draft survives the refresh. Cancel restores that newest persisted baseline, including setup dismissal. Successful local save becomes the cancel baseline until another persisted refresh arrives, so closing the editor does not reapply obsolete initial props. Reset still changes only the layout draft.

A per-mount liveness token fences save/dismiss continuations, including an A → B → A sequence. An old promise cannot clear a new family's busy state, close its editor, hide its setup card or show an old owner's toast. Successful dismissal merges only its flag into the current preferences, avoiding restoration of an obsolete same-family settings snapshot. Rejected promises are caught, retain the draft/card and re-enable retry. The already-submitted database write is still addressed to its initiating family; this is completion fencing, not cancellation or a database concurrency guarantee.

Root review identified a separate same-owner ordering problem: both actions replace the entire row, so merging only local dismissal state cannot prevent an older dismissal from overwriting a newer durable layout save. The browser fixture was extended with persisted rows and deliberately completed the newer chores save first, then the older dismissal. The actual result reverted to the original schedule; the maintained test failed with expected `chores`, received `schedule`.

Both handlers now acquire one synchronous per-owner pending-write token before setting React busy state. Conflicting controls are disabled, and the handlers themselves reject a second write even before React commits those disabled states. `finally` and owner cleanup release the appropriate token without affecting a newer owner's request. Draft editing can continue during a write; a draft revision prevents a completed save from closing newer unsaved edits. This serializes this mounted editor's writes, not writes from other devices or clients.

The final review also reproduced cancel during an issued save: cancellation restored the old schedule locally even though the later successful write stored chores. Cancel is now disabled and synchronously guarded while either write is pending. Its execution test invokes the mounted handler despite the disabled control and verifies that the completed save leaves both the visible layout and durable fixture row on chores. The initial assertion needed to wait for the editor to settle before checking duplicate editor-option text; only the corrected settled result is treated as the behavioral reproduction.

## Independent availability and family time

`DisplayData` accepts the coordinated optional `timezone`, `dayKey`, `timezoneFallback`, independent `loadStatus` fields and event `ends_at`. The server lane supplies these on success and failure. Older callers without a status field retain their previous behavior; the production page explicitly reports its read outcomes.

The grid shows unavailable messages for failed schedule, upcoming, month-event and reminder reads. Stale arrays supplied alongside an error are not rendered as verified rows. A month-event failure preserves the month/date grid while removing event dots. A general status line also makes a failure visible when the affected tile is not pinned. Error → successful refresh restores rows/dots and removes the unavailable state. Verified empty reads retain their ordinary empty messages.

Failed calendar reads cannot produce Now/Next, calendar hints or photo-frame next-event lines. Failed reminder reads cannot produce reminder counts. The “All clear” hint requires both relevant reads to be available. A failed reminder read does not hide a separately verified calendar hint, and a failed calendar read does not hide verified reminders. The API lane adjusted `buildHints` so the availability flag controls the broad empty-state claim while callers fence each source.

The grid validates the effective family zone and passes it to ambient day-part/theme/countdown helpers and the root-owned clock/photo frame. Timed event labels and upcoming dates use that zone. All-day upcoming dates use their stored UTC civil date, avoiding a prior-day shift. The clock tile now uses the same saved clock format as the header. Explicit timezone fallback is disclosed in the UI. Eight new copy keys were appended to all seven base catalogues, preserving existing key order and values; German, French and Portuguese use formal wording. Regional overlays inherit their base copy.

## Executed verification

`tests/e2e/display-ownership.spec.ts` loads the actual `DisplayShellClient`, `DisplayShell`, setup card, settings/layout normalizers and calendar/ambient/ICS helpers into real React/ReactDOM in Chromium. Supabase upserts are controllable promises whose actual family/user/layout/settings payloads are recorded; successful completion applies that payload to the fixture's durable row, making reversed write ordering observable. Device/peripheral widgets are bounded adapters; clock, hints and photo adapters expose the actual props supplied by the grid. No authenticated account, live database, provider or physical display is touched.

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER='1'
node node_modules/@playwright/test/cli.js test tests/e2e/display-ownership.spec.ts --project=chromium --workers=4 --timeout=10000
```

**25 passed in 2.7 seconds.** Nineteen cover owner/draft/refresh/save/dismiss behavior: new-family save payload, user switch, local-save baseline, delayed old completion/error, A → B → A, dismissal merge, thrown promises and retry, reset, unmount, durable write ordering, synchronous duplicate-action guards, retention of newer drafts during save and prevention of false cancellation. The duplicate-action checks invoke the mounted React button's actual handler twice in one JavaScript turn before its state commits; no copied save implementation is tested. Six cases cover failed-read recovery, stale-row/dot suppression, independent successful hints, verified empty states, family-zone timed versus all-day dates, shared clock setting/zone props and disclosed safe UTC fallback.

```text
node node_modules/vitest/vitest.mjs run tests/display-render.test.ts tests/display-ask-handled-tiles.test.ts tests/display-setup-page.test.ts tests/display-server-safety.test.ts tests/display-recover.test.ts tests/display-wake-lock.test.ts
```

**6 files / 86 tests passed.** `tests/i18n-catalogue-integrity.test.ts` separately passed **55 tests**, including catalogue contract checks. The combined rerun passed **7 files / 141 tests**. Focused ESLint on the grid and browser spec and diff whitespace checking passed after the final cancel guard. Root owns the combined full-project TypeScript/build gate; this lane did not start another full typecheck.

## Limits

These tests prove component state transitions, rendered error/empty states, exact write ownership payloads and time/prop wiring. Root's separate clock/photo suite exercises their actual components; the API lane exercises server reads and canonical reminder service writes. They do not prove deployed PostgreSQL/RLS, authenticated two-family persistence, cross-device write conflicts, live provider sync, physical kiosk sleep/wake or a complete installed display workflow. Existing route polling remains the refresh mechanism; a successful read is not an instant-freshness promise. No SQL, migration, shared navigation, dependency installation or external write was performed by this lane.
