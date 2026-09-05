# Runtime privacy RLS proof plan

## Purpose and evidence status

This is a G0 documentation artifact for the held runtime-privacy remediation. It describes required behavior, source findings, proposed patch boundaries, and future proof cases. It does not implement SQL, application code, tests, or a requirements index. It does not retry or replace the stopped index operation.

No tests, database queries, Auth operations, production mutations, or deployments were executed to produce this document. No requirement is marked PASS here. Blueprint reading is collectively complete as reported by the parent; this document reuses the prior bounded source review.

- Parent-provided source baseline: `01881fb279589d7a90acb8302817bb385fbe036d`. The checkout was not reverified against this SHA for this document.
- Parent-provided blueprint SHA256: `9d279dd1d614ffd6376492b6f8d3b3d44fa4e5dfe6516ea51e2100c91e2441c3`.
- Source locations below refer to the captured readings. Owners must reconcile locations and behavior with their eventual changes.
- Code edits remain held pending the parent's matrix gate. Production apply remains held and requires separate parent authorization.

Evidence labels used here:

| Label | Meaning |
| --- | --- |
| Source finding | Behavior established by the reviewed source; not an executed test result. |
| Parent-reported result | A result supplied by the parent; logs and artifacts were not independently inspected here. |
| Planned proof | An acceptance case to implement and execute after authorization. |
| Pending coordination | Work or evidence owned by another contributor, or a decision still required. |

## Governing contracts

The relevant blueprint contracts are concrete acceptance requirements, not permission to perform production work:

- Sections 15, 47, 99, 102 and 113: household membership or adult/manager status does not automatically grant another adult's private finance, care, document, or runtime data. Identity is server-derived, and current authorization matters.
- Sections 36, 49, 50 and 69: deletion, archival, retention, and visibility changes must not leave unauthorized derived data in runtime traces, search, briefs, or context.
- Sections 41-44 and 66: typed capabilities, current authorization before mutations, exact approval binding, and permission-filtered run and approval reads are separate boundaries.
- Sections 63 and 67: shared activity contains safe summaries; raw audit and execution data is not made public to the household merely to populate a timeline.
- Sections 37, 39, 54, 56-59, 72-73 and 111: source inspection, passing compilation, and migration preflight are insufficient to claim runtime privacy or release readiness. Executed negative cases and attributable evidence are required.
- Sections 93, 107 and 110: preserve migration integrity and required history, prevent stale approvals from executing, and make deletion effects explicit.

The minimal privacy boundary is current active membership AND original-requester ownership. This boundary does not authorize the requester to obtain source objects they otherwise cannot access. Source/domain authorization at context assembly and execution remains required. No explicit sharing model was established by this review, so the planned raw-data policies must not infer sharing from a role.

## Existing findings that remain open

### Raw runtime data is overexposed

Migration `0250_ai_runtime_core.sql` makes requests, plans, steps and run events household-readable. Context and tool-call policies also admit every manager. These policies expose more than a shared activity summary.

Concrete persistence evidence:

- `lib/ai/runs/store.ts:285` stores the supplied step input in `input_json`.
- `lib/ai/tools/notifications.ts:35` accepts notification body and audience fields. A manager-addressed message can therefore be duplicated in a household-readable step.
- `lib/ai/runs/executor.ts:435` writes exception text into event payloads; `lib/ai/runs/executor.ts:761` also includes failure text in event messages.
- `lib/ai/tools/execute.ts:200` records tool inputs, and `lib/ai/tools/execute.ts:596` records returned outputs.
- `supabase/migrations/0250_ai_runtime_core.sql:410` allows a tool call's recorded caller to read it without independently requiring current membership. Removing membership alone does not invalidate that branch.

The intended remediation covers all six new raw runtime tables, not only `ai_plan_steps`.

### Approval visibility is a separate unresolved P1

`supabase/migrations/0251_ai_trust_hardening.sql:131` authorizes approval reads using household membership. `lib/trust/server.ts:109` stores the supplied action payload in that readable row.

The runtime requester-only rule must not be copied mechanically to canonical approvals. Approval reads and decisions must remain governed by requester, approver eligibility, object visibility, and the applicable policy. Legitimate approvers need an authorized exact preview; neither all managers nor only the requester is a sufficient general rule. Closing the runtime findings alone does not close this approval P1.

## Six-table ownership proof obligations

