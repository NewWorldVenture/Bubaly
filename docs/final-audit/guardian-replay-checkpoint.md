# Guardian decision authorship and incoming callback checkpoint

Frozen source: 1aa4d6fb4b8c3b59e69a8da291fa136d4922a72f. Guardian repair90e59c7d is followed by incoming main217c7be4 and the callback/E2E integration1aa4d6fb. Incoming migrations0283 and0284 match main unchanged. No new SQL was authored or applied locally; no dependency or shared-navigation changes were made.

## Repair and verification

Two signed-route failures reproduced member-inserted blocked/permitted decisions skipping screening. A service-owned ai_tool_calls receipt now binds exact signed input, family/member, communication ID and complete decision. Capturing input confers no decision authority. Missing proof causes fresh screening, followed by an immutable trusted decision and a conditional observed-state communication update. Exact readback precedes notification. Trusted retries reuse that decision after lost responses. Ledger-read outages still retain neutral input when communication storage is available.

The helper passes79 actual-SDK cases; signed SMS, callback lease and callback security pass209. Independent reviews found no additional blocker. Lost writes, conflicting revisions, mismatched payload/metadata, ignored cancellation, changed leases and legacy-row conflicts are covered. A new three-case hosted suite exercises real PostgreSQL write authority and signed HTTP ingress through Next, including both forged decisions, invalid signatures and claimable retry after a policy change. Its lint, discovery and strict types pass; runtime is pending publication.

Incoming middleware compatibility reproduced two assistant redirects and five inadvertently public Contact Center neighbors. The fix exposes only the two assistant POST paths and retains the exact four Contact Center callbacks. Actual middleware, both assistant handlers, installed token-link queries and related session boundaries pass89 cases.

Full source gates at1aa4d6fb pass: 1,188 files /14,442 units in43.66seconds; production build generates251 static pages with47-second compilation,103kB shared first-load JavaScript and92.1kB middleware. Strict post-build types, lint, locale and query audits pass. Four baseline lint warnings remain. Query discovery resolves491 tables,77 functions and142 API routes. Logs: `Temp/bubaly-guardian-replay-final-private-<gate>-20260912.log`.

## Limits and next work

The new receipt suite still needs hosted execution. Operations across ledger, communication and callback lease are not a database transaction. A legacy receipt whose communication was externally deleted can conflict with a new neutral row retained during a ledger outage; the mismatch fails closed and needs repair. Oversized legacy decision predicates remain unavailable rather than dropping concurrency guards. Autonomous recovery and actual provider/handset delivery remain open.

AUTHZ-005 separately records manager-only action checks that the existing contact/profile database write policies do not enforce. This requires database policy work under the standing no-new-SQL constraint. Public family-media and social-role DELETE issues also remain release failures.

Prior hosted results are qualified by their actual generated merge revisions in hosted-merge-evidence.md. The latest prior run passed with one child PIN readiness flake, now under a separate controlled investigation. Production session configuration, physical devices, incoming assistant/library workflows and the broader audit remain unfinished. Production readiness is NO.
