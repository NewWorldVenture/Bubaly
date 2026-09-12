# Kitchen family calendar and canonical reminder loading

2026-09-12. This lane repairs KITCHEN-D01–D04 and D08 in the server data/ambient layer after the root audit authorized the cycle. The UI owner adds the matching display rendering; the root owns the clock/photo-frame adapters and combined gates. No SQL, shared navigation, shared realtime hook, provider configuration, dependencies or production data were changed here.

## Changes and boundaries

`lib/display/calendar.ts` validates the configured family timezone and carries an explicit `timezoneFallback` when UTC is used for missing/invalid configuration. It reuses the existing pure ICS calendar-date validation, date shifting and timezone validation primitives. The small bounded civil-day bisection follows `lib/briefing/calendar-window.ts` and handles both DST transitions, skipped midnight and a wholly skipped date; the service-scope midnight helpers are server-only and were not changed.

The actual `/display` page supplies `timezone`, `dayKey`, `timezoneFallback` and independent `loadStatus` fields for today's events, upcoming events, month event marks and reminders. Its full fallback supplies error status, rather than claiming the empty lists were successfully read. Calendar metadata still carries the family's date. Handled-today bounds, meal date, birthdays and calendar year/month/day use that same family calendar. Upcoming events start with tomorrow's window and stop at the boundary fourteen calendar days from today; birthdays cover the half-open fourteen-day window beginning today.

Timed event queries select `ends_at` and use half-open overlap: an event starting before midnight remains in today's schedule while its valid end lies after midnight. Events ending at the day start or beginning at the next day start are excluded. All-day events use their separately stored UTC calendar dates, preserving the existing Google/ICS import convention, with exclusive end dates; they are never shifted into a different date by the family's UTC offset. Month marks cover every occupied family date across an event span. A missing or invalid end has unknown duration: its recorded start can be listed, but no continued occupancy is invented. A missing all-day end uses its one recorded calendar date. Invalid starts cannot produce occupancy or month marks.

`nowAndNext` now uses actual `[starts_at, ends_at)` intervals and excludes all-day rows from both timed current and timed next. A long event remains current until its end; an ended event immediately stops being current. Countdown labels no longer call a past start “Now” based on a 90-minute guess. Ambient day parts, themes, clocks and countdown/hint formatting accept a validated family timezone. `buildHints` accepts `availabilityKnown:false` to suppress the “All clear” claim while preserving unrelated, verified facts; the UI owner fences each failed source independently.

The display reads canonical `family_reminders`, matching `lib/services/reminders`. Active and snoozed dated reminders are eligible; completed, dismissed, undated and other-family rows are excluded. A snoozed row's effective display time is the later of `remind_at` and valid `snoozed_until`, matching the service's requirement that both time thresholds pass before it is due. An absent/invalid snooze falls back to the recorded reminder time, as the service does. Sorting and the ten-row presentation limit apply to the effective time. Snoozes beyond the family horizon are withheld. Existing legacy `reminders` rows are not merged, copied or mutated.

## Executed verification

`tests/display-page-calendar.test.ts` imports and executes the actual async page. Authentication context, translations and peripheral client component boundaries are controlled; the real page, Supabase settlement helper, display date/ambient logic and reminder services execute. Its in-memory database applies real filtering, projection, ordering and writes. Seeds use normalized timestamps to avoid pretending text ordering equals PostgreSQL timestamp ordering for inconsistent representations. Fault injection separately targets the three calendar reads and the canonical reminder read. A guard fails the test if a supposedly healthy fixture falls into the page's fatal fallback.

The maintained cases verify Los Angeles family-date disagreement with UTC; inclusion of timed/all-day positive controls; meals and handled-today count; ongoing overnight events and exact day/end exclusions; both New York DST day boundaries; Auckland year/month/birthday rollover; all-day end-exclusive spans; and each independent read's error → retry → valid empty → populated recovery. The actual reminder service creates a row, the page displays it, snooze changes its displayed time, and completion removes it. Legacy and other-family rows remain absent.

`tests/display-calendar.test.ts` executes positive/negative timezone offsets, 23/25-hour days, São Paulo's skipped midnight, Apia's skipped date, invalid timezone/clock/date handling, exact interval boundaries, all-day/timed separation, long/ended/unknown-duration events, effective snoozes and family-zone formatting. The original ambient tests now assert actual interval semantics instead of preserving the old 90-minute heuristic.

The following related regression passed **10 files / 164 tests** at 09:18 EDT:

```text
node node_modules/vitest/vitest.mjs run tests/display-calendar.test.ts tests/display-page-calendar.test.ts tests/display-ambient.test.ts tests/display-render.test.ts tests/display-server-safety.test.ts tests/display-recover.test.ts tests/display-ask-handled-tiles.test.ts tests/display-setup-page.test.ts tests/display-wake-lock.test.ts tests/service-reminders.test.ts --maxWorkers=4 --reporter=dot
```

Scoped Next lint passed for the page, calendar/ambient helpers and owned tests. The render suite emits its existing warning from an intentionally supplied `javascript:bad` image fixture; it is not a calendar failure. Per root instruction, this lane does not run or claim full TypeScript/build validation; root owns the combined gate.

## Remaining verification

UI timezone formatting, independent unavailable messages and owner-state synchronization are separate coordinated changes. These tests verify the server data and pure semantics, not an authenticated production kiosk, deployed PostgreSQL/RLS, live canonical reminder persistence or physical sleep/wake behavior. Calendar recurrence expansion remains unchanged. The display still relies on its existing route refresh cadence; successful read status does not promise instant freshness between refreshes. Normal Supabase response limits and query plans have not been load-tested. Production readiness is not claimed.
