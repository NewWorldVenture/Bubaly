# Bubaly production rollout review — 2026-10-08

Prepared at the owner's request. **Review package only; not an approved apply
bundle.** Production writes, configuration changes, migration promotion, merge
and deployment remain unauthorized. None was performed in preparing this package.

Target: `ltcxlbipiihclxwioyqj` (Bubaly), PostgreSQL 17.6. Source candidate is
#969 at `b7a986eefd36c43a0ddafb187e808365f856c697`, with the native recurrence
repair in draft #972. Main remains `82f2db1fcd0dca59179d2b391a76acfd459e480b`.
All six applicable hosted checks for #972 at `20d9d447f` passed, including full
Core, Database, Mobile and E2E; that is source acceptance, not production acceptance.

## Evidence and reproducible preflight

- [Boundary query](boundary.query.sql) and [01:05 UTC snapshot](boundary.snapshot.json):
  read-only metadata scoped to the existing forward-release contract.
- [Offline review](review.json): pinned file checksums, complete ledger delta,
  policy/function deltas, required-table checks, held file inventory, and
  qualified table-reference review inputs. Reproduce from the repository root:
  `node docs/final-audit/rollout-20261008/review.mjs`.
  The program reads files only, accepts no apply options and does not use credentials.
- [Known helper definitions](helper-definitions.json): targeted metadata read
  explains the two hash differences without reading family records.
- [Schema prerequisites](../schema-prerequisites-20261008.json): 41 of 52 checks
  incomplete, including 34 missing tables and missing columns on six existing
  tables. This is not a REST/ACL/behavioral test.

The existing release's 15 checksums still match. Its unmodified source-inventory
gate rejects migrations after 0254; its unmodified live preflight rejects the
192-entry ledger against its three-entry baseline. Both are correct refusals.

| Boundary | Old manifest | Observed production | Review consequence |
|---|---|---|---|
| Ledger | 0001–0003 only | 192 entries, lexical high-water 0176 | Reconcile exact `(version,name)` entries; do not stamp or replay history. |
| Columns | 113 | Same 113 | No difference in this bounded set. |
| Constraints | 40 | Same 40 | No difference in this bounded set; not all production FKs. |
| Policies | 37 | 45; 24 added/changed and 16 removed/changed rows | Review the wallet changes; retain restrictive guards throughout. |
| Helpers | Four hashes | Two match; `mark_model_dirty` and `set_updated_at` differ | Review actual definitions before replacing either. |
| Required protected tables | 16 | All 16 present with RLS | Foundation prerequisites satisfied at this boundary. |
| New foundation tables | 33 expected absent | All 33 absent | No conflicting pre-existing table in this set. |
| Worker RPC | Released expectation: service only | `claim_ai_runs(integer,integer)` absent | Create only with reviewed dependencies and explicit ACLs. |

The live `mark_model_dirty` still inserts for a vanished family and lacks 0249's
existence/FK-race guards. This is definition evidence, not a production deletion
test. `set_updated_at` is a short PL/pgSQL timestamp trigger; a differing hash is
not alone evidence of unsafe behavior. Anonymous wallet write grants remain;
authenticated restrictive policies currently guard the member write union.
Review grants separately; do not use an absent ledger entry to infer absent guards.

## Money-policy screening repair

The audit now matches restrictive manager guards to every permissive write's
commands and roles. It recognizes only direct manager predicates in all required
clauses, including both UPDATE clauses. An INSERT guard, an unrelated audience,
`true`, `NOT can_manage_family(...)`, or an `OR true` expression cannot produce
a false closure. Both hand-run SQL diagnostics use the same conservative rule.
[Ten isolated PostgreSQL 17 fixture cases](money-policy-fixture-results.json)
verify parity between the automated catalog verdict and both SQL queries.
These are synthetic metadata tests, not production financial transactions.
Unrecognized safe predicates may be flagged; actual exploitability still requires
grants, role inheritance and helper semantics review. Historical snapshots retain
their original collection format and must not be treated as fresh role-aware results.

## Fresh production money-policy review

The [01:22 UTC command/role snapshot](money-policy-live-snapshot.json),
[exact query](money-policy-live-query.sql) and [conservative verdict](money-policy-live-verdict.json)
cover all eleven money tables and 71 write policies. Five wallet tables have
matching authenticated guards. The six flagged tables require different conclusions:

