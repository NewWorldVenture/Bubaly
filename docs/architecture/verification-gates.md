# Verification gates

## Scope and evidence provenance

This is a bounded G0 documentation audit against blueprint sections 56 and 111. It is not a requirements index, a release authorization, or a statement of full blueprint completion.

- Blueprint source SHA256: `9d279dd1d614ffd6376492b6f8d3b3d44fa4e5dfe6516ea51e2100c91e2441c3`.
- Supplied CI evidence: run `33987747932`, commit `01881fb279589d7a90acb8302817bb385fbe036d`, all jobs successful, including isolated authenticated E2E. This result was reported by the parent/user; logs and individual test results were not fetched or independently checked for this document.
- Source evidence: the local workflow, package scripts, runner/configuration files, and selected tests listed below. The working tree was not compared with the supplied commit. New or concurrent changes are not covered by the historical run merely because that run succeeded.
- Blueprint sections 56 and 111 were read completely, with previously read section 111 reused from retained content. Collective full-blueprint reading is reported complete by the parent. Reading completion is not implementation completion or permission to apply a release.
- No tests, evaluations, type generation, SQL probes, backfills, provider calls, network checks, or production actions were executed for this document.
- All references here are repository-relative. The existing `docs/traceability/capability-audit-11-20.json` was not edited under the instruction to write only this new file; machine-specific metadata from it is not reproduced here.
- The stopped requirements-index operation must not be retried, replicated, or worked around. This document neither builds an index nor implements a traceability validator.

Evidence terms: **wired** means an inspected workflow invokes a command; **reported success** means the supplied run result; **unproven** means the required outcome lacks sufficient inspected execution evidence. None is interchangeable with requirement-level PASS.

