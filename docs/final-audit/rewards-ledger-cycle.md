# Rewards ledger read and mutation cycle

Permanent audit ID: DATA-004. Local repairs are verified; the full rewards workflow and server/database authorization obligations remain open. Root owns the master audit status and combined gates.

## Reproduction and dependency path

The `/dashboard/rewards` page renders `components/modules/rewards-module.tsx`. Its catalog comes from `rewards`; available points depend on approved `chore_assignments` minus approved/fulfilled `reward_redemptions`, calculated by `lib/rewards/points.ts`. The original component consumed loading/error only for the catalog. Missing ledger rows therefore became zero earned or zero spent, and `canAfford` enabled or disabled requests using incomplete data.

A read-only browser reproduction on baseline `b80e55bf` executed the actual React component, production query hook and points helpers, and installed Supabase/PostgREST SDK against intercepted HTTP responses. The member had earned 100 points and already spent 100 on a fulfilled reward.

| Required redemption-history read | Display | Redemption action | Actual outgoing writes |
| --- | --- | --- | --- |
| Successful, containing the fulfilled row | `100 earned · 100 spent`; zero available | Disabled | None |
| HTTP 403 / `42501` | `100 earned · 0 spent`; 100 available, no read error | Enabled | POST of a new 100-point `requested` redemption; success toast |

The controlled persisted fixture grew from one redemption to two; its true computed available balance remained zero. This proves the false balance and outgoing unaffordable request. It does not prove live database acceptance, approval, or delivery of a reward.

The browser regression also reproduced two real handler callbacks in the same JavaScript turn issuing two POSTs before React committed `busy`. Initial harness assertions used the wrong permission wording and heading capitalization; those harness errors were corrected before recording the concrete duplicate-write failure (`expected 1`, `received 2`) and missing-history failure. Later catalog tests initially matched both the dialog and its textbox; selectors were corrected to the actual textbox role. These fixture corrections are not application defects.

## Repair

Only `components/modules/rewards-module.tsx` changes application behavior:

- Catalog and both ledger queries must finish successfully and revalidate cached rows before balances, approval decisions, or redemption affordances appear. Existing `ErrorState` offers a retry of all three required reads.
- Mutation handlers check the latest verified data, current reward/redemption rows, affordability, and the transitions supported by the UI. A retained callback cannot act using an earlier successful render after a required read fails or the balance changes.
- A synchronous component-level pending-write ref blocks duplicate callbacks and conflicting actions before React updates disabled controls. Pending catalog saves also block Cancel, Escape, and modal close; controlled draft inputs are disabled until completion.
- Successful catalog create/update/delete explicitly refreshes `rewards`. Request and decision writes refresh both ledger queries. These explicit reads are required because `rewards` and `reward_redemptions` are not in the repository's Realtime publication list.
- Returned and thrown mutation errors release pending state and retain editable drafts for retry. A successful write followed by failed readback shows unavailable data and blocks further dependent actions until retry succeeds.
- Unmount retires local callbacks. An already-issued write may still complete, but its late completion does not refresh an unmounted component or emit a stale toast.

Existing copy is reused. No locale catalogue, SQL, migration, shared navigation, dependency, or external system changes were made.

## Executed verification

`tests/e2e/rewards-ledger.spec.ts` executes the actual RewardsModule, production query hook and authenticated cache boundary, points helpers, shared modal/input/button/state components, and installed Supabase/PostgREST SDK in Chromium. Auth identity and Realtime delivery are controlled fixture boundaries. HTTP responses persist catalog/redemption mutations in memory and subsequent SDK GETs drive the rendered readback. All requests are intercepted; no live accounts, database writes, points, or external providers are involved.

Final focused run: **21 browser cases PASS in 3.0 seconds**, four workers, 10-second per-case limit.

- Failure, pending read, and saved-cache revalidation for each of the three required sources; no mutation and no verified balance until successful reads.
- Retry restores the real zero balance; sufficient verified points allow the expected request.
- Retained redemption callbacks after failed refresh and retained approval callbacks after balance changes cannot write.
- Same-turn duplicate request and form callbacks produce one write. Pending saves resist cancel/close until completion.
- Manager request → approval → fulfillment and rejection update the persisted fixture, approval queue, history, and affordability through actual follow-up reads.
- Catalog create/edit/delete and both form/delete cancellation paths produce the expected persisted results.
- Draft preservation through read retry and returned/thrown mutation failures; successful write with failed readback; unmount before an issued write completes.

`tests/rewards-points.test.ts`: **5 tests PASS**. Scoped ESLint and `git diff --check`: **PASS**. No full build, full suite, or full-project typecheck was run in this lane.

## Remaining obligations

This repair protects this component's normal workflow. It is not atomic server/database enforcement. The repository's only migration referencing `reward_redemptions`, `0028_reward_redemptions.sql`, defines a family-membership write policy without an affordability check. Raw endpoint bypass, hostile client payloads, cross-client concurrent approvals, and an atomic points/approval invariant require separate server/database work and live permission evidence. No SQL was changed or applied.

The existing ledger semantics remain: requested redemptions do not reserve points; only approved/fulfilled redemptions count as spent. The UI exposes rejection and fulfillment, not a cancellation endpoint for an already-requested redemption. Adjacent chores/rewards consumers, remote permission revocation, complete data pagination, real device behavior, and the full production audit remain unverified by this bounded cycle.
