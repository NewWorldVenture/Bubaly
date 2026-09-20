# DATA-002 — Shared realtime query ownership and failure recovery

2026-09-12, audit worktree based on `c7b56eff`. This repair began after root created the master audit and assigned this bounded source scope. Only `lib/hooks/use-realtime-query.ts`, `tests/e2e/realtime-query.spec.ts` and this cycle document were changed in this repair. No SQL, dependency, global navigation, display page/shell, provider or production data was changed.

## Reproduction and repair

The current baseline failures were executed in real React/Chromium and recorded in `kitchen-discovery.md` (KITCHEN-D05/D06): a late family A request rendered A's rows under family B after B had loaded; an uncached offline owner inherited the previous owner's rows; an older overlapping refresh overwrote both newer data and persistent cache; and a thrown read left loading unresolved with an unhandled rejection.

The hook now scopes state to the table/family/dependency cache key and to that key's mounted lifetime. On the **first render** of a changed key, before effects run, old rows and errors are masked. A new scope loads only its exact-key cache, including a valid cached empty list. Successes, errors, loading completion and cache writes must belong to both the active scope and latest request. An A → B → A switch does not reactivate the first A request. Unmount/effect cleanup invalidates unfinished requests; retained callbacks cannot start a new owner's fetch under an old key.

Reads now catch thrown failures and return a nonempty `error` for missing-table, permission, transport and ordinary query failures. Cached same-key rows may remain available, but `stale=true` and the error distinguish a failed read from successful emptiness. The existing `data`, `loading`, `error`, `refresh` and `setData` API remains available; additive `stale` and `updatedAt` fields expose whether rows came from cache or a completed read. A successful network result, including an empty list, clears error/stale and records its completion time.

`setData` accepts both replacement arrays and functional updates, preserves batching, and is scoped to its initiating lifetime. Local edits supersede already-pending reads and are marked stale; they are not written to the persistent successful-read cache. A subsequent refresh verifies them through the existing read path. Realtime publication gating and the online-event refresh remain in place.

## Executed verification

The maintained browser suite transpiles the actual hook, cache, error classifier and publication decision, then mounts them with installed React/ReactDOM development builds in Chromium. LocalStorage, rendering, effects, cleanup, event dispatch and Strict Mode replay are real. Only Supabase transport is a controllable boundary. Every URL is fulfilled locally by Playwright in a disposable browser context; no Next server, credentials, database or provider account is needed.

Executed at approximately 09:08 EDT / 13:08 UTC:

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER = '1'
node node_modules/@playwright/test/cli.js test tests/e2e/realtime-query.spec.ts --project=chromium --workers=2 --reporter=line
```

**22 browser tests passed**, covering:

- Verified rows and verified empty results; exact-key empty/nonempty cache hydration and stale status.
- Immediate render masking on family, day-window and table changes; family/table changes when deps are omitted.
- Late prior-owner success/failure, A → B → A, and older same-key responses after newer responses.
- Cache write fencing, loading/error ownership, offline uncached owner changes and successful recovery.
- Missing-table and permission errors, thrown transport rejection and retry.
- Old refresh/setter callbacks, same-key fetcher updates, realtime/online events, unmount and publication gating.
- Replacement/functional setter batching, local-edit fencing and Strict Mode effect replay.

The focused existing regression command also passed **9 files / 354 tests**:

```text
node node_modules/vitest/vitest.mjs run tests/offline-cache.test.ts tests/realtime-publication-drift.test.ts tests/calendar-split-view.test.ts tests/calendar-recurrence.test.ts tests/contacts-localization.test.ts tests/files-hub-localization.test.ts tests/reminder-provenance-ui.test.ts tests/health-localization.test.ts tests/briefing-cache-isolation.test.ts --reporter=dot --maxWorkers=4
```

The files-hub localization fixture emitted its existing React key warnings. Scoped lint passed without warnings/errors:

```text
node node_modules/next/dist/bin/next lint --file lib/hooks/use-realtime-query.ts --file tests/e2e/realtime-query.spec.ts
```

`git diff --check` passed for owned files. No new full-project TypeScript run was started; root owns the combined typecheck/build/regression once lanes settle.

## Caller review and remaining scope

An AST scan of current `components`/`lib` source found **231 `useRealtimeQuery` calls**, all explicitly providing deps. Sampled calendar and reminder modules already render `error` and offer retry; the calendar's existing loading/error guards could not protect it from baseline races because those races cleared both flags. No direct destructuring consumer of `setData` was found, but the public setter contract is still preserved and execution-tested.

The same scan found **22 direct destructuring calls that omit `error`**, including `components/finance/budgets-view.tsx:29`, `components/finance/bills-view.tsx:36`, other finance views, moments and some supplemental data readers. Those callers require their own workflow review: exposing an honest error in the hook does not prove every caller shows it or suppresses derived claims. Existing UI regression tests that mock this hook also cannot establish actual fetch failure behavior. This cycle closes the reproduced shared-hook key/request race and read-failure contract; it does not mark all 231 workflows complete.

The supplied persistent key consists of table, family and serialized caller deps. The hook receives no authenticated user, role, membership revision or permission epoch. Therefore this repair **does not prove user/role cache partitioning or authorization freshness** when those identities change while the supplied key remains equal. The follow-up below covers observed definitive auth transitions and pending-read purge races; a durable auth-aware cache identity and actual role-switch workflow remain open. Existing seven-day TTL, 200-row cap and serialized persistent key were not changed; callers must treat cached data as stale and cannot infer complete or current authorization from it.

Pending transport promises are fenced, not aborted: the existing fetcher contract accepts a Supabase client but no cancellation signal. Live database RLS, actual deployed publication/replica identity, authenticated multi-family/browser navigation, reconnect behavior against Supabase and user-visible stale/error treatment remain unverified. The separate display timezone/overnight/availability/read-status/layout and canonical-reminder findings in `kitchen-discovery.md` were not modified by this repair. Production readiness remains **NO**.

## Auth purge follow-up, 09:22 EDT

Root separately authorized `lib/offline/cache.ts` plus the shared hook after `auth-persistence-cycle.md` reproduced an old request refilling a cache cleared by SIGNED_OUT. `clearAllCache()` now advances a generation even with blocked storage and notifies mounted hooks. `useSyncExternalStore` includes that generation in the scope, masks old rows on the next render and starts a fresh read. Response/cache commits, old refresh callbacks and old setters synchronously reject a superseded generation before React effects can run.

Readable old entries can survive a failed `removeItem`. After invalidation, cache reads therefore require an exact serialized value successfully written after the purge in this module lifetime, tracked per Storage object. The follow-up execution also covers unavailable storage later becoming readable and post-purge writes in the same millisecond. This in-memory fence does not establish a durable user partition after browser restart if physical deletion failed.

The browser suite now has **32 passing tests**, adding purge render masking, old response success/error/throw, obsolete refresh/setter callbacks, unavailable storage, unmount, failed deletion, recovered storage, remount and same-instant fresh-write cases. Combined with 12 auth-lifecycle and 2 real-installed-SDK cookie tests, **46 ordinary browser tests passed with zero expected failures**. Focused existing regression: **12 files / 436 passed**. Six-file scoped lint and diff checks passed. Source is stable for root's combined gate; the broader authorization/deployment limits above remain open.