## Actual CI execution path

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`, with superseded runs cancelled per ref. It defines three jobs. Repository branch-protection requirements and external security settings were not inspected.

| Job | Inspected wiring | What the supplied success establishes, and its limits |
| --- | --- | --- |
| `quality` | Node 22; `npm ci`; `npm audit --omit=dev --audit-level=moderate`; `npm run db:audit:migrations`; `npm run marketing:audit:assets`; `npm run typecheck`; `npm run lint`; `npm test`; `npm run build`. | Reported job success for the supplied commit. Build uses dummy backend configuration, not proof of deployed credentials, runtime integrations, or production schema readiness. Dependency audit excludes development dependencies. |
| `mobile` | Separate `mobile` dependency installation; `npm run typecheck`; `npx expo config --type public`. | Reported type/configuration success, not a native build, physical-device journey, or native permission/integration result. |
| `e2e` | Supabase CLI `2.109.1`; isolated-only migration de-duplication; `supabase start`; local credential export; Chromium install; diagnostic REST probe; Auth/schema audits; isolated canonical marketing-page backfill; marketing schema/provenance verification; `npm run test:e2e` with `E2E_AUTHENTICATED=1`; always-stop cleanup. | Reported success includes authenticated E2E against disposable Supabase. The backfill and fixtures write to that isolated database: they must not be reused as production verification commands. Clean local migration application is not proof of the held production forward release. |

`scripts/run-e2e.mjs` builds the application unless explicitly skipped, starts a local production server, waits for readiness, invokes Playwright, and shuts the server down. `playwright.config.ts` uses two workers, forbids focused tests in CI, allows one retry, reports to GitHub, and captures traces on first retry. The workflow does not upload those traces or a machine-readable test report as artifacts.

The browser matrix includes desktop Chromium and emulated phone/tablet, landscape, and dark-mode profiles. CI installs Chromium and does not enable the opt-in WebKit branch. Authenticated tests run in the unrestricted desktop project; the mobile projects select mobile/overflow/public specs, not the authenticated journey.

## Blueprint 56 / 111 gate map

| Required control | Actual existing gate/evidence | Gap and required CI integration |
| --- | --- | --- |
| Lockfile-integrity install (56) | `npm ci` in all three jobs, with a separate mobile lockfile. | Wired and covered by the reported job result. Preserve frozen installs; do not infer dependency safety from installation success. |
| Generate/check database types (56, 111) | `package.json` defines `db:types` as local Supabase generation redirected into `lib/database.types.ts`. | **Not wired.** Typecheck consumes checked-in types; it does not compare them with the migrated database. Add a fail-on-drift generation comparison after isolated Supabase startup. |
| Typecheck (56, 111) | `npm run typecheck` in quality and mobile; production build also checks application types. | Wired, reported successful. Does not prove database/type parity or authorization behavior. |
| Lint/format policy (56); lint (111) | `npm run lint` maps to `next lint`. | Lint is wired. No separate formatting-policy gate is invoked in this workflow. Parent must explicitly document the accepted policy or add the chosen check rather than treating lint as a formatter. |
| Unit tests (56, 111) | `npm test` maps to `vitest run`; `vitest.config.ts` includes `tests/**/*.test.ts` in a Node environment. | Wired, reported successful. Add retained case-level results and required-case accounting; inclusion patterns or filenames alone do not demonstrate executed behavior or coverage. |
| RLS/authorization integration (56, 111) | Authenticated E2E performs real local database role probes described below. Several additional RLS tests inspect source/SQL strings only. | **Partial coverage, not absent.** Add real cross-family, same-family requester privacy, delegated/revoked actor, sensitive-read, and storage checks with positive controls in the isolated database. |
| Domain/provider integration (56, 111) | First-task persistence is a real local domain journey. `tests/assistant-tool-loop.test.ts` stubs `fetch`; executor tests use database fakes. | No dedicated domain/provider contract suite is invoked. Add offline adapter contracts for payloads, malformed responses, timeout/rate limits, duplicate delivery, revoked consent and truthful failure. Live provider readiness remains separately unproven, not implied by mocks. |
| Production application build (56, 111) | Quality build and E2E runner build. | Wired, reported successful. Distinguish build configuration from deployed configuration and production data/schema. |
| Critical E2E journeys (56, 111) | Existing authenticated first-value journey plus public, accessibility, CSP, marketing, mobile and overflow specs selected by Playwright. | Preserve the existing journey and require it not to skip. Add capability-specific approval, denial, retry/recovery and persisted-result journeys as slices are implemented; current success does not cover all capabilities. |
| AI golden/adversarial thresholds (56, 111) | Tool registry, executor and provider-loop unit contracts exist. Neither the inspected package scripts nor this workflow declares a dedicated scored golden/adversarial gate. | **Not wired.** Add a versioned offline evaluation runner, explicit thresholds and machine-readable case results. Fail on missing corpus, missing thresholds, skipped mandatory cases or critical safety violations. Unit test success is not a model-quality evaluation. |
| Dependency/security scan (56, 111) | Production dependency audit at moderate severity; security-related unit and E2E tests. | No separate application security-analysis job is invoked. Development dependencies are excluded from the audit. Add the parent-approved scan scope, pinned tooling and expiring reviewed exceptions; external scans may exist but were not inspected. |
| Secrets scan (56, 111) | No explicit secrets-scanner step in this workflow. | **Not wired here.** Add a pinned, fail-closed scanner with redacted diagnostics and a narrowly reviewed allowlist. Do not fetch Production secrets to perform a scan. External secret-scanning settings are unknown. |
| Migration validation (56, 111) | Filename audit in quality; disposable de-duplication and actual isolated migration application in E2E; forward-release unit tests are selected by Vitest. | Clean-install coverage exists. It does not prove an upgrade from the exact production ledger, requester privacy after `0255`, or rejection of later unreviewed migrations. Keep production forward verification separate and held. |
| Feature-flag completeness (56) | No explicit completeness step in this workflow/package scripts. | **Not wired.** Require reviewed flag ownership, default-off unfinished capabilities, server-side enforcement, disabled-state UX and rollback evidence. Add off/on tests in isolated fixtures; hiding navigation alone is insufficient. |
| Evidence-backed requirement traceability (56, 111) | No traceability-validator invocation in the inspected workflow. Existing capability audit remains `FAIL`/`unproven`. | **Unproven.** Do not mark automated validation present. The indexing safety stop remains in force; no replacement index or validator implementation is authorized here. Parent owns a permitted review process for already supplied evidence. |
| PR evidence contract (111) | Workflow tests do not establish that each PR supplies the required narrative/evidence. No top-level PR-template candidate was found in the bounded `.github` inspection. | Parent should require requirement IDs, customer outcome, schema/RLS and AI/tool changes, provider behavior, security considerations, test results, staging scenario, feature flag/rollback and genuine external dependencies. No claim is made about organization-level templates or repository rules. |

## What the current tests actually exercise

### Authenticated E2E: meaningful existing runtime coverage

`tests/e2e/authenticated.spec.ts` uses a disposable account and family, signs in through the UI, completes onboarding, saves a quick-capture task, and checks that exactly one matching task persists. It then uses authenticated and anonymous clients for database assertions rather than relying solely on service-role access.

- Anonymous and member callers are denied access to `claim_ai_runs` with SQLSTATE `42501`.
- Forged run readiness/linkage, approved approval payloads, completed AI requests and negative token usage are rejected. Ordinary request creation has positive controls.
- A trusted server can persist a paused linked run without scheduling a household action.
- A parent wallet credit succeeds; after a synthetic role change to child, a new credit is rejected, update/delete affect no rows, and the original value is unchanged. Service-role creation and restored-manager update provide positive controls.
- Setup and cleanup are mutations, intentionally isolated. The general fixture has an explicit remote override; the current CI wiring uses local Supabase and does not enable it. Future CI gates must continue to prohibit production targets and remote overrides.

The supplied all-jobs-success result includes this isolated authenticated E2E job. It is not evidence of requester-private AI reads across two members, every wallet table/operation, cross-family storage access, or all application workflows. Case counts, skips and retry histories were not retrieved.

`tests/e2e/accessibility.spec.ts` checks public routes in both themes with axe, failing on serious or critical WCAG-tagged violations. This is valuable scoped coverage, not full authenticated accessibility or manual assistive-technology evidence.

### Static and mocked contracts: do not promote them to live proof

`tests/tenant-isolation-rls.test.ts` checks migration and application source strings. `tests/rls-isolation-sweep.test.ts` and `tests/wallet-write-rls-probe.test.ts` check that SQL probes contain expected assertions. Their comments describing past live results are not execution evidence for the supplied CI run.

`docs/audit/verify-pg.sh` is not invoked by the inspected CI workflow and is not ready to be added as a fail-closed gate unchanged. Its migration loop counts errors without a final nonzero failure, its seed step uses `ON_ERROR_STOP=0` and suppresses failures, and its shims/grants differ from actual Supabase. It also does not automatically execute both probe files merely by starting the harness. Prefer the existing isolated Supabase job for new live assertions.

`tests/tool-registry.test.ts` checks registered metadata, aliases, duplicate-guard hooks and generated provider schemas. `tests/tool-execute.test.ts` uses caller/ledger fakes to exercise validation, trust ordering, approvals, idempotency and result recording. `tests/assistant-tool-loop.test.ts` mocks provider responses. None establishes deployed RLS, real database concurrency or real provider behavior.

The inspected executor tests explicitly expect several behaviors requiring security-owner review: system actors evaluated as adults, low-risk handling overriding the generic role matrix, read-only tools bypassing the trust gate/ledger, and `skipTrust: true` permitting an approved-step path. These are observed test contracts, not a fresh exploit verification or proof that concurrent safety work has closed their risks. New tests must bind bypasses to independently validated server authority rather than preserve unsafe behavior just to keep CI green.

## Prioritized integration plan for the parent

All changes below are proposals, not implementations or commands executed by this audit. The parent owns workflow changes and the security owners supply the reviewed implementation and fixtures.

### P0: preserve the isolation boundary and make evidence inspectable

- Keep all mutation-bearing fixtures, marketing preparation, RLS probes and migration application on disposable Supabase. Explicitly reject remote database targets for the CI security suite; do not enable `E2E_ALLOW_REMOTE_SUPABASE` or provide Production credentials to PR jobs.
- Retain the real authenticated journey. Add CI JSON/JUnit reporting plus sanitized failure traces, uploaded with an always-run artifact step. Require the mandatory authenticated/security cases to execute rather than skip; expose retries instead of hiding flakiness behind the final job status.
- Record commit SHA, blueprint SHA, command, environment class, case IDs/counts, skips, retries and artifact identity in test evidence. Branch protection must require the approved jobs; its current configuration is unknown here.

### P0: check generated types against the isolated migrated schema

After `supabase start` succeeds and before accepting schema/application verification, use the same pinned CLI to generate into a temporary output and compare it with the committed types. The following is a proposed CI-only step, not an invocation performed here:

```bash
set -euo pipefail
supabase gen types typescript --local > "$RUNNER_TEMP/database.types.ts"
diff -u lib/database.types.ts "$RUNNER_TEMP/database.types.ts"
```

Keep generation failure and nonempty differences fatal. Do not silently overwrite or commit `lib/database.types.ts` in CI. If generation options or maintained wrappers require reconciliation, define the reviewed reproducible format first rather than suppressing drift. Quality typecheck/build still run against the committed artifact.

### P0: extend real authorization and execution-safety evidence

Add an explicit isolated authorization suite after Auth/schema readiness, with synthetically seeded households and roles. Seed using a trusted fixture client, but execute assertions as the actual anonymous/member/manager/delegate principals. Fail the job on any unexpected allow, denial of a positive control, or missing case.

| Security gap requiring evidence | Required fixture outcome |
| --- | --- |
| Requester privacy, pending reviewed `0255` | Two members of one family and a member of another family cannot read each other's requester-private AI requests, context, plans, runs, tool inputs/outputs or events except through an explicitly reviewed sharing rule. Test direct table access and supported application paths; verify the requester's permitted access still works. Exact assertions must follow the reviewed migration, not guessed policy names. |
| Cross-family and delegated access | Valid cross-family read/write payloads are denied; inactive, revoked or expired principals cannot act; a legitimate scoped actor succeeds. A zero-row response without a seeded visible positive control is insufficient. |
| Approval authority | Reject client-supplied approval bypasses, forged actor identity, stale/revoked approval and changed tool arguments. Prove approval binding and permission re-evaluation immediately before execution. |
| Idempotency and ambiguous failures | Use real database reservations and competing workers; one accepted logical action yields at most one effect. A timeout after possible execution must not automatically repeat a write or reuse another requester's result. |
| Sensitive read-only tools | Prove read scopes and redaction explicitly. Read-only classification does not exempt a tool from requester/consent checks or permit private data in logs and artifacts. |
| Wallets, storage and worker authority | Preserve existing worker/AI-insert/wallet assertions, expand to uncovered operations and sensitive resources, and test real role/grant behavior with positive controls. Do not treat policy names, RLS flags or static SQL text as behavioral proof. |

Existing probe paths identified by the static tests are `docs/audit/rls-isolation-check.sql` and `docs/audit/wallet-write-rls-check.sql`. Their bodies and fixture portability were not newly audited here. Before adding them, the parent must adapt/review their fixture assumptions for the isolated Supabase job and invoke them explicitly with SQL errors fatal; do not simply wire the legacy harness startup and call the probes covered.

### P1: offline domain/provider contracts and scored AI evaluations

- Add dedicated non-skippable CI entries for domain/provider contracts and golden/adversarial evaluation after dependency installation, with no live provider credentials and outbound effects intercepted. Those dedicated entries do not currently exist in the inspected package scripts.
- Reuse existing registry/executor/provider-loop tests as regression foundations, but test the real adapters and domain services against deterministic responses or isolated storage, not only mock shapes. Cover malformed tool JSON, schema violations, unknown tools, retries, rate limits, consent revocation, partial failure and truthful result summaries.
- Version the corpus, expected structured outcomes, rubric and thresholds. Require zero unauthorized writes, approval bypasses, requester-data leaks and untrusted-source instruction execution in mandatory adversarial cases. Quality thresholds need parent approval; missing thresholds are an incomplete gate, not an implicit success.
- Include capability-group risks already recorded in `docs/traceability/capability-audit-11-20.json`: imported text treated as data, unsupported travel/availability claims, child suitability, care/document consent, pantry expiry uncertainty and unknown subscription usage. Do not infer these customer outcomes from registry existence.
- Report fixture evaluation separately from actual model/provider evaluation. No live content-generation, payment or notification endpoints are authorized by this plan. External provider configuration and current live behavior remain unproven until separately approved evidence exists.

### P1: security scans, feature flags and PR evidence

- Add the parent-approved pinned secrets/security scanners as required checks. Redact findings and use narrowly scoped, expiring exceptions. Decide and document development-dependency coverage rather than assuming `--omit=dev` covers the complete build toolchain.
- Add explicit flag-contract tests for unfinished capabilities: safe defaults, server enforcement, disabled states, dependency handling and rollback. Do not alter shared navigation as part of this G0 work.
- Require the section 111 PR evidence fields listed in the gate map and link existing reviewed results to the exact commit. There is no authorization here to reconstruct the requirements index or implement a substitute for the stopped operation. Automated traceability validation remains unproven until the parent establishes a permitted mechanism.

### Held: forward-release integration and production evidence

The previously inspected release runner pins `0240-0254`, has no `--require-applied` mode, and reads manifest-listed migrations without detecting later unlisted local migrations. Its existing mocked tests do not prove an applied production release.

The future reserved integration remains parked: pin exactly `0240-0255` and source hashes, add reviewed requester-privacy pre/postconditions, reject later unreviewed migrations, and make read-only `--require-applied` succeed only for the exact `0001-0003` plus reviewed release ledger and security postconditions. Preserve atomic application, no historical stamping/replay, and no automatic retry after ambiguous failure. Parent confirmation and reviewed new SQL are still required before release-file edits; collective reading completion alone does not lift that hold.

The earlier preview result and the successful CI run are not an apply result. No production migration, schema, credential or provider status was checked for this document. Production secrets remain in GitHub Production; CI integration must not download them locally or expose their values.

## Inspected sources and remaining evidence limits

Newly inspected for this document: `.github/workflows/ci.yml`, `package.json`, `scripts/run-e2e.mjs`, `playwright.config.ts`, `vitest.config.ts`, `tests/tenant-isolation-rls.test.ts`, `tests/rls-isolation-sweep.test.ts`, `tests/wallet-write-rls-probe.test.ts`, `tests/tool-registry.test.ts`, `tests/tool-execute.test.ts`, `tests/assistant-tool-loop.test.ts`, `tests/e2e/authenticated.spec.ts`, `tests/e2e/accessibility.spec.ts`, and `docs/audit/verify-pg.sh`. Section 56 was read from `.next/blueprint-sections/56.md`; the complete section 111 content was reused without rereading its file. Previously established capability and forward-release findings were reused without rerunning or rechecking them.

Not established here: individual CI case counts/skips/retries, branch protection, organization-level scans/templates, production schema or credentials, deployed requester privacy, native-device behavior, external provider correctness, actual model quality, all critical customer journeys, or full blueprint completion. These are evidence limits, not permission to run missing checks or infer a missing secret/configuration value.
