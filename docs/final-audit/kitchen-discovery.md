# Kitchen display and calendar discovery

2026-09-12, current audit worktree based on `c7b56eff`. This lane read the current implementation and executed controlled fixtures; it did not assume earlier findings still applied. No application source, SQL, dependencies, production data, global navigation or provider configuration was changed. Root owns the combined audit and any subsequent repair authorization.

There are two distinct paths. `/display` reads server data in `app/(app)/display/page.tsx`, passes it to `DisplayShellClient`, and refreshes the route every 120 seconds. It does **not** use `useRealtimeQuery`. The interactive `/dashboard/calendar` mounts `CalendarModule`, which uses the shared `lib/hooks/use-realtime-query.ts` with the family and visible month as dependencies. The owner/day-switch findings below concern that shared hook; the display also has a separate settings-state retention issue.

## Confirmed current failures

| ID | Priority | Current evidence and user impact |
|---|---|---|
| KITCHEN-D01 | High | Family timezone is ignored by the display loader. The day, date-only meal key, handled-today range, birthdays and month come from server-local `Date` methods at `app/(app)/display/page.tsx:120`; `ctx.active.family.timezone` is available but never passed at line 304. The header clock and event labels use the browser timezone, so header, queried day and family's configured day can disagree. |
| KITCHEN-D02 | High | An ongoing event that started before midnight is omitted by `starts_at >= start` at page line 130. Neither current nor upcoming reads select `ends_at` (129, 131). `lib/display/ambient.ts:145` cannot represent an end; `nowAndNext` uses a 90-minute start-age guess. Already-ended events remain “Now”; long ongoing events disappear. |
| KITCHEN-D03 | Medium | All-day events are excluded only from `current`, not `next`, in `lib/display/ambient.ts:165–167`. A future all-day row becomes a timed next-event/countdown hint. Neutral all-day availability must be distinct from timed availability. The schedule can continue listing all-day labels without using them to claim current/next occupancy. |
| KITCHEN-D04 | High | Failed required calendar/reminder reads are logged then converted to empty arrays at page lines 159, 205 and 210. `DisplayData` carries no corresponding error/freshness state. Schedule/reminder tiles therefore say nothing is scheduled/due (`components/display/display-grid.tsx:220`, 301), and `buildHints` can say “All clear” (`lib/display/ambient.ts:242`) during the outage. The handled-today tile already has an honest independent error contract; the calendar/reminder tiles do not. |
| KITCHEN-D05 | High | Shared `useRealtimeQuery` has no request or owner generation guard around line 41. A late previous-family or previous-window result replaces current rows and clears current loading/error. A new owner with no cache does not clear old rows at lines 66–74; an offline failure then clears loading without clearing those rows. Real React/Chromium execution displayed family A rows while the rendered owner was family B, and displayed the previous owner's rows after an offline switch. |
| KITCHEN-D06 | High | Overlapping same-key refreshes can replace the newest successful data **and persisted cache** with an older response (`use-realtime-query.ts:56–60`). A thrown fetch rejects without a catch/finally and strands loading (`:41`). Realtime/online/manual callbacks can overlap. The pure cache tests prove key/TTL mechanics, not these hook behaviors. |
| KITCHEN-D07 | Medium | `DisplayShell` initializes tiles, settings and setup dismissal from props once (`display-grid.tsx:509–515`) and never synchronizes them on successful refresh or family change. Actual React rerenders with new layout/settings retained the old tile and clock mode; changing the family header also retained the old family layout/settings. The existing save handler uses the new `familyId` with the retained state (`:579`), so an overwrite of the new family's layout is a source-supported risk; a save-through-browser proof was not completed in this read-only cycle. |
| KITCHEN-D08 | High investigation target | `/display` reads legacy `reminders`, while the interactive reminder module reads `family_reminders` (`components/modules/reminders-module.tsx:116–121`). `lib/services/reminders/index.ts:1–10` explicitly identifies `family_reminders` as canonical, and create writes use it at line 92. Both tables exist independently in migration source (0002 line 388, 0014 line 167). No automatic bridge was found in the inspected definitions/call sites. A newly created canonical reminder cannot be assumed to reach this display query. This source mismatch still needs a create → display execution test; do not call it a complete runtime reproduction. |

## Executed source and browser fixtures

