# Execution safety contract

## Scope and evidence boundary

Blueprint source SHA-256:
`9d279dd1d614ffd6376492b6f8d3b3d44fa4e5dfe6516ea51e2100c91e2441c3`.
Collective blueprint reading is complete. Generation of the complete
traceability matrix did not complete, and the matrix gate remains unresolved.
This G0 document records four P1 findings from bounded, read-only source
inspection and the minimum contracts for a later patch. It does not establish
matrix completion, authorize core implementation, or mark any blueprint
requirement PASS.

The planned implementation boundary is `lib/ai/tools/execute.ts`,
`lib/ai/runs/executor.ts`, and directly related focused unit tests. Approval
decision routes are a separately owned integration dependency. No runtime
replanning, navigation, production workflow, or forward-release changes are
part of this patch contract.

The observations below describe repository code inspected during planning.
They are not executed test results or claims about current production behavior.
Production schema, policies, and application of these controls were not queried
in this review. Parent reports that Production credentials and connectivity
work and that the historical ledger records only `0001-0003` despite existing
schema. Preview run `33987762363` passed for `0240-0254`, but that bundle is
**HELD** for the new requester-privacy and core-execution findings and the
incomplete matrix. **Do not apply the previewed bundle.** `0255` is **PLANNED,
not written or applied**. Release requires a corrected reviewed bundle, a new
successful preview, completed matrix and review evidence, and explicit parent
authorization. Neither the previous preview nor repository schema proves these
execution controls are active in production.

Parent retains the implementation gate, commits, pushes, credentials, goal
controls, and production authority. The blocked requirements-index operation
must not be retried, reproduced, or worked around. This document is not a
replacement index or a full-source copy. The historical inventory in
`docs/PENDING_PROD_MIGRATIONS.md` was preserved while its release status and
procedure were hardened to reflect the release hold and unresolved gates.

## Canonical model and schema assumptions

Use existing family, member, approval, run, and tool-call records. Do not create
a parallel actor, approval, or execution ledger.

| Existing record or contract | Fields or behavior used | Safety purpose |
| --- | --- | --- |
| `ServiceScope` in `lib/services/types.ts` | `db`, `familyId`, `userId`, `memberId`, `role`, `actorKind`, `tz`, optional run/request/step identifiers | Carry the represented actor; incoming or cached role values are not fresh authorization. |
| `family_members` | `id`, `family_id`, `user_id`, `role`, `is_active` | Re-read identity, membership, and role. Missing or inactive members cannot become system actors. |
| `families` | `id`, `timezone` | Confirm the family still exists and use its current timezone. |
| `approval_requests` | `family_id`, `requested_by_member_id`, `domain`, `capability`, `policy_id`, `payload`, `edited_payload`, `payload_kind`, `evidence` | Bind a canonical action to its family, requester, scope, and material facts. |
| `approval_requests` | `run_id`, `request_id`, `plan_step_id`, `plan_step_ids` | Verify that an approval covers the exact run/step action being executed. |
| `approval_requests` | `status`, `approval_model`, `required_approvals`, `approvals`, `decided_by`, `decided_at`, `reviewed_by`, `expires_at` | Verify a fresh, sufficiently approved decision; status alone is insufficient. |
| `ai_tool_calls` | `id`, `family_id`, `idempotency_key`, `state`, `attempt`, `locked_at`, `inputs`, `outputs`, `finished_at` | Reserve an operation exclusively, fence finalization, and preserve its committed result and verification evidence. |
| `ai_plan_steps` | `input_json`, `approval_required`, `approval_id`, `status`, `result_json`, `error`, retry counters | Bind execution to the approved action and propagate verification or authorization failure honestly. |
| `family_automation_runs` | `requested_by_member_id`, `state`, `plan_id`, cancellation/pause fields, progress/result fields | Retain requester identity and completed work while stopping further unauthorized or unverified execution. |
| Existing trust tables | `trust_policies`, `permission_grants`, `trust_delegations`, `emergency_sessions` | Resolve current policy using canonical records; failed reads are not empty policy sets. |

Schema references are `supabase/migrations/0250_ai_runtime_core.sql` and
`supabase/migrations/0251_ai_trust_hardening.sql`; decision fields are also used
by `app/(app)/dashboard/trust/actions.ts`. The design assumes the existing
unique constraint on `ai_tool_calls(family_id, idempotency_key)` remains
enforced. These are repository assumptions, not a production schema attestation.

