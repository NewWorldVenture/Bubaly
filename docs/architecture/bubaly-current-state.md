# Bubaly current-state architecture

## Audit scope and evidence

This is the foundation audit for the revised production blueprint, not a declaration that Bubaly is complete. The source document SHA-256 is `9d279dd1d614ffd6376492b6f8d3b3d44fa4e5dfe6516ea51e2100c91e2441c3`. The planned `docs/traceability/blueprint-requirements.json` artifact is not yet available. The three `capability-audit-*.json` files record capability-specific implementation candidates and gaps; they are not a substitute for the complete requirement matrix.

The code baseline for this audit is commit `01881fb279589d7a90acb8302817bb385fbe036d`. Paths identify existing implementations, not proof that every requirement associated with those implementations passes.

## Existing layers to preserve

| Layer | Existing implementation | Boundary or limitation |
| --- | --- | --- |
| Web experience | Next.js App Router under `app/`, with existing module components under `components/modules/` | Preserve the existing design system, shared sidebar, and global navigation. An existing route is not an executed customer journey. |
| Mobile | Separate Expo project under `mobile/` | Mobile typechecking and Expo config checks exist. These do not prove every native customer journey. |
| Identity and tenancy | Supabase Auth, `families`, `family_members`, and existing membership/management helpers | Reuse existing identities. Household membership alone is insufficient for private finance, care, documents, and runtime payloads. |
| Domain services | Existing server-side services, including `lib/services/calendar/` | Reuse canonical domain records and services rather than creating new copies for each specialist agent. |
| AI tool registry | `lib/ai/tools/registry.ts` | The reviewed registry registers calendar, tasks, groceries, reminders, family, and notifications. The expanded blueprint's other specialist tool sets remain incomplete. |
| Tool execution | `lib/ai/tools/execute.ts` | Validation, authorization, policy, audit, and idempotency belong at this shared boundary. The audit found approval, verification, and reservation-recovery defects requiring correction. |
| Durable AI runs | `lib/ai/runs/store.ts`, `lib/ai/runs/executor.ts`, and migration `0250_ai_runtime_core.sql` | Reuse `family_automation_runs` with requests, plans, steps, events, context, and tool-call records. Do not introduce a parallel execution database. |
| Approvals | Existing `approval_requests` and related approval flows | Reuse the central approval model. Exact approved payload, material assumptions, expiry, current authority, and replay safety must be proven at execution. |
| Background execution | Existing run scheduling and `claim_ai_runs(integer,integer)` | Worker-only database execution is locked down by `0253`; completed work must be verified, and recovery must not duplicate side effects. |
| Delivery | GitHub Actions, Vercel, and Supabase | Frontend deployment, build success, migration application, and customer readiness are separate evidence categories. |

## Capability coverage

The revised blueprint specifies 29 capabilities, each with a detailed section and an additional implementation packet. The team completed reading all 113 primary sections, detailed sections 3.1 through 3.29, and their 29 implementation packets. Reading coverage is not implementation or acceptance evidence. Existing domain screens and persisted records provide reusable building blocks. The capability audit files map these to the revised requirements without marking functionality complete from file existence.

The first cross-domain dependency is the existing typed execution path: server-created actor context, object permissions, validated proposals, source provenance, run linkage, and idempotent events. Adding disconnected specialist pages would not satisfy this dependency.

## Production database baseline

The metadata-only production audit found 441 public tables, all with RLS enabled, but an incomplete migration ledger. Historical migrations `0001`, `0002`, and `0003` were applied before the old replay attempt stopped at an existing policy in `0004`. Those three applications are real production changes; the remaining historical migrations must not be represented as executed.

The first reviewed forward apply rolled back atomically. A subsequent metadata audit confirmed the ledger remained `0001` through `0003` and the 33 proposed new tables were absent. Preview run `33987762363` passed for the hash-pinned `0240` through `0254` release, but did not apply it. A privacy correction and a new pinned preview are required before the expanded release can proceed.

Do not reset production, blanket-stamp historical migration versions, use `--include-all`, or blindly replay migrations. Preserve household records and verify the exact reviewed catalog/ledger boundary. See `docs/PRODUCTION_FORWARD_RELEASE.md` for the release procedure.

## Open foundation defects from the audit

- Raw AI request, plan, step, context, event, and tool-call payload access needs requester-level authorization, including the service-role API paths. This finding concerns the reviewed code and pending schema; it is not a claim that the pending tables already exist in production.
- Approval execution needs exact-payload and freshness validation, not merely an approved status or a trust-gate bypass.
- A failed verification must not be recorded or presented as completed work.
- Stale idempotency reservations need exclusive recovery, including concurrent reclaimers.
- Current requester authority must be refreshed before each side effect, including changes during a run slice.
- Production replanning is not wired into the inspected executor. This is unfinished implementation, not an external dependency blocker.

These findings keep the security/execution release gates open until corrected and supported by executed tests and journeys. The audit is not an exhaustive security certification of every existing domain.

## Executed baseline evidence and limits

- CI run `33987747932` completed successfully: the web quality/build job, mobile typecheck/config job, and isolated authenticated/public/accessibility/mobile end-to-end job all passed.
- The latest Vercel deployment for baseline commit `01881fb279589d7a90acb8302817bb385fbe036d`, GitHub deployment `6285016189`, reported success in the production environment. This is separate from production database application.
- A read-only public browser suite passed 148 checks across the selected desktop/mobile projects. This does not demonstrate authenticated household workflows or the expanded blueprint.
- The standard production migration workflow failed at the protective history guard. That is an intentional refusal to replay an unverified historical schema, not proof of missing credentials.
- No Golden Household scenario, complete provider-failure corpus, full object-permission proof pack, or all-capability staging acceptance is established by this baseline.

Update requirement evidence as each verified slice lands. Do not derive a completion percentage from routes, tables, test counts, or this document alone.