The server fixture transpiled the **actual current** `app/(app)/display/page.tsx` using installed TypeScript and executed its default page function in a Node VM. Only authentication, the Supabase boundary, translations and client-shell placeholders were substituted. The existing `tests/helpers/in-memory-supabase.ts` was used with explicit `.seed()` calls, real filters/projection and a positive-control event. A fixed clock and `TZ=UTC` removed host-clock ambiguity. Data was read back from the actual `DisplayShellClient` React element. The initial fixture setup was corrected to use `.seed()`; results below are from that corrected run, with positive controls present.

| Fixture | Expected | Actual current result |
|---|---|---|
| `now=2026-09-12T02:00:00Z`, family `America/Los_Angeles`; Sept 11 all-day row, Sept 11 23:00Z timed row and Sept 12 01:00Z positive control | Family date Sept 11; all three belong to the family's Sept 11 schedule | Calendar date 12; only positive control returned. Recorded bounds were Sept 12 00:00Z to Sept 13 00:00Z. Month dots included both 11 and 12 even though those timed rows share the family's Sept 11. |
| UTC Sept 12 00:30Z; overnight event Sept 11 23:30Z–Sept 12 02:00Z and same-day control | Both events included; overnight one ongoing | Only control returned; projection omitted `ends_at`. |
| Both `calendar_events` and `reminders` return errors | Visible unavailable status, no availability claim | `events=[]`, `reminders=[]`, no data error/status field; actual `buildHints` returned “All clear — enjoy the quiet”. |
| Actual `nowAndNext`, now 09:00Z; event 08:30Z–08:45Z | No current event | Ended event returned as current. |
| Actual `nowAndNext`, now 09:00Z; event 06:00Z–10:00Z | Ongoing current event | `current=null`. |
| Actual `nowAndNext`, a future row marked `all_day=true` | Neutral, excluded from timed next selection | Returned as `next`. |

The browser fixtures used installed `@playwright/test` Chromium with real React/ReactDOM UMD builds, and transpiled the **actual current** hook, cache, database-error classifier, realtime publication map, display shell and pure display helpers. `https://kitchen-fixture.invalid` and every request were fulfilled locally by Playwright; there was no live account or network provider access. Supabase reads were controllable promises, and localStorage was the real browser implementation in a disposable context. No application files were rewritten to expose functions.

Observed hook results:

```json
[
  {"case":"owner-and-day-race","render":{"owner":"family-B","day":"2026-10-12","data":[{"id":"A-obsolete"}],"loading":false,"error":null}},
  {"case":"same-key-overlapping-refresh","render":{"owner":"family-B","day":"2026-11-12","data":[{"id":"older-realtime"}],"loading":false,"error":null},"cachedRows":[{"id":"older-realtime"}]},
  {"case":"thrown-fetch","render":{"owner":"family-C","day":"2026-12-12","data":[{"id":"older-realtime"}],"loading":true,"error":null},"unhandled":["Error: fixture network rejection"]},
  {"case":"owner-switch-offline-no-cache","render":{"owner":"family-D","day":"2027-01-12","data":[{"id":"older-realtime"}],"loading":false,"error":null}}
]
```

The race was produced by mounting A, mounting B, resolving B successfully, then resolving A. The same-key case invoked two refreshes and resolved the newer one first. The offline case switched to an uncached owner, set `navigator.onLine=false` and returned an error. `CalendarModule` hides rows while loading or error (`:416–417`), but the reproduced failures end with both guards cleared; the issue therefore survives those guards. Its family comes from `useApp` (`:184`), and its query dependencies include family plus month (`:240`). This proves the actual hook's mounted-component behavior; a complete authenticated family-switch journey and applied database boundaries remain untested.

Observed display-shell rerenders:

```text
Initial A:           family-A header, schedule tile, clock24=false
Refreshed A props:  requested reminders tile and clock24=true; schedule/false remained
Switched B props:  family-B header, requested reminders/true; schedule/false remained
```

The shell itself, state hooks, layout normalizers and DOM were real; peripheral weather/clock/icons were inert stubs. The clock stub exposed the actual `clock24` prop supplied by the shell. This verifies stale controlled state, not native clock/device behavior or successful layout persistence.

## Existing tests and freshness limits

Executed 2026-09-12 at 08:59 EDT / 12:59 UTC:

```text
node node_modules/vitest/vitest.mjs run tests/display-ambient.test.ts tests/display-render.test.ts tests/display-server-safety.test.ts tests/display-recover.test.ts tests/display-ask-handled-tiles.test.ts tests/display-setup-page.test.ts tests/display-wake-lock.test.ts tests/calendar-recurrence.test.ts tests/calendar-split-view.test.ts tests/offline-cache.test.ts tests/realtime-publication-drift.test.ts --reporter=dot --maxWorkers=4
```