No new migration is anticipated for this bounded patch. Existing approval JSON
fields can carry versioned binding metadata and per-decision digests; existing
attempt and lock fields can identify a reservation generation. A dedicated
digest column or database-level immutability rule would require a separate
schema decision. Do not invent a migration number or silently expand scope.

## P1: Approval execution is not bound to an exact, fresh decision

**Observed evidence:** `lib/ai/runs/executor.ts` loads only approval identity,
status, and edited payload into its execution snapshot. It can then pass
`skipTrust` to `lib/ai/tools/execute.ts`, whose gate immediately allows that
flag. This boundary does not validate an approved action digest, expiry, or
current material assumptions. The inspected decision writer in
`app/(app)/dashboard/trust/actions.ts` records votes without an action digest.

**Applicable blueprint sections:** 77, 99, 100, 107, and 113.

Minimum patch contract:

- Replace authority derived from a boolean bypass with an approval identity
  that the server resolves and validates from canonical records. A caller's
  assertion that work was approved is not proof.
- Compute a deterministic, versioned digest over the canonical tool identity,
  schema-validated action arguments, family/requester, applicable run/step
  linkage, required material assumptions, and expiry. Reject malformed binding
  data rather than silently omitting material fields.
- Re-load the approval at execution. Match its action and linkage to the
  proposed side effect, require a valid unexpired decision, and preserve the
  existing approval model and quorum. All counted votes must approve the same
  binding version. A status such as `approved` or `modified` alone is not enough.
- Revalidate current actor and policy even when decision proof exists. A valid
  approval may satisfy an approval requirement; it must not override a current
  denial or manufacture access to a private domain.
- Required material facts must be current under the action's existing trusted
  contracts. If that freshness cannot be established, require fresh review;
  do not pretend an old price, recipient, source version, or date is current.
- Missing proof, expired proof, changed actions, mismatched scope, insufficient
  votes, or failed authorization reads stop execution before the side effect.

### Canonical approval decision dependency

The separately owned decision routes must persist the exact server-computed
digest that each authorized decision approves. Recording a vote or final
decision must use a conditional update against the proposal/version that was
reviewed, so concurrent edits cannot turn a stale vote into approval of a new
payload. Material edits must invalidate prior votes and bind new decisions to
the edited action; an edit is not itself permission to execute.

Use the existing `evidence` and `approvals` JSON fields for versioned binding
metadata and decision digests, preserving existing evidence and decision
history. Keep `payload`/`edited_payload`, expiry, requester, and run/step fields
consistent with that proof. Batch decisions must identify the exact covered
actions; a batch ID alone cannot authorize arbitrary steps.

Routes must pass approval identity and preserve the represented requester,
rather than replacing the requester with the reviewing parent's authority.
Route owners must not edit the two core execution files. The core owner must
not edit those routes under this bounded assignment.

Do not silently grandfather old approvals or add proof to an already-approved
row as though the user had reviewed the new contract. Legacy decisions lacking
required proof need fresh approval. Until the route producer and core consumer
agree on the contract, affected execution remains closed. Database or RLS
protection of decision metadata must be established by the route/schema owner;
a digest stored in caller-controlled JSON is not sufficient authority.

## P1: Failed verification can still become completed work

**Observed evidence:** `executeTool` in `lib/ai/tools/execute.ts` can return
`status: 'ok'` together with `verified: false`. Its duplicate replay can return
the same combination. `runToolStep` in `lib/ai/runs/executor.ts` marks an `ok`
outcome completed without rejecting that false verification result. A plan
without a separate verify step can therefore report completion despite failed
verification.

**Applicable blueprint sections:** 97, 104, 107, and 113.

Minimum patch contract:

- Distinguish an already-committed mutation from a verified customer outcome.
  Preserve the original ledger identity, committed result, and failed
  verification evidence.
- Do not mark an already-committed call retryable merely because verification
  failed; doing so can repeat the mutation. Retain the committed ledger result
  while returning a non-retryable verification failure to the caller.
- Apply that rule to both initial execution and duplicate replay. Replaying
  the same operation must neither mutate again nor turn failed verification
  into success.
- Independently guard the graph boundary against `ok` plus `verified: false`.
  Persist an honest failure/result, block dependent work as appropriate, and
  preserve unrelated work that completed successfully. The step and run must
  not report full completion on the strength of the failed verification.