- **allowance_rules:** the actual catalog has one authenticated permissive ALL
  membership policy and no restrictive manager guard. Authenticated has all three
  write grants. The [helper/policy/grant receipt](money-policy-live-details.json)
  confirms membership includes active child members, while manager means active
  parent/adult. This is a verified missing manager boundary in metadata; no live
  allowance row or payment was created, modified or read. Existing migration
  **0306** contains the missing three guards. Include its complete scope in release
  dependency review: it also installs an investment economics trigger, so it must
  not be blindly replayed or treated as an allowance-only patch.
- **bills, budgets, financial_accounts, transactions, savings_goals:** public-role
  membership policies exceed the audience of authenticated-only restrictive guards,
  so conservative screening flags them. Every authenticated caller still receives
  matching manager guards. The actual membership helper requires `auth.uid()` and
  active membership; an unauthenticated anon session has no matching UID. Anonymous
  grants alone therefore do not establish a write path. Review other role audiences
  and grants before extending this conclusion; no live exploit is claimed.

The [detail query](money-policy-live-details.sql) reads only catalog definitions
and privilege metadata. This narrows the screening candidates without changing
production. The missing allowance guard is an additional concrete release hold.

## Migration 0306 and existing-data preflight

[01:32 UTC metadata](migration-0306-live-metadata.json) and its
[query](migration-0306-live-metadata.sql) confirm both investment tables and the
required columns exist, but `invest_order_economics_guard` and its trigger are
absent. The investment decision-status trigger from0304 is also absent. The
retained `invest_decide_order` definition still contains the uncast CASE addressed
by0447; that is definition evidence, not a live approval attempt. These later
protections belong in dependency review alongside0306. The same receipt also
confirms the allowance family-reference trigger from0311 is absent. Source0311
already guards that reference for authenticated writes; it does not reconcile
existing records, and it does not wire the investment-order wallet reference.

A separate [01:33 UTC aggregate-only preflight](money-data-preflight.json)
([SELECT](money-data-preflight.sql)) found:

| Check | Count |
|---|---:|
| Investment orders | 1,000 |
| Pending orders | 125 |
| Orders whose amount differs from rounded shares × stored price | 500 |
| Pending orders with that amount mismatch | 0 |
| Orders whose family differs from their referenced child wallet | 500 |
| Allowance rules whose family differs from their referenced child wallet | 500 |

These counts overlap and must not be summed as distinct affected records. They
establish existing-data inconsistencies under the repository's intended
relationships; they do not establish provenance, malicious activity or a payment
having occurred. No individual rows, identifiers or monetary values were returned,
and no row or balance was changed.

**Release hold:**0306 does not reconcile historical rows or establish composite
family/wallet foreign keys. Its economics trigger also intentionally skips a
status-only update when the stored economics did not change. Do not treat merely
installing it as historical-data acceptance. A reviewed disposition of these
existing mismatches, dependency review of0311 for allowance writes, and a reviewed
future-write integrity design for the investment reference are required before
rollout can be approved. Do not automatically delete, reassign,
reprice, approve or replay any of these records. A refreshed aggregate preflight
must be included in the eventual release decision.

## Concrete future-reference integrity candidate

The [unallocated SQL candidate](wallet-family-integrity.candidate.sql) adds a
supporting unique key on child_wallets(family_id,id), child lookup indexes on
(child_wallet_id,family_id), and two composite foreign
keys from allowance_rules and invest_orders. Both FKs are explicitly **NOT VALID**:
new reference writes are checked, while existing mismatches remain untouched.
The candidate is outside supabase/migrations and every apply workflow. It has no
migration number, is not approved for production, and must not be silently added
to the old release manifest.

[Fixture setup](wallet-family-integrity.fixture.sql),
[assertions](wallet-family-integrity.assertions.sql) and
[PostgreSQL receipt with file hashes](wallet-family-integrity.fixture-results.json)
verify transaction rollback, retained historical rows, accepted same-family
references, refused cross-family inserts/reference changes, refused parent-family
moves, and failed validation while historical inconsistencies remain. Unrelated
updates to historical rows still succeed without repairing their bad reference.

The fixture uses only minimal structural tables and fabricated IDs. It does not
reproduce the full production schema, RLS, other triggers, traffic or financial
operations. Before inclusion in a release, review lock/index cost, existing
constraint-name collisions, parent wallet relocation semantics, full trigger/RLS
composition, the exact once-only migration/ledger protocol, and recorded ownership
of the historical rows. Failed preconditions must roll back, not bypass guards.
The original id-only FKs are retained; no old constraint or row is removed.
Separate reconciliation and validation remain release gates.

