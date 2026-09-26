# Medication ledger cycle — DATA-005

The audit owner recorded DATA-005 as High / IN PROGRESS before the production edits. The initial execution snapshot was `d8b276db42ebfd57f3d29ae5a35fa4740afe0bf9`. This is a separate cycle from the validated `6094eb04` release candidate; the private clean installation was not changed.

Canonical inventory references: `UI-ROUTE-0191` (`/dashboard/medications`), `COMPONENT-8DD7D691D391` (`components/modules/medications-module.tsx`), `LIBRARY-47A7FE099D19` (`lib/medications/adherence.ts`), `LIBRARY-3B7C7846912C` (`lib/notifications/medication-reminders.ts`), and `DB-TBL-275/276/277` (dose, schedule and medication tables). Dose controls are `CONTROL-E128FBAE6809` and `CONTROL-1B1D1EF4F589`; medication/schedule submit controls are `CONTROL-CF1958BD3D97` and `CONTROL-857EC29B4408`.

## Before the repair

The uniquely owned discovery spec ran 17 actual React/Chromium cases: seven healthy controls and ten deliberate assertions of existing defects. Those green reproduction assertions were evidence that the bugs existed, not workflow PASS evidence. Initial errors and uncached pending reads correctly withheld dosing actions, and returned mutation errors restored controls.

The principal failure was a complete read/write sequence: a recorded taken dose was changed to skipped in storage, but the UI retained the taken state. Clicking taken next deleted the skipped record instead of setting it taken. A first successful taken action similarly left the screen pending with “0 taken”; the next click attempted another insert. The fixture enforced the migration's unique `(schedule_id, scheduled_for)` constraint, so it demonstrated duplicate requests/conflicts, not invented duplicate durable dose rows.

Other reproduced failures included cached empty dose history authorizing a write while the authoritative read was pending; duplicate synchronous callbacks; an unhandled thrown mutation leaving controls busy; inactive medication dosing; a retained family-A callback writing after the cache boundary switched to family B; an open page logging yesterday after midnight; and successful medication/schedule creation not appearing until an unrelated refresh. None of the three medication tables is in the application's realtime publication list.

## Repair

All required medication, schedule and dose reads must now be successful and current before write affordances or handlers can act. Mutations use a synchronous owner-specific guard, contain errors, and await explicit readback. The guard remains held until React commits the returned rows with the released busy state. Failed readback shows the existing retry state; drafts survive read failures and failed saves. An issued save cannot be falsely canceled or duplicated while pending.

Handlers validate current family/lifetime and the current day and slot. Retired callbacks do not write; an already-issued old-owner request may still complete, but its result cannot refresh or toast into the new owner. Existing-row mutations include family predicates and confirm that a row matched. Dose updates/deletes additionally require the status and scheduled instant that were read, so a concurrent status change is preserved and reread instead of silently overwritten.

Inactive medications remain visible in the medication list but are excluded from actionable dose expansion. Member/slot conflicts remain visible for review with disabled controls. The current local day updates each minute and on focus, visibility and online events; a stale-day handler also checks the real current date synchronously. The dose-query cache identity includes the local day, and its rolling window starts at local midnight 30 calendar days earlier. New schedule forms derive their starting date when opened.

`doseSlotInstant` and dose expansion now match the database's exact unique slot. A later schedule time does not consume or toggle an earlier same-day dose. Browser-local time semantics are retained. A nonexistent local DST time remains visible for review and cannot silently write at a normalized, different time. No medication name, dosage, instruction, refill value, existing log or schedule time is migrated or rewritten by this change.

## Execution evidence and limits

The former discovery spec is now `tests/e2e/medications-ledger.spec.ts` with repair assertions. It executes the real module, shared form controls, authenticated cache boundary, query hook, adherence helper and installed Supabase/PostgREST against persisted intercepted HTTP rows. The fixture models family filters, unique slots, conditional writes and the existing delete cascade/set-null behavior. Auth identity, realtime delivery, avatars and AI are controlled boundaries. The actual locale provider, locale objects and translator execute with selected real English/French catalogue values.

The final focused browser coverage includes the original failures plus held/failed readback, draft recovery, duplicate-save/cancel protection, late owner completion, concurrent status/insert races, schedule-time changes, member mismatch, DST-gap review, French conflict copy, medication edit/delete, schedule removal preserving history, and automatic midnight advancement. A temporary test-title quoting mistake during conversion was corrected before execution; it was a harness parse error, not an application defect.

Final validation: **33 Chromium checks passed** with four workers in **4.0 seconds**; **3 unit files / 19 tests passed** in **353 ms**; scoped ESLint and `git diff --check` passed. No full suite, production build, full typecheck, SQL/migration, dependency installation, commit or push was performed in this lane.

This cycle does not establish complete production readiness. Live database/RLS behavior, database read row limits, raw endpoint bypass, family timezone standardization across devices and server notification timezone semantics remain separate obligations. The existing household dose-log permissions are unchanged. The guard cannot retract an already-issued request or promise database-wide atomicity beyond the existing unique slot and the explicit conditional writes.