- Where verification is required but its evidence is missing or unreadable,
  do not infer success from a ledger row or a successful write alone.

## P1: Stale reservation takeover is not exclusive

**Observed evidence:** `reserveCall` in `lib/ai/tools/execute.ts` compares only
the previous state when reclaiming a failed or stale reservation, then writes
`state: 'reserved'`. For an already-reserved stale row, two contenders can both
match that unchanged state. `finalizeCall` updates by ID without checking which
reservation generation it owns.

**Applicable blueprint sections:** 92, 103, and 107.

Minimum patch contract:

- Preserve the existing family/idempotency uniqueness constraint and operation
  key. Recovery is a new reservation generation for the same logical action,
  not a new action key.
- Use a compare-and-swap update matching the family, row ID, observed state,
  observed attempt, and observed lock timestamp, with explicit null handling.
  Increment the attempt atomically and assign the new lock timestamp.
- Exactly one contender receives the acquired generation. A zero-row result
  means ownership was lost; that caller must not execute the action.
- Carry the acquired generation through execution and finalization. Finalize
  only if family, row identity, reservation state, attempt, and lock ownership
  still match. An older worker cannot overwrite a newer worker's outcome.
- A stale reservation is not proof that an external side effect failed.
  Preserve reconciliation requirements for uncertain outcomes; exclusive
  takeover alone must not authorize blind provider retries.

## P1: Requester authorization is cached across side effects

**Observed evidence:** `runGraphWith` obtains requester scope once per slice,
and `createExecutorPort` caches it. Later steps reuse that scope. The tool gate
can also skip authorization for an asserted prior approval. In addition,
`loadTrustInputs` in `lib/trust/server.ts` reads query data without propagating
the query errors, so unavailable authorization inputs can resemble empty sets.

**Applicable blueprint sections:** 77, 83, 85, 99, 102, and 113.

Minimum patch contract:

- Remove per-slice requester authorization caching. Use canonical actor
  resolution, including the existing `loadRunActor` behavior, and verify
  identity, family linkage, current membership, and current role.
- Revalidate at each side-effect boundary, including each tool action,
  notification, approval creation, resumed action, and retry. Checking only
  when the worker claims a run is insufficient.
- Evaluate current applicable authorization with checked read results. An
  authorization lookup failure must deny execution, not fall through to role
  defaults. Keep the fix within the owned core files while reusing canonical
  tables and policy semantics.
- Do not turn a removed, inactive, missing, or mismatched requester into a
  system actor or the approving manager. Deliberate system work must retain
  its separate, explicitly authorized system policy.
- Respect current cancellation and pause state before starting subsequent
  actions. Preserve completed effects and the audit needed to explain why
  further work stopped.
- A valid historical approval cannot override current access revocation.
  Refreshing identity also does not substitute for object/domain authorization
  in the canonical service and privacy boundaries.

## Focused acceptance evidence required after the implementation gate

No tests were added or executed for this document. A later authorized patch
should add focused tests, with minimal changes to existing fixtures where
their old bypass assumptions conflict with the new contract.

| Proposed evidence | Required assertions |
| --- | --- |
| `tests/tool-execute-security.test.ts` | A forged bypass cannot execute; approval identity and digest must match; expiry, material edits, invalidated votes, missing proof, and authorization-read failures prevent action. |
| `tests/tool-execute-security.test.ts` | Concurrent stale recovery has one winner; a loser never executes; an older generation cannot finalize the new owner's row. |
| `tests/tool-execute-security.test.ts` | Failed verification cannot return success on execution or replay; replay does not repeat the committed mutation. |
| `tests/run-executor-security.test.ts` | An injected `ok`/`verified: false` outcome cannot complete the step or whole run; committed results and valid independent work remain visible. |
| `tests/run-executor-security.test.ts` | Removal, demotion, policy revocation, or authorization-read failure between actions stops subsequent action/notification/retry; requester identity never changes into manager/system authority. |
| Separately owned decision-route tests | The reviewed digest is recorded conditionally, concurrent edits invalidate stale votes, quorum applies to one binding, legacy approvals require fresh review, and requester identity is preserved. |

Existing focused suites are `tests/tool-execute.test.ts` and
`tests/run-executor.test.ts`. Test existence, source review, compilation, and
preview status are not execution evidence. Record actual focused test outcomes
and the applicable staging/customer journey before claiming these requirements
PASS. Production readiness and application remain separately evidenced,
parent-owned decisions.
