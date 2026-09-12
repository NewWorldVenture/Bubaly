# Durable authenticated cache partition cycle

2026-09-12, implemented after root explicitly authorized this cycle on the existing PR 510 branch, following the b4 source checkpoint. Root owns the combined release gate and commits/push. This cycle does not change SQL, auth-provider settings, dependencies, cookie persistence, service-worker caching, navigation definitions or pricing rules.

## Completed behavior

Persistent query cache now requires an agreeing **SDK user/session ID and server-resolved access identity**. The access identity includes user, family, membership ID/revision, role, super-admin state, plan level and sorted feature-tier entries. A changed user, login session or observed server access identity cannot hydrate the previous partition, even if physical deletion failed and a new browser context still contains the old disk entry.

`lib/offline/cache.ts` adds v2 cache identities and envelopes. The full identity and full query signature must match; the compact storage-key hash alone never establishes equality. Legacy v1 rows are not adopted. Missing provider context uses network-only query behavior with no persistent read/write. Missing or malformed session discriminators disable persistence instead of choosing a shared fallback. The seven-day TTL, 200-row limit, stale/error semantics, generation fence and post-purge exact-write protection remain in place.

The session UUID is a stable discriminator across access-token refreshes, so an unchanged session/access identity preserves cache and component state. A new login session deliberately uses a different namespace, including a new login by the same user. No access token or refresh token is copied into the cache key or envelope. `session_id` is a namespace discriminator, not a new authorization mechanism; current server auth and RLS remain the enforcement boundary. [Supabase session claims](https://supabase.com/docs/guides/auth/sessions#access-token-jwt-claims).

## Source ownership and contracts

| Source | Result |
| --- | --- |
| `lib/auth/cache-session.ts` | One lazy browser SDK subscription and coalesced initial session read. Stable `{ userId, sessionId }` parsing requires UUID `sub` and `session_id`, with `sub` equal to the SDK session user. The store exposes restoring/ready/unavailable/signed-out states, an identity revision and non-bearer observed user ID. |
| `lib/offline/cache-scope.tsx` | `CacheAccessIdentity` and `AuthenticatedCacheBoundary` compare the session with server access props, provide immutable query scope and retire descendants on confirmed session/access changes. First agreeing bootstrap records the session without discarding already typed form data. |
| `lib/offline/cache.ts` | `cacheIdentity`, `readPartitionedCache` and `writePartitionedCache` require exact v2 envelope/query identity. Existing legacy helper API remains for compatibility, but the production query hook uses only the partitioned persistent API. |
| `lib/hooks/use-realtime-query.ts` | Includes session/access identity in its in-memory scope, masks obsolete rows before effects, and synchronously checks current auth revision, cache generation, active lifetime and latest request before response/error/cache/setter commits. Pending auth is loading; unavailable/family-mismatched auth is an explicit error. |
| `components/auth/session-keeper.tsx` | Consumes the shared observer rather than creating another auth subscription. Initial/foreground reconciliation shares the session read; changed-user initial sessions refresh the server tree. Existing 30-second lifecycle throttle, transient recovery and native cleanup containment remain. |
| Root-owned AppProvider and three server construction sites | The boundary wraps the inner stateful provider so roster/form/local rows retire as well. Membership ID and revision come from required `ctx.active.member`, independently of the optional/stale roster. Root's execution tests cover all three sites. |
| Root-owned seven base locale catalogues | Scope renders translated `auth.cacheSessionUnavailable`, `auth.cacheSessionChanged` and `auth.cacheFamilyMismatch`. The hook receives localized family-mismatch copy through its scope. |

The scope memo depends on semantic primitives, not a newly allocated full session object. The query scope captures its explicit identity dependencies. An unchanged TOKEN_REFRESHED event leaves the store identity, descendant lifetime and query partition stable. A transient failed read preserves both the last established identity and any observed different user; it cannot turn a blocked old server tree back into an allowed tree.

## Reproductions and corrective checks

The original AUTH-L04 reproduction seeded A's rows, switched to B in the same family, failed physical cache deletion, and restarted the browser context. With family-only keys and process-local purge bookkeeping, the old entry remained eligible for hydration. V2 owner/session/access matching prevents that path without requiring physical deletion to succeed.

Independent API review found two races during this implementation, both repaired and covered by maintained regressions:

1. **Delayed SDK INITIAL_SESSION:** the actual installed SDK's initial storage read of A can finish after a newer SIGNED_IN B/new-session event. Unconditionally accepting that callback restored A in the cache store while SDK storage held B. The store now retires INITIAL_SESSION after any newer non-initial auth event or completed explicit session read. It suppresses both the stale snapshot and its forwarding to SessionKeeper. Browser tests deliberately hold the SDK's actual initial storage read, assert that the stale SDK callback occurs, and verify that B/new-session ownership survives.
2. **Malformed new token plus transient error:** observing SDK user B with an invalid session discriminator correctly blocked A, but a later failed read initially erased the observed user ID. That allowed the old A subtree to reappear. Failed reads now preserve the last observed owner until newer identity evidence replaces it. The actual SDK/browser test verifies that the old tree stays blocked and no extra private REST read starts.

Explicit bootstrap reads are fenced by connection, auth-event revision and read sequence. Burst calls coalesce; a later lifecycle read can supersede one still pending after 30 seconds. INITIAL_SESSION null alone is not definite sign-out. A successful no-session read or explicit SIGNED_OUT is definite. A rejected/failed refresh does not invoke sign-out or delete valid auth cookies. Auth callbacks remain synchronous and do not call or await SDK session methods while holding the SDK callback lock.

## Executed verification

**68 Chromium tests passed**, maintained by the browser lane using actual React, AppProvider/boundary, hook/cache, installed Supabase SDK and SSR cookie adapter. Synthetic provider HTTP and database responses are fulfilled locally. No live credentials/accounts/provider calls or credential artifacts are used.

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER = '1'
node node_modules/@playwright/test/cli.js test tests/e2e/auth-cache-partition.spec.ts tests/e2e/realtime-query.spec.ts tests/e2e/auth-lifecycle-boundary.spec.ts tests/e2e/browser-session-storage.spec.ts --project=chromium --workers=2 --reporter=dot
```

The result comprises **22 partition tests, 32 shared-query tests, 12 auth-lifecycle tests and 2 browser-cookie tests**. It covers same-session restart; failed deletion across user/new-session restart; exact legacy-key refusal; no-provider network-only behavior; malformed tokens after previously saved v2 rows; stable token rotation; role/member/plan/feature access retirement; initial agreeing delayed bootstrap with typed form preservation; stale explicit and actual SDK bootstrap completion; warm refresh failure; blocked different-user retention; and an actual French LocaleProvider status message. There are no expected-failure markers.

**6 focused unit files / 114 tests passed**:

```powershell
node node_modules/vitest/vitest.mjs run tests/cache-session.test.ts tests/cache-partition.test.ts tests/offline-cache.test.ts tests/session-keeper.test.ts tests/auth-refresh-persistence.test.ts tests/mobile-device-sign-out.test.ts --reporter=dot --maxWorkers=4
```

The new store/envelope suites contribute 28 tests for exact identity/query matching, malformed metadata, legacy refusal, same-instant writes after failed deletion, failed replacement writes, singleton/disposal/SSR isolation, initial-event/read ordering, coalescing, same-session stability and error recovery. Existing SessionKeeper fixtures now use valid synthetic JWT namespace claims and explicitly account for shared initial bootstrap; native resume assertions advance past the existing lifecycle throttle.

Eight-file source/unit scoped lint passed; browser-lane scoped lint passed; owned diff whitespace checks passed. Root separately reported **22 passing tests across five provider/context suites**, including nine execution cases proving required server membership authority at all three AppProvider construction sites. No full suite/build/typecheck was run by this lane; root owns those combined checks.

## Precise remaining limits

- This closes persistent application-level cross-user/session hydration and partition changes for **observed server access identity**. It does not claim that a membership timestamp covers every row-sharing rule, global permission-table edit or RLS change. Immediate revocation while fully offline remains unprovable from existing local metadata; cached rows remain stale.
- A failed physical deletion may leave plaintext data on disk. Other app identities cannot hydrate it through this boundary, but this is not encrypted storage or protection against arbitrary same-origin script/storage tampering.
- A cold expired-session read that cannot refresh retains the saved data but does not hydrate it without a usable, agreeing session/access context. It does not force sign-out. An established warm session retains its namespace through transient errors.
- `public/sw.js` still deliberately does not cache authenticated HTML; a cold navigation while offline falls back to `/offline`. Same-session cache persistence does not establish a complete cold offline app startup workflow.
- The existing gated `tests/e2e/durable-session.spec.ts` covers real disposable-GoTrue restart/expiry/parallel refresh/local-device sign-out in CI. This lane did not duplicate or run that external-state journey. Physical Capacitor/Expo restart and deployed provider/session settings retain their separate verification requirements.
- Independent browser stores outside `lib/offline/cache.ts`, and the 22 query consumers that omit error handling, remain outside this bounded repair. No claim is made that all 231 workflows are complete merely because the central cache contract passes.

Source and maintained focused tests are ready for root's combined gate. Production readiness is governed by the master audit, not this cycle's passing subset.