## Priority RPC grants and managed advisor review

The [read-only function definitions](priority-rpc-definitions.json),
[collection query](priority-rpc-definitions.sql) and
[effective ACL catalog](definer-acl-catalog.json) confirm:

- `wallet_reserve_card_auth` grants EXECUTE to anon and authenticated; its definer
  body performs no caller identity check. `marketplace_place_bid_unchecked`
  grants EXECUTE to anon and also has no caller check. Existing
  [0456](../../../supabase/migrations/0456_service_only_functions_are_service_only.sql)
  explicitly revokes PUBLIC and both client roles while retaining service_role.
  **Prioritize a separately reviewed ACL stage.** Neither live function was called.
- `claim_marketing_generation_jobs` is likewise client-executable without a
  caller check. Source0292 repairs it, but [signature preflight](priority-rpc-prerequisites.json)
  confirms0292's `claim_ai_runs(integer,integer)` prerequisite is absent. Do not
  blindly apply that whole migration; compose the reviewed dependencies or an
  explicitly allocated focused grant release.
- `rate_limit_hit` is anon-executable and its current body lacks0179's
  authenticated namespace check. Both rate-limit signatures exist, but0179 still
  needs full caller/dependency review before release.
- `enqueue_marketing_page_generation` returns trigger. Its EXECUTE advisory is
  not evidence of a directly usable REST RPC. `__seed_existing_count` is an
  invoker function, not a definer; its provenance remains to be established.

The [exact0456 fixture receipt](0456-acl.fixture-results.json) binds the original
migration bytes and [harmless stub setup](0456-acl.fixture.sql).
The retained [local fixture runner](0456-acl.fixture.mjs) tests rollback, a second
application, actual denied anon/authenticated calls, allowed service-role stub
calls, and refusal/rollback if an inherited grant survives. No wallet/bid code,
financial record or live function executes. The runner requires a fresh local
PostgreSQL17 container named `bubaly-audit-acl-20261008` on the explicit local
Docker socket, with database `bubaly_acl_fixture_20261008`; it accepts no remote
connection or apply options. These checks support review of0456's ACL behavior,
not production REST reachability or the complete release composition.

[Normalized security advisories](advisors-security-20261008.json) and
[performance advisories](advisors-performance-20261008.json) retain all returned
finding metadata at01:51UTC. Advisory groups overlap and are not counts of
verified vulnerabilities or measured performance defects:

