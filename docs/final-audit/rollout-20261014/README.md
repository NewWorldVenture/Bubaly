# Production rollout review — refreshed October 14, 2026 UTC

Prepared for review under the owner's existing request. **Not approved for application.**
This update reconciles current source and a fresh catalog observation with the
[retained rollout package](../rollout-20261008/README.md). It changes no migration,
allocation, application configuration, production record or deployment.

The [review receipt](review.json) contains the exact catalog SELECT and response,
SHA-256 hashes for all 461 runnable and 27 held migration files, current CI
references, and a regenerated offline review. The older package's observations
remain dated evidence; they are not silently presented as current measurements.

## Current release boundaries

| Boundary | Evidence | Required before release |
| --- | --- | --- |
| Application base | Main `06ac6e3b54cbd8da33bfa7ab10f0a860078cc5c9`; all 13 jobs in [CI 38471227255](https://github.com/NewWorldVenture/Bubaly/actions/runs/38471227255) passed. | Fresh checks on the final composed release commit; source fixes in this audit do not need new DDL. |
| Production history | Catalog SELECT at `2026-10-14T01:22:25.235551Z`: PostgreSQL 17.6, 192 ledger entries, lexical maximum `0176`. | Reconcile exact history and actual schema effects. Never infer all later effects are absent, stamp history, or replay the backlog from this count. |
| Legacy forward release | Both unchanged gates refuse: source is outside the pinned release; retained live baseline differs. | Construct a separately reviewed manifest from a fresh complete baseline and dependency closure. Do not weaken either gate. |
| Bill anchors | `bills.due_day` is absent in the fresh observation; 0488 remains held. | Review dependencies and existing-row behavior, rehearse the exact schema and app combination, then authorize an explicit release. |
| Copied reminders | Fresh catalog shows only the original permissive card policy; selected origin columns and the 0486 audience-pinning function are absent. | Reconcile live policies, approve a coordinated schema/application cutover, and qualify PR1046's atomic origin writers and readers. App checks alone do not close database privacy. |
| PR1046 | Head `420958ea0028b8e0981fe3d09a5846b1806e3c92`: dedicated privacy/E2E pass; 96 unit failures in 17 files in each zone. | Update obsolete fixture contracts without weakening privacy assertions; investigate remaining differences; require all normal checks on the corrected head. |
| PR1047 | Head `fecd36a73c216df1952fa1ac97014c02a22b3e80`: unit/E2E pending at capture. | Require completed exact-head gates; preserve held 0512 and review its database dependency separately. |
| Cron | [Run 38490140416](https://github.com/NewWorldVenture/Bubaly/actions/runs/38490140416/job/115613132673) failed because Actions `CRON_SECRET` was unavailable, before calling any route. | Separately authorized matching application/Actions configuration and a controlled delivery check. This does not establish the current application's secret value or authorize dispatch. |

The selected held worker/feed/quota/sync RPCs are also absent in the fresh
catalog result. A supplemental SELECT at `2026-10-14T01:28:36.402929Z`, using
PR1046's exact names, confirms both origin columns and the three selected atomic
writer functions are absent. It corrects the initial query's unused
`autopilot_source_card_id` spelling to the actual `autopilot_card_id`; both
receipts remain in the review. The SQL captures no family records, credentials,
financial values or function bodies. Absence is qualified by the exact names and
columns queried, not a claim of full catalog coverage.

## Proposed operator sequence for review

1. Freeze the final application and schema candidate hashes. Preserve all held
   versions; 0487 is next available on this main snapshot and is proposed by
   [PR1046 at the captured head](https://github.com/NewWorldVenture/Bubaly/pull/1046).
   Recheck ownership before any future allocation.
2. Capture a fresh complete release-boundary catalog and exact migration ledger.
   Reconcile helpers, grants, RLS, triggers and existing columns against the
   pinned candidate. Retain both current forward-release refusals until an
   independently reviewed successor manifest passes its own preflight.
3. Resolve existing-data prerequisites using aggregate-only diagnostics. The
   October 8 wallet-family/economics discrepancies remain historical evidence,
   not permission to delete, reassign, reprice or approve records. Record an
   explicit disposition and full-schema rehearsal before any integrity rollout.
4. Rehearse the exact ordered candidate on an isolated representative schema,
   including existing rows, all triggers/RLS, authenticated roles, revocation
   races, late transactional failures and rollback. Minimal structural fixtures
   from the older package do not substitute for this composition.
5. Review copied-reminder cutover with its owner: hold generated writes before
   schema installation, verify immutable origin and atomic writer ACLs, release
   the matching application, reload stale clients, and only then resume writes.
   Use that candidate's final reviewed runbook; this document does not install it.
6. Obtain the final production-operation authorization for the pinned bundle and
   any matching cron configuration. Run bounded preflight immediately before
   application, retaining timeouts, refusal behavior and an operator stop point.
7. Verify post-release schema/ACL identities and the served commit, then use
   owned synthetic accounts to check complete authorized/denied workflows.
   If any check fails, keep generated writes held and revert to a compatible
   application where possible. Do not drop protective database rules or rewrite
   historical financial data as an automatic rollback.

## Review disposition

**REVIEW_REQUIRED_NOT_APPLY_READY.** No runnable release manifest is generated
because the current baseline and candidate dependencies still refuse release.
The old future-wallet-reference SQL stays unallocated and outside apply flows;
its NOT VALID constraints preserve historical mismatches and do not resolve them.
The source fixes in this parallel audit may be reviewed independently, with
fresh CI, while production schema and delivery holds remain explicit.