**11 files / 151 tests passed.** The render robustness suite emits its existing React warning for an intentionally supplied `javascript:bad` image fixture. These tests do not invalidate the failures above: ambient tests explicitly expect the 90-minute heuristic, all-day coverage concerns only `current`, and cache tests do not mount the hook. No new test files were authored in this discovery lane. The inline probes ran with `@'…'@ | node`; their exact inputs, real modules, boundary substitutions and observed outputs are recorded above for conversion into maintained tests after ownership is agreed.

`components/display/auto-refresh.tsx:20–28` uses an interval, with a 12-hour bundle-age reload. It has no online/focus/visibility recovery or result freshness status. `/display`'s 120-second polling is an existing design choice, not a demonstrated claim of instant realtime delivery. Hidden-tab timer throttling, missed refreshes after sleep and old-day data until the next refresh remain scenarios to test. The shared calendar hook does subscribe to `calendar_events`; migration/publication source includes it in tranche 0269. Do not repeat an old “calendar is not published” claim. Actual deployed publication/replica identity was not queried. Cache entries can live for seven days and are capped at 200 rows (`lib/offline/cache.ts:20–21`); offline data has no exposed saved-time/stale marker in the hook's return type.

Additional calendar risk remains separate: `CalendarModule` uses browser-local window dates but groups starts with UTC `toISOString().slice(0,10)` (`:273–302`), and its nonrecurring query selects start dates only (`:246–248`). Recurrence expansion, multi-day display, different family/browser timezone combinations and daylight-saving transitions require maintained execution coverage; this lane has not called those complete.

## Narrow no-SQL repair proposal

1. **Fence the shared read hook first.** Own `lib/hooks/use-realtime-query.ts` and meaningful browser hook tests. Bind a request to a complete table/family/dependency key plus increasing request generation; ignore obsolete success, failure, cache writes and loading completion. Reset data/error/loading synchronously for a changed owner/key and hydrate an exact-key cache including a valid empty result. Catch thrown reads and keep an honest failure state. Capture the current fetcher with its key so an old callback cannot invoke a new-owner fetcher under an old cache key. Preserve the existing public API unless a separately reviewed freshness extension is needed. Verify two-family/window races, repeated same-key refreshes, missing/empty cache, offline switching, thrown reads, realtime callback/reconnect and unmount. This is shared code with many consumers, so run relevant existing query/cache suites and root's combined regression after focused browser tests.
2. **Make display time and availability explicit.** Own `app/(app)/display/page.tsx`, a pure `lib/display/calendar.ts` helper, `lib/display/ambient.ts`, and affected display components/tests. Carry validated family timezone/day key into queries and formatting. Use separate timed-instant versus stored all-day date bounds; `lib/briefing/calendar-window.ts` is existing source evidence for that distinction, but its current helper selects starts only and cannot be reused unchanged for overnight overlap. Select `ends_at`, use half-open overlaps for timed events, exclude all-day from timed now/next, and treat missing/invalid end as unknown or an explicitly documented narrow fallback. Test positive/negative offsets, both DST transitions, month/year boundaries, ended/ongoing/overnight events, invalid dates and all-day-only schedules.
3. **Represent read failure without crashing the kiosk.** Keep independent error status for today's events, upcoming events, month marks and canonical reminders; display retry/unavailable messaging and suppress “All clear”/countdown claims derived from unread data. Reuse the handled-today tile's honest status pattern. Align the reminder read with canonical `family_reminders` after proving create/read/completed/snoozed behavior. Keep legacy migration/mapping outside this change. Seeded error → retry → visible-data execution must prove recovery without turning failures into empty success.
4. **Reset/synchronize display-local ownership.** Key the client shell by family (and user if its local state is user-owned), reset editing/dismissal state on an owner change, and adopt refreshed persisted settings/layout only when not editing. Bind in-flight save/dismiss completion to the initiating owner; prevent old completion from changing the new family's state. Verify refreshed props, owner changes and delayed saves with actual React. A separate small AutoRefresh improvement can refresh on reconnect/return to visibility and at family day rollover, using bounded/coalesced requests, if desired after the core fixes.

Application source remains unchanged pending root's assignment of these scopes. All findings above are repository work, not blocked merely by credentials. Live database ownership/RLS, a real authenticated two-family workflow, display persistence across devices, and physical kiosk sleep/clock/timezone verification are distinct external or environment-dependent checks still open. Production readiness remains **NO**.