| Advisory | Count | Review treatment |
|---|---:|---|
| [RLS enabled, no policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) | 55 | Default deny can be intentional for backend tables; do not add client policies merely to silence this. |
| [Mutable function search path](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable) | 8 | Review each body and caller privilege before changing it. |
| [Extensions in public](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public) | 2 | Review schema dependencies before relocation. |
| [Anon definer EXECUTE](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable) | 44 | Catalog separates12trigger functions from32non-trigger entries; priority cases above have concrete grant/body evidence. |
| [Authenticated definer EXECUTE](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) | 48 | Intended checked RPCs and unsafe unguarded helpers require different treatment. |
| [Leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) | 1 | Auth configuration decision; no setting was changed. |
| [Unindexed FKs](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) | 766 | Review workload and lock/index cost; this prompted child indexes in the unallocated reference candidate. |
| [RLS initplan](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan) | 78 | Preserve authorization semantics when optimizing policy expressions. |
| [Unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) | 198 | No automatic removal; observation period and workload are not established. |
| [Multiple permissive policies](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies) | 255 | Reconcile intended union and restrictive guards before changing policies. |
| [Auth connection allocation](https://supabase.com/docs/guides/deployment/going-into-prod) | 1 | Configuration review only; unchanged. |

## Proposed stages and acceptance gates

| Stage | Concrete source/scope | Gate before proceeding |
|---|---|---|
| 0. Reconcile baseline | Exact ledger and boundary in this package; preserve every historical row | Owner reviews the observed drift. Refresh the same read-only metadata immediately before rehearsal/apply. Never replace the three-entry baseline merely to make a guard pass. |
| 1. Review foundation | Existing 0240–0248 feature tables, 0249 deletion trigger, 0250 AI runtime, 0251–0255 trust/write/worker protections, 0257 settings, 0258 briefs and 0259 schedules | Establish a complete dependency and security closure against current application source. The 0240–0254 legacy bundle alone is insufficient. Review later fixes and held 0492/0493 privacy requirements before enabling new raw AI tables. |
| 2. Review later hardening | The hashed qualified-reference inventory in review.json includes 0263, 0264, 0271, 0274, 0294 and 0321 | These are review inputs, not an apply list: dynamic/unqualified SQL and dependencies on other tables require manual reconciliation. Do not replay unrelated finance/data migrations to satisfy a broad range. |
| 3. Review messaging | Runnable 0475/0476, unchanged names and allocations | Prove recorded audience preservation, fresh empty Family Chat, actor/parent locks, retries, notification-key conversion/replay and ACLs against the reconciled baseline. Do not rewrite historical 0293. Preserve the public Storage decision. |
| 4. Resolve held contracts | Bill 0488; feed 0490; approval 0492; private AI 0493; atomic sync 0494 | Their owners must resolve reservations and approve a release composition. They stay under `supabase/reserved/`; no fillers or promotion here. Their absence currently blocks the corresponding application paths. |
| 5. Rehearse reviewed candidate | A newly reviewed, checksum-pinned exact apply bundle and schema-only baseline fixture | Disposable PostgreSQL/Supabase only. Replay twice where supported, simulate failures/rollback and concurrent role changes, run denial/ACL/FK/data-preservation controls. Existing fresh-chain CI does not reproduce this drifted production baseline. |
| 6. Request apply approval | Exact bundle hash, current target/ledger/catalog hashes, rehearsal receipts, data-effects inventory and operator recovery plan | A separately scoped approval is required. This package is not yet ready for that approval: stages 1–5 still contain review/rehearsal gates. No production workflow is dispatched. |
| 7. Separate application rollout | Only the exact source verified against the released contracts | Fresh metadata, zero-row API exposure checks and non-destructive authorized smoke checks pass first. Deployment needs separate approval; SQL application does not gate Vercel automatically. |

Stage 1's listed versions are a minimum review scope, not a contiguous executable
range or an instruction to insert missing generations. The legacy release
manifest and both production workflows are unchanged. No review-only artifact in
this directory is read by either apply workflow.

## Required rehearsal and recovery details

1. Construct the disposable baseline from reviewed schema metadata, not production
   family rows. The current snapshot omits general trigger/function bodies,
   defaults and data distributions; it is insufficient to claim an exact clone.
   Obtain a reviewed schema-only representation or explicitly enumerate every
   simulated baseline difference before calling the rehearsal representative.
2. Hold an advisory lock and lock the ledger within the eventual apply transaction;
   recheck exact project identity, ledger, catalog and file hashes inside it.
   Retain bounded lock/statement timeouts. No guard may be disabled for convenience.
3. Test failure before the first DDL, midway through the bundle and at each security
   postcondition. Confirm transaction rollback preserves ledger, schema and synthetic
   data. Test lost-response handling: read ledger/catalog, never blindly retry.
4. Exercise manager/member/child/anonymous denial controls in the disposable stack,
   including missing restrictive policy negative controls. Verify service-only RPC
   ACLs, family-consistent FKs, messaging concurrency and exact counted reads.
5. Explicitly inventory data effects: 0250 changes legacy AI provider labels and
   0251 sets expiry on old pending approvals. Test synthetic old records. Do not
   treat additive table creation as proof that the whole bundle is data-free.
6. Before future production approval, the operator must confirm a restorable
   recovery point and a tested restoration procedure. Neither backup coverage nor
   restore readiness was verified here. Transaction rollback covers failures before
   commit; after commit there is **no approved down-migration**. Keep the prior app
   source available, stop rollout, inspect metadata, and prepare a reviewed forward
   repair. Dropping new tables would destroy later writes and is not a rollback plan.

## Explicitly excluded actions

No `db push`, `--include-all`, ledger repair/stamping, live family deletion, money
movement, Storage privacy toggle, credential change, workflow apply dispatch,
automatic provider execution, merge or deployment. Source-zone/RRULE/exception
persistence and repair of existing lossy calendar data remain a separate feature
and data-reconciliation review; the feed claim contract alone does not solve them.

**Approval boundary:** preparation is complete for this evidence-based review
package. Production application remains blocked on reviewed dependency closure,
reserved-contract composition, representative rehearsal and separate apply approval.