Every positive raw read must satisfy active membership in the row's household and unambiguous original ownership. Related rows must agree on household and canonical request. A NULL, deleted, or contradictory ownership link must not activate a broader fallback.

| Table | Sensitive surface and existing policy | Authoritative ownership proof | Required negative cases |
| --- | --- | --- | --- |
| `ai_requests` | Request text, interpreted intent, clarifications and diagnostics; membership-only SELECT at `supabase/migrations/0250_ai_runtime_core.sql:371`. | The authenticated user is the request's original `requested_by`, with a current active membership in the same household. Validate any supplied member reference against that identity and household. | Other adult/manager, child reading another person's request, outsider, anonymous caller, removed membership, absent owner. |
| `ai_request_context` | Raw assembled snapshot; requester-or-manager SELECT at `supabase/migrations/0250_ai_runtime_core.sql:381`. | Resolve the matching request and its original requester. The context and request household IDs must match. Remove the role-only manager alternative. | Another adult's private context, conflicting request/household link, missing request, revoked membership. |
| `ai_plans` | Objective and reasoning summary; membership-only SELECT at `supabase/migrations/0250_ai_runtime_core.sql:392`. | Resolve the plan's non-NULL request and original requester; match the household. Historical plan versions retain the same request ownership. | NULL or foreign request, another person's plan, manager override, removed member. |
| `ai_plan_steps` | Inputs, descriptions, conditions, results and errors; membership-only SELECT at `supabase/migrations/0250_ai_runtime_core.sql:397`. | Resolve step -> plan -> request. Match household IDs throughout and use the request owner. | Guessed step ID, conflicting plan/household link, another adult's notification input, child/manager/outsider access, orphaned ownership. |
| `ai_run_events` | Message and payload may contain private summaries or errors; membership-only SELECT at `supabase/migrations/0250_ai_runtime_core.sql:402`. | Resolve the canonical run -> request ownership. Optional event request/step links must agree with that request and household. Old events may reference an earlier plan version for the same request. | Another person's event, contradictory event/run/request links, missing canonical ownership, membership removal. |
| `ai_tool_calls` | Raw inputs, outputs and errors; caller-or-manager SELECT at `supabase/migrations/0250_ai_runtime_core.sql:410`. | Require current membership and original requester. When request/run/step links exist, they must identify consistent ownership. A genuinely standalone call may use its recorded original caller; a conflicting or ambiguous linked call must not fall back to a different actor. | Other manager, retained access after membership removal, conflicting linked ownership, ambiguous system/delegated ownership, NULL original caller. |

Additional invariants:

- Replace or restrict the existing broad SELECT policies. Adding a narrow permissive policy beside a broad one does not establish isolation.
- Inspect the effective combination of policies and grants, including any privileged views or RPCs used to return the rows. A policy name alone is not proof.
- Do not add manager exceptions, even for support or household administration, without an already-established explicit object authorization model.
- Requester privacy does not grant new INSERT, UPDATE, or DELETE authority. Preserve the existing narrow request INSERT and service-written ledger boundaries.
- Worker bookkeeping identity, approving identity, and original requester are distinct concepts. They must not silently replace one another as the owner of raw data.
- Preserve readable historical versions for the same authorized requester. Do not require every event's step to belong to the run's latest plan version.
- Prove both ownership and current membership on every externally reachable read. A still-valid Auth session must not defeat membership revocation.

## Runtime runs and orphan provenance

`family_automation_runs` contains legacy records and new runtime records, including potentially private metadata, summaries, results, and errors.

The compatibility requirement is to preserve genuine legacy read behavior while making request-backed runtime records private. However, `supabase/migrations/0250_ai_runtime_core.sql:189` declares the request link with `ON DELETE SET NULL`. A policy that treats every NULL `request_id` as legacy would reopen a formerly private runtime run after request deletion or unlinking.

Required design properties:

- Persist runtime provenance independently of the nullable request link. The proposed minimal approach is a durable runtime-origin marker initialized for existing linked rows and stamped when a run becomes request-backed.
- Ordinary clients must not be able to clear that marker, reclassify a runtime row as legacy, or change original ownership to gain access.
- A formerly runtime row does not regain household-wide visibility when its request disappears. Missing ownership fails closed unless an explicit retained-owner model has been approved.
- Genuine historical rows keep their existing same-household read behavior. Do not infer legacy status from a default run type or a newly NULL reference alone.
- Do not change FK deletion behavior to cascade-delete audit history merely to avoid this privacy issue. Retention and deletion policy require their own decision.
- If existing NULL-linked rows have ambiguous provenance, do not label them legacy without evidence. The parent reported the revised production release as unapplied; that report is not a substitute for the release owner's eventual baseline check.

