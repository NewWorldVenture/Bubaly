# Durable authenticated cache partition proposal

Read-only investigation, 2026-09-12; inspected source through HEAD `cbfa060250494969e0669a80c5c95ae6de3f8705`. No application changes or new test executions in this lane. The current PR source freeze remains in force.

## Recommended next scope

Add a versioned persistent cache namespace derived centrally from **user, stable auth session, family and the server-resolved membership/access identity**. Make every cache envelope carry that exact identity and query signature, and refuse envelopes whose identity differs. Retain the existing synchronous generation/request fences. This prevents another user, a new login session, or an observed role change from reading abandoned cache entries even if physical deletion failed and the browser restarted.

Do not try to solve this by adding `userId` to 231 call sites, deleting cache on every token refresh, or deriving the owner from the cached rows themselves. A stable session identifier preserves same-session cache through token rotation and restart, while a new login gets a different namespace. Supabase documents the access-token `session_id` claim as the UUID identifying an auth session. It is a namespace discriminator, not a replacement for server authorization or revocation checks. [Supabase session claims](https://supabase.com/docs/guides/auth/sessions#access-token-jwt-claims).

This can close **persistent cross-owner/session mixing and observed role partition changes**. It cannot honestly guarantee immediate recognition of a remote permission revocation while fully offline. No existing global permission revision covers all row-level sharing/RLS decisions. Treat that as an explicit remaining authorization-freshness policy, rather than claiming a user/role key proves every cached row is still permitted.

## Current authoritative paths

| Evidence | Implication |
| --- | --- |
| `lib/supabase/auth.ts:109` gets the authenticated user, then requires successful active `family_members` and family reads. `ctx.active.member` includes member ID, role, active flag and `updated_at`. | This is the appropriate source for membership identity. No schema change or additional roster query is required. |
| `components/app/app-frame.tsx:78`, `app/(app)/family/layout.tsx:53`, `app/(app)/capture/layout.tsx:45` are the three production AppProvider construction sites. | Pass membership ID/revision from `ctx.active.member` at these three points. Existing values already include user ID, family ID, role and super-admin state. |
| `components/app/app-context.tsx:13` defines user/family/role values; `:52` initializes a separate member roster with `useState(initialMembers)`; `:83` derives `selfMember` from that roster. | Use the server-provided identity, not `selfMember`, as the cache authority. The roster is optional/fallback data, can lag prop changes, and its refresh does not update `value.role`. |
| AST scan: **231 calls in 111 files**. 109 files directly call `useApp`; `components/concierge/working-on.tsx` and `run-timeline.tsx` are the only two exceptions. Their current callers are dashboard/home/run routes under AppFrame. | A cache context inside AppProvider can cover the shared hook centrally, including those four calls in the two exception files. No consumer rewrite is needed for the cache namespace. |
| The only production imports using this cache's `cacheKey/readCache/writeCache` are in `lib/hooks/use-realtime-query.ts`. Similarly named capture-shortcut helpers are independent. | Change this cache/hook boundary once. Do not silently claim unrelated browser caches are covered. |
| `components/auth/session-keeper.tsx` already observes definite sign-out/user transitions, reconciles foreground identity and advances cache invalidation. | Extend its coordinated session observation; preserve its transient-error/revocation behavior and synchronous retirement fence. |
| `components/concierge/working-on.tsx:52` copies data into its own component state. Other components may also retain derived/local rows. | Changing only the hook's key cannot guarantee old component-local data disappears during account changes. A keyed authenticated subtree boundary must retire old descendants on a confirmed owner/access change. |
| `public/sw.js:5` and `:36` intentionally never persist authenticated HTML. A failed cold navigation falls back to `/offline`. | Current full cold offline app startup is not available. Preserving a durable same-session cache is a narrower requirement and should not expand service-worker caching. |

The current published-table allowlist does not include `family_members`; AppProvider's guarded roster subscription therefore does not provide a live permission-change signal. SQL source has membership `updated_at` maintenance, but this proposal neither audits the live trigger nor treats that timestamp as a revision for every authorization policy.

## Concrete data and lifecycle contract

1. **Immutable permission context.** A small new `lib/offline/cache-scope.tsx` context receives the server-resolved `{ userId, familyId, memberId, membershipUpdatedAt, role, isSuperAdmin }`. Include effective plan/feature access inputs if the corresponding cache actually relies on those gates; these already exist in AppProvider. Serialize deterministically, retaining the full identity in the envelope. A membership timestamp is a conservative invalidator, so an unrelated member edit may discard cache; document that small availability cost. Never publish a mutable global family/role from render or share it across SSR requests.

2. **One browser session snapshot.** Add a small browser-only external store, for example `lib/auth/cache-session.ts`, driven by the existing singleton Supabase client. Bootstrap once and subscribe once, with states `restoring`, `ready`, `unavailable`, `signed-out`; retain a prior ready snapshot through a transient refresh failure. Expose only `{ userId, sessionId, revision }`, never bearer tokens, email or provider secrets. Extract and validate the UUID `session_id` from the SDK session solely to select the namespace; verify its `sub` agrees with the SDK user and the server context. No `user_metadata.role` authorization. Missing/malformed identifiers disable persistent hydration rather than falling back to a shared namespace. The SDK's locally read session is not server authorization. [Supabase getSession trust boundary](https://supabase.com/docs/reference/javascript/auth-getsession).

3. **Bootstrap fence.** A pending or mismatched session snapshot must never hydrate disk cache under the server tree's previous user. Use the context plus the session store's current revision in the hook scope before effects. Wait for an agreeing ready identity before hydrating/persisting and before committing identity-dependent in-flight results. Render pending/error state honestly; do not call a lack of identity a successful empty query. A restored session matching the server identity can reuse its partition. A different observed user immediately retires the old authenticated subtree and triggers the existing server refresh; the old server context cannot bless the new user. Definitive sign-out leaves no readable partition. Avoid a separate `getSession()` at each hook call or duplicating token-refresh machinery.

4. **Versioned key and exact envelope.** Use a namespace shaped like `bub:cache:v2:<encoded owner/session/access identity>:<table>:<query digest>`. Envelope: `{ version: 2, owner, familyId, accessIdentity, table, querySignature, rows, savedAt }`. Validate every identity field and the complete query signature against the requested scope before accepting rows. The existing 32-bit query hash alone cannot establish equality; envelope comparison prevents a digest collision from crossing queries. Keep the current seven-day TTL, 200-row bound, stale marker and error semantics. Do not include the rotating access/refresh token, token expiry, last-focus time or a random value regenerated on mount in the identity.

5. **Retirement independent of deletion.** Never import unowned v1 entries into v2; old cache entries are harmless only insofar as the application never hydrates them. On definitive logout/different session, retire the in-memory scope synchronously, then attempt deletion. A fresh login has a fresh session namespace, so leftover rows cannot become readable merely because `removeItem` failed or the process restarted. Keep the current generation and post-purge exact-write bookkeeping for same-process races. A server role/membership revision change retires the old access partition. Unchanged same-user/same-session/same-access refresh retains cache and forms. Same-user sign-out followed by sign-in is deliberately a new partition.

6. **Descendant state and cross-tab behavior.** AppProvider should wrap its descendants in a keyed scope boundary so a confirmed user/session/family/access change remounts local row/form state. This changes the provider boundary, not global navigation definitions. Key on stable identity, never token refresh time. Use one coordinated auth event stream; test Supabase cross-tab events and foreground cookie reconciliation. A same-origin invalidation notification may accelerate retirement in another tab, but carries no authority to activate a partition. No cache key or localStorage owner marker may establish who is signed in.

7. **Observed permission changes versus offline policy.** A newly server-resolved role/member/access value changes the partition immediately. While online, a bounded central refresh on foreground/session reconciliation should obtain current context; a failed membership read is an error, not “still a parent.” Do not claim that `family_members.updated_at` captures changes to per-row visibility, sharing, global permission tables or arbitrary RLS migrations. Strict immediate revocation requires an online authorization check or a complete server-issued authorization epoch; neither can be inferred from current cache metadata. During an existing session's offline period, any allowed cached display remains explicitly stale and reflects the last verified access context.

The scope described here should not add encrypted storage or a new authorization database model. Namespace isolation prevents application-level cross-owner hydration; it does not erase plaintext from a disk where deletion was denied or defend against arbitrary same-origin script/storage tampering. Those are different guarantees.

## Preserve same-user persistence without inventing offline startup

Do not clear or rotate the partition on `INITIAL_SESSION`, `TOKEN_REFRESHED`, a normal page mount, a transient refresh failure, or online/offline events alone. An unexpired restored SDK session with the same session ID and agreeing server membership identity should hydrate the same saved rows after a new context; token rotation with that same session ID should also preserve it.

For a cold expired-session bootstrap while the provider is unreachable, the SDK can retain cookies but return a refresh error without a usable session result. Do not infer the current user from the cached rows or silently erase a saved partition in that case: keep it unreadable and retained until auth/context can be reconciled. This does not force a sign-out. Supporting a full cold offline authenticated app with no usable session/context would require a separate, explicit offline authorization and shell design; the current service worker does not support that workflow. In an already running, previously established session, transient refresh errors retain that established namespace, with stale data/error status unchanged.

## Specific ownership for a future authorized implementation

| Files | Bounded responsibility |
| --- | --- |
| New `lib/auth/cache-session.ts` | Singleton browser session discriminator, restoring/error states, revision fencing and observer cleanup. |
| New `lib/offline/cache-scope.tsx` | Pure immutable permission context plus stable scope derivation; no server-to-browser token serialization. |
| `components/auth/session-keeper.tsx` | Coordinate auth/session retirement and server refresh with the new store; preserve existing retry/throttle/cleanup behavior. |
| `components/app/app-context.tsx` | Supply the scope context and key/reset descendants only on confirmed identity/access changes; do not derive authority from stale roster state. |
| `components/app/app-frame.tsx`, `app/(app)/family/layout.tsx`, `app/(app)/capture/layout.tsx` | Pass required `ctx.active.member` identity/revision at all three provider construction sites. No changes to menu, links or route pricing. |
| `lib/offline/cache.ts` | v2 key/envelope equality, refusal of legacy/unowned entries, retirement behavior and safe same-session reuse. |
| `lib/hooks/use-realtime-query.ts` | Consume optional central scope, synchronous owner/session/access/generation/request fencing, no cache fallback without an agreeing scope. Preserve public caller API. |
| New focused tests plus the three existing controlled-browser suites | Verify actual store/provider/hook/storage behavior; synthetic credentials only. |

If a future caller uses the hook without a provider, persistence must be disabled rather than assigned a default owner. The implementation can preserve its network-only API or surface a clear developer contract error, but must not restore the old unpartitioned cache as a fallback. Current production ancestry should be asserted in a small import/route contract test and validated with actual representative renders.

## Executable verification plan

Extend the existing `tests/e2e/browser-session-storage.spec.ts` harness: actual installed Supabase SDK, SSR cookie adapter and browser client; synthetic JWTs gain valid fixture `session_id` and `sub` claims. Add a new `tests/e2e/auth-cache-partition.spec.ts` that mounts the actual new store/context, AppProvider and shared hook with React/Chromium. Provider HTTP remains entirely fulfilled by local Playwright routes. No real account, live token, SQL or stored credential artifact is needed.

| Test | Required observable result |
| --- | --- |
| Same user/session/access, fresh browser context with persisted cookies and cache | Same cache hydrates stale; no new login; unrelated preferences survive. |
| Same session ID, rotated synthetic access/refresh tokens | Partition and local form state remain stable. |
| A → B, same family/query, deletion throws, close/open context | B never renders or reads A's rows; physical A entry can still exist as a positive control. |
| Same user, explicit sign-out, new session ID, deletion throws, restart | New login cannot hydrate the old session's rows. |
| Stale A server tree, B SDK bootstrap; held/late getSession result | No A cache hydration and no B result committed under A; old bootstrap cannot replace the newer auth event. |
| Legacy v1 cache, malformed/missing session ID, missing scope, envelope/query-digest collision | No persistent hydration; explicit pending/error behavior where applicable. |
| Same user/family, parent → guest or membership revision changes | Old partition and child-local copied rows disappear before effects; old fetch/setter/cache commits are fenced. |
| Failed membership/context read | No new authority is granted and no “empty successful” read is fabricated. |
| Warm-session transient refresh failure, then recovery | Existing same-session cache remains stale/available according to current policy; no logout or namespace reset. |
| Cold expired-session refresh failure | Retain disk data without hydration or logout; successful later reconciliation resumes the correct partition. |
| Two same-origin pages, logout/account switch in one, other suspended | Auth event/foreground reconciliation retires old rows; generation prevents old pending callbacks from refilling any active partition. |
| Blocked storage, partial deletion, storage recovery, exact same-millisecond post-retirement write | Existing purge protections hold; new valid writes hydrate only for the matching identity. |
| Strict Mode, provider replacement, unmount, route transitions through all three provider sites | One logical session observer lifecycle, no leaked listeners, no old-user form/row state, no dependency on 231 caller edits. |

Suggested scoped commands after implementation, **not run in this proposal lane**:

```powershell
$env:PLAYWRIGHT_EXTERNAL_SERVER = '1'
node node_modules/@playwright/test/cli.js test tests/e2e/auth-cache-partition.spec.ts tests/e2e/realtime-query.spec.ts tests/e2e/auth-lifecycle-boundary.spec.ts tests/e2e/browser-session-storage.spec.ts --project=chromium --workers=2 --reporter=dot
node node_modules/vitest/vitest.mjs run tests/offline-cache.test.ts tests/session-keeper.test.ts tests/auth-refresh-persistence.test.ts tests/auth-context-integrity.test.ts tests/auth-context-error-contract.test.ts tests/mobile-device-sign-out.test.ts --reporter=dot --maxWorkers=4
```

Add unit cases for deterministic identity serialization, exact-envelope/query comparison, session UUID parsing, malformed metadata and store transition ordering. Existing app-context test mocks will need the central optional cache provider boundary, not hundreds of changed feature assertions. Root should run one combined typecheck/build/full suite after that future lane stabilizes. Real deployed RLS, physical native restart and the already gated disposable-GoTrue journeys retain their separate verification requirements.
