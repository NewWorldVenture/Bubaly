# Bubaly target architecture and phase gates

## Governing source and reuse decisions

The revised production blueprint has SHA-256 `9d279dd1d614ffd6376492b6f8d3b3d44fa4e5dfe6516ea51e2100c91e2441c3`. This target evolves the existing Bubaly product; it is not a replacement architecture or a completion report.

- Keep the existing Next.js/Expo experiences, authentication, household identity, domain records, design system, and deployment providers.
- Extend `lib/ai/tools/registry.ts`, the shared tool executor, and `lib/ai/runs/` instead of building a second agent framework.
- Retain the existing central approvals and `family_automation_runs` concepts. Document schema-equivalent implementations rather than creating duplicate tables to match example names in the blueprint.
- Use `docs/traceability/blueprint-requirements.json` as the machine-readable requirement artifact described conceptually in blueprint sections 30 and 40. Its validator distinguishes honest unfinished work from unsupported completion claims.
- Keep shared navigation intact. Capabilities belong in existing contextual surfaces and the Chief of Staff experience, not 29 new top-level navigation entries.

## Shared execution boundary

Every execution begins with server-created, current actor and household context. Retrieval applies tenant, member, object, domain, and lifecycle visibility before ranking or model input. Another adult's private data is not shared merely because both belong to the same household.

Registered capabilities separate reads, proposals, internal writes, external writes, spending, and sensitive operations. Runtime-validated input and output schemas, deterministic material calculations, provenance, confidence, and source references are required. Retrieved text cannot grant authority or introduce new tools, endpoints, or instructions.

A durable plan records dependencies and success criteria before side effects. Independent authorized reads may run concurrently; conflicting writes are serialized. Immediately before each mutation, the executor refreshes authority, evaluates policy, validates the exact approval and its material assumptions, and reserves an idempotency key exclusively. Uncertain external results are reconciled rather than blindly retried.

Persisted/provider verification determines completion. Failed or missing verification cannot become a success message. Partial success remains intact, with remaining work recoverable and dependency-aware. Cancellation stops future actions without pretending completed external actions were reversed.

Runtime and support views expose only authorized, minimized summaries. Raw inputs, outputs, source text, errors, and private context require equivalent authorization at both RLS and service-role API boundaries.

## Canonical cross-domain data

Identity owns household members; Calendar owns events; Tasks owns work items; Documents owns sources and versions; Finance owns authoritative transactions. Other modules link to these records and preserve source provenance. Domain-specific metadata must not become a second authoritative copy.

Cross-domain changes use durable event/outbox behavior where delivery must survive a process failure. Corrections and permission changes invalidate affected retrieval, briefs, pending proposals, and caches. Archive, deletion, export, provider disconnect, and retention cover derived indexes and memory as well as primary rows.

## Delivery sequence

| Gate | Work | Required exit evidence |
| --- | --- | --- |
| G0 | Existing architecture, source requirements, capability mapping, baseline failures | Complete source coverage and honest machine-readable traceability; no completion inferred from existing files. |
| G1 | Tenant/object authorization and runtime requester privacy | Isolated cross-household, cross-member, role, and revocation tests; safe migration and route evidence. |
| G2 | Registry, durable plans, approvals, idempotency, verification, jobs/events | Exact-payload, expiry, denial, replay, concurrent recovery, partial failure, and permission-change scenarios. |
| G3 | Existing inbox/document capture to linked domain records | A real staged source produces reviewed, source-linked records in at least two domains, with deduplication and safe undo. |
| G4 | Chief of Staff, schedule, tasks, and brief | Busy-week and Golden Household journeys across at least four domains, including an approval and a recoverable failure. |
| G5 | Food and private financial intelligence | Deterministic constraints/calculations, sourced facts, domain permissions, and persisted customer outcomes. |
| G6 | Home and family lifecycle capabilities | Linked assets/projects/inventory and privacy-sensitive family journeys, including lifecycle changes. |
| G7 | Travel and commerce | Current timestamped provider facts, truthful unavailable states, and approval-safe handoffs; no fabricated bookings or purchases. |
| G8 | Autopilot | Narrow policy scope, pause/revocation, threshold drift, replay protection, and recoverable scheduled/event work. |
| G9 | Operations, privacy, billing, and diagnostics | Least-privilege support, export/deletion, durable quotas, provider health, cost controls, and runbooks. |
| G10 | Release hardening | Required security/eval/E2E/accessibility/performance evidence, production rollout controls, final artifacts, and complete applicable acceptance. |

## Evidence and safety rules

Every requirement retains source identity, implementation references, applicable migrations/RLS proof, automated evidence, and an executed staging/customer journey before PASS. A green build is a baseline, not the final release gate. Final artifacts must include the blueprint's section 96 evidence and section 95 Golden Household journey.

Code gaps, failing tests, migration work, missing UI, and internal design decisions remain unfinished work. Only a documented unavailable external dependency can qualify as BLOCKED, and the adapter, safe disabled/reconnect state, contract tests, and precise unblocking condition must still be implemented.

Do not use production household data as synthetic test fixtures. Identity/role/write probes run only in isolated local or staging environments with purpose-created records and scoped cleanup. Production verification is metadata-only or otherwise non-destructive unless a specific reviewed release operation requires a change. Development authorization is not permission to make real payments, contact household members, book travel, or perform unrelated account actions.