Planned proofs: linked runtime privacy; genuine legacy compatibility; request deletion; direct unlink attempt; attempted marker clearing or owner reassignment; and the same checks under both ordinary-user and interactive service-role read paths. The request-deletion case must assert that the retained runtime row never becomes readable to another adult or child.

## Role and current-membership cases

Use separate sessions and identities; do not implement a role matrix by changing only a client-supplied role string.

| Actor state | Expected raw runtime result |
| --- | --- |
| Active original requester | Read their valid request and linked raw records. |
| Active requester with an eligible non-manager role | Ownership remains the read boundary; a role change must not grant access to other people's records. Underlying domain restrictions still apply. |
| Other adult or manager in the same household | Denied, including context and tool-call data. |
| Child in the same household | Denied for another person's records; an independently seeded child's own permitted request can provide a positive ownership control. |
| Outsider with an active membership in another household | Denied even with exact guessed IDs. |
| Authenticated user with no membership | Denied. |
| Original requester whose membership is inactive | Denied with the existing Auth session. |
| Original requester whose membership row was deleted | Denied while their Auth account still exists. |
| Anonymous caller | Denied. |
| Non-requester promoted to manager | Still denied; promotion is not object sharing. |
| Authorized service worker | Can perform necessary raw persistence under its internal worker boundary; cannot use that privilege to return raw data to an unauthorized user. |

Positive controls are mandatory: an implementation that denies everyone must not pass the negative cases. Do not require identical HTTP status codes from all layers; require absence of private rows, fields, and fixture sentinels, with correct authorized reads.

## Service-role read and control boundary

Database RLS does not constrain a service-role client. Every user-facing server reader must establish the real authenticated user, current membership, original request ownership, and consistent parent links before returning private fields.

Known reviewed surfaces:

- `lib/ai/runs/store.ts`: shared runtime persistence and read helpers. The proposed patch must separate trusted worker reads from user-facing reads so family ID alone cannot authorize raw data.
- `lib/ai/runs/controls.ts:36`: `openRun` uses service-backed access, then accepts blanket manager authority at line 48. Private runtime controls must additionally enforce the requester/object boundary. Keep existing operation-specific role requirements; do not make retry/edit available to every requester merely because they may read their run.
- `app/api/cron/ai-runs/route.ts:33`: the reviewed route checks cron authorization before creating a service client. Its response contains run IDs, status and counts rather than raw runtime payloads.
- The bounded search of `app`, `components`, and relevant runtime references found the cron route wired to these new runtime helpers. It did not establish a user-facing raw runtime API route, nor prove that every dynamic repository reader is safe.

Implementation and proof rules:

- Use one shared requester-access check for interactive readers and controls, with explicit trusted-worker entry points rather than a client-controllable bypass flag.
- Never trust client-supplied family, member, role, or original-requester fields as effective authorization.
- Check authorization before loading or serializing raw payloads through a service client. Filtered UI components do not repair an overbroad response.
- If a real user-facing service-role route is found or introduced, apply the same check there and exercise that route in the privacy proof. Do not create an administrative test-only route to make an E2E case pass.
- Keep legacy control/read compatibility distinct from private runtime handling.
- Review direct PostgREST reads and any enabled realtime subscriptions as well as server helpers. A safe HTTP response does not prove subscription privacy.
- Canonical approval UI remains separately policy-controlled. Authorized approvers do not thereby receive the requester's entire raw context, plans, or tool-call history.

## Worker bypass requirements and coordinated gaps

Service-role access is necessary for execution ledgers. It is not a substitute for represented-actor authorization. The privacy migration must preserve worker persistence while preventing ordinary clients from modifying executor ledgers or invoking the global claim RPC.

Required worker evidence:

- Anonymous and authenticated clients cannot execute `claim_ai_runs`; the service role retains execution rights.
- A local authorized worker can read its seeded runtime records and write lease, step, event and approval bookkeeping under the privacy policies.
- A removed or otherwise unauthorized represented actor is not replaced with an unrelated manager's authority or silently treated as an unrestricted system actor.
- Worker responses, logs exposed to users, and shared activity projections do not return raw private payloads merely because the worker could read them.
- An existing approval does not waive current actor/object authorization.

Related source gaps already reported and assigned to Pauli remain outside this privacy code ownership:

- Exact/fresh approval payload validation: `lib/ai/runs/executor.ts:1091` reads only approval ID, status and edited payload; the reviewed execution path can skip the trust gate at line 796.
- Verification failure handling: `lib/ai/runs/executor.ts:799` treats an OK tool outcome as a completed step even when its verification field is false.
- Cached requester scope: `lib/ai/runs/executor.ts:329` resolves scope once, and the production scope helper caches it at line 1027.
- Stale reservation compare-and-swap: parent-reported additional finding assigned to Pauli. The privacy plan does not claim independent reproduction or completion.

Pauli owns `lib/ai/tools/execute.ts`, `lib/ai/runs/executor.ts`, and their associated focused tests. Recommendations and interface coordination are appropriate; this privacy patch must not edit those files.

## Proposed isolated proof implementation

Proposed new files are `tests/ai-runtime-requester-privacy.test.ts` for focused database/service-boundary cases and `tests/e2e/runtime-requester-privacy.spec.ts` for the isolated E2E. Their implementation and execution remain pending authorization. Do not modify `tests/e2e/authenticated.spec.ts`.

### Mandatory guard before fixture mutations

1. Resolve the effective Playwright/application URL and the actual Supabase endpoint used by the admin Auth/data client. Validating only a local frontend is insufficient because it may point to a remote database.
2. Parse both URLs and allow only HTTP(S) with the exact hostnames `localhost`, `127.0.0.1`, or `[::1]`. Missing, malformed, or remote endpoints stop fixture setup before any mutation. Do not accept lookalike hosts, a remote override, or a production fallback.
3. Execute the guard before creating fixture users, signing up users, inserting rows, changing memberships, invoking a worker, or performing cleanup mutations. Construct the fixture admin client only after the endpoints pass.
4. Prevent admin requests or credentials from following redirects to an unapproved origin. Never log secret keys, passwords, session tokens, or Auth responses containing credentials.
5. Parent-owned Playwright configuration, dependencies, or global setup must not mutate a remote backend before this guard runs. If that ordering cannot be guaranteed, the isolated fixture suite must not run. Automatic test-file discovery is not proof of safe setup.
6. Add focused guard cases proving that a remote frontend, a local frontend with a remote backend, and missing backend configuration invoke no fixture mutation methods. There is no override case that permits remote mutation.

### Exact synthetic fixture lifecycle

1. Generate a unique run nonce. Create only synthetic Auth users and two new synthetic households: the requester, another adult/manager, and a child in household A; an outsider in household B. Record every created user, household and membership ID immediately. Use fresh users for additional removal cases if needed.
2. Sign in each actor separately. Keep all credentials and sessions in memory or the test runner's protected ephemeral state; reports must not include them.
3. Seed a request owned by the requester, its context, two plan versions, steps, a linked runtime run, run events, and tool calls. Use harmless unique text sentinels in raw fields so leakage can be asserted without real finance, care, document, or provider data.
4. Seed a genuinely legacy run with no request link, plus a genuinely standalone tool call with a recorded original caller. Record exact IDs. Include conflicting-parent fixtures only in this isolated database to test fail-closed reader behavior; do not weaken canonical production constraints to create them.
5. Exercise all six tables as the active requester first. Then read the same IDs as the other adult/manager, child, outsider and anonymous caller. Assert that private sentinels and raw rows are absent for unauthorized readers.
6. Exercise the shared interactive read/control boundary using a service client behind a real authenticated requester context. Repeat with the non-requester manager and outsider. If no user-facing route is wired, prove the helper boundary in the focused suite and leave API-route evidence explicitly pending rather than inventing a route success claim.
7. Where realtime is enabled, subscribe an unauthorized member before changing a seeded private step/event and verify that no private payload arrives. Verify the authorized requester's delivery. Missing realtime infrastructure is an unexecuted case, not a privacy PASS.
8. Prove worker persistence using a local seeded run with an approval-only step. The worker may create its synthetic pending approval and runtime bookkeeping, then stop awaiting approval. This exercises service-role reads/writes without sending messages, spending money, calling an AI/provider, or executing a financial action. Capture IDs created by the worker from the exact seeded run/step relationships.
9. Deactivate the requester's membership while retaining their Auth session and repeat reads across the six tables and private runtime run. Exercise membership-row deletion separately. For worker actor revocation, coordinate the expected fail-closed behavior with Pauli's fresh-actor changes.
10. Delete a seeded request and verify that retained runtime runs do not become shared legacy rows. Test attempted provenance clearing and inconsistent ownership. Confirm that the genuinely legacy fixture remains readable under the preserved legacy policy.
11. Run cleanup in a finally path using only the recorded IDs created by this fixture run. Capture worker-created child IDs through the exact generated run relationships and then delete explicit IDs in dependency order. Do not sweep memberships, households, users, emails, or all rows for an existing family. Never remove pre-existing data.
12. If a mutation outcome is uncertain and its created ID cannot be safely established, report incomplete fixture cleanup. Do not broaden cleanup to recover from uncertainty. Partial setup failures must still clean the exact IDs already known to have been created.

The requester's positive read cases, worker persistence case, and genuine legacy case are required alongside denial assertions. There must be no real financial/provider action and no production test data at any stage.

## Existing 0253/0254 evidence versus pending privacy proof

| Area | Available evidence | What remains unproven here |
| --- | --- | --- |
| Release baseline/preflight | Parent reports preflight run `33987762363` passed and 59 focused tests passed. | Logs and individual assertions were not examined for this document. Preflight does not establish that the revised SQL was applied in production. |
| 0253 worker EXECUTE lockdown | Reviewed explicit revocation from PUBLIC, anon and authenticated, followed by effective privilege checks in `supabase/migrations/0253_ai_worker_execute_lockdown.sql:4`. Release checks also inspect effective privileges. | No independent PostgreSQL execution proof is claimed here. This protects the claim RPC, not raw table SELECT policies or service-role API responses. |
| 0254 wallet write lockdown | Reviewed legacy policy removal and restrictive manager INSERT/UPDATE/DELETE guards in `supabase/migrations/0254_wallet_write_policy_drift.sql:17`. The release checks require those guards. | No proof of private adult runtime reads follows from wallet write guards. An effective role test must still be attributed to its actual artifact. |
| Atomic release and ledger | Source review found one transaction containing migrations and ledger inserts, with locked baseline/catalog guards in `scripts/apply-production-forward-release.mjs:104`. Parent reports the earlier P0001 attempt fully rolled back. | The revised release remains held; this document does not independently inspect production state, certify new migration inclusion, or establish production application. |
| 0255 runtime requester privacy | Findings and proposed acceptance cases in this document. | SQL, service-helper changes, tests, E2E, migration integration and all executed privacy results are pending. |
| Canonical approval visibility | Existing P1 source finding remains open. | Policy-controlled requester/approver visibility and negative cases need separate remediation and evidence. |
| Other actor/action requirements | Pauli owns the coordinated approval, verification, reservation and fresh-actor fixes. | Their implementation and focused proof must be provided by that owner; privacy test success cannot stand in for them. |

When future results are available, record the exact source SHA, migration set, command, isolated target classification, fixture case results, and sanitized artifact location. Distinguish a database role test, a service-helper test, a routed API test, and an E2E journey. Do not label a mock, source-pattern check, preflight, skipped case, or empty-denial-only test as executed RLS isolation proof.

## Patch ownership and handoff

Privacy code ownership, after the parent confirms the gate:

- New `supabase/migrations/0255_ai_runtime_requester_privacy.sql`.
- Proposed new `lib/ai/runs/access.ts` plus necessary requester authorization in `lib/ai/runs/store.ts` and `lib/ai/runs/controls.ts`.
- Only demonstrated user-facing service-role read/control bypasses, if additional routes are identified.
- New focused privacy tests and the new isolated E2E spec described above.

Halley owns forward-release integration, including the pinned release set, checksums and appropriate postconditions. The reviewed release script supports only 0240-0254, so adding a 0255 file alone does not make it part of the release. Parent owns CI/workflows, credentials, commits, pushes, deployment and production authorization. Shared sidebar/global navigation and the existing authenticated E2E are outside this scope.

Release readiness requires the privacy findings and separate approval P1 to be resolved with attributable evidence, coordinated actor/action fixes to be verified, and the release owner to include the exact approved migration set atomically. None of those completion claims is made by this documentation-only plan.
