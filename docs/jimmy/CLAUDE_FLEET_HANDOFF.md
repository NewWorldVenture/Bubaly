# Jimmy — Claude Fleet Manager Handoff

Bubaly issue [#779](https://github.com/NewWorldVenture/Bubaly/issues/779) starts with identity-isolated, read-only Claude Code probes. The owner selected API/provider authentication and a Vercel worker. Source now supplies a durable queue, Sandbox worker, manager controls, and CLI, disabled until configured and explicitly approved. No real account or worker has been verified. Keep #779 open until the acceptance evidence below exists.

## Runtime and scope

`GET /api/cron/claude-fleet` uses Bubaly's existing GitHub cron dispatcher (hourly) and version-controlled Vercel schedule (daily). It claims at most one bounded job per invocation. Concurrent invocations share the remote libSQL primary. Do not add a competing scheduler or use a SQLite file in Vercel's ephemeral filesystem. `POST` on the same route is the privileged manager/function surface; the CLI calls it.

The queue persists across request/process restarts; each worker VM runs a bounded probe. Successful session state is retained in a Sandbox snapshot for explicit continuation. This is a durable supervisor design; deployed persistence and continuously running agents are not yet evidenced. The referenced Python bridge package was absent; the initial equivalent functionality is implemented in Bubaly's `lib/claude-fleet` modules.

Only fixed synthetic nonce probes are admitted. Callers select an authorized alias and stable request key, never an arbitrary prompt, organization, credential, revision, or snapshot. Workers have no tools or MCP servers. Editing, deployment, browser conversation takeover, and autonomous backlog execution are outside this initial probe surface.

## Persistence and execution

- Permanent request-key/payload-digest deduplication survives completed jobs and lost commit responses; a different payload with the same key conflicts.
- Short write transactions atomically enforce one slot per normalized alias, global concurrency (default two, maximum eight), pause state, and UTC daily dispatch reservations. Remote runtime uses the HTTP client against the primary, without a local replica.
- Fenced leases recover only claims that never crossed dispatch, with at most two safe attempts. Timeout, crash, lost response, cleanup failure, or expired lease after dispatch causes quarantine, retaining the execution slot. No uncertain execution is automatically replayed.
- Every alias has a separate credential and reviewed base snapshot, isolated config directory/worktree, branch label, and fixed full commit SHA. The actual execution key must resolve to the expected organization immediately before dispatch; the same key must also verify its active workspace. A different Admin key's match cannot verify that execution key.
- Sandbox creation records its ID before commands. Operations recheck the active claim. The adapter captures the immutable SDK `Session`, avoiding operational `Sandbox` facade methods that can auto-resume a stopped VM.
- Success requires the exact nonce result, one turn, confirmed session ID, retained snapshot, and confirmed stop of the recorded Sandbox. A continuation requires a succeeded parent with identical alias/org/workspace/credential/ref/paths, matching restored association, and the same returned Claude session ID. Each parent permits at most one continuation.
- Pre-dispatch cancellation releases the claim. After dispatch, only confirmed stop of the exact Sandbox releases the slot. Unknown/unconfirmed resources remain quarantined. Explicit cancellation can retry cleanup of a quarantined job whose resource is known.

Probe limits: pinned `claude-haiku-4-5-20251001`, 128 output tokens, one turn, 64 KiB output, 20-second overall worker deadline plus bounded cleanup, zero API retries, and no thinking/tools/MCP/customizations/alternate auth. The worktree is read-only. VM commands have their own deadline; the VM has a 30-second timeout.

Every dispatch reserves $0.05 against `CLAUDE_FLEET_DAILY_BUDGET_USD` (default $0.25, maximum $1). Reservations remain after cancellation/failure/uncertainty. This bounds admissions, not exact billing; provider usage, Claude budget behavior, Sandbox charges, and snapshot storage need independent reconciliation. Manager output excludes raw provider logs, prompts, credentials, and fencing tokens. Durable timestamps and normalized states/errors are the operational record.

## Vercel setup remaining

These are setup instructions, not changes already applied. Start in a separate synthetic acceptance environment. No production configuration or hosted DDL was changed during implementation.

1. Bind the correct Bubaly Vercel project/team and verify supported Sandbox authentication and credential header-transform eligibility. Actual keys stay outside the VM and snapshot. See [Sandbox authentication](https://vercel.com/docs/sandbox/concepts/authentication) and [credential brokering](https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox).
2. Provision an authenticated remote libSQL primary. Set server-only `CLAUDE_FLEET_DATABASE_URL` (`libsql://…` or HTTPS) and `CLAUDE_FLEET_DATABASE_AUTH_TOKEN`. A separately authorized operator runs `node scripts/claude-fleet-init.mjs --confirm` under repository Node 24.21.0. Runtime handlers never run DDL. New schema starts **paused**; repeated initialization preserves current pause state.
3. Prepare a separate reviewed, secret-free Sandbox snapshot per alias containing `git`, `timeout`, `chmod`, Claude Code **2.1.268+**, and the Bubaly repository at `/vercel/sandbox/repository`, with the bound commit locally available. Verify that every base and continuation snapshot is available in the selected project's default Sandbox region; this adapter does not override the region. Cross-region restoration fails with `snapshot_region_mismatch`. See [snapshot regions](https://vercel.com/docs/sandbox/concepts/snapshots#snapshots-and-regions). No runtime package installation or GitHub credential is used. Images must contain no provider keys, account logins, production `.env`, shared auth directories, or unwanted customization.
4. Set `CLAUDE_FLEET_ACCOUNT_BINDINGS` to the owner-confirmed alias/org UUID array. Set matching `CLAUDE_FLEET_WORKER_BINDINGS` entries with `{alias,branch,revision,snapshotId,workspaceId}`. Each alias requires a unique snapshot and execution key. The all-zero revision and synthetic snapshot in `.env.example` are placeholders.
5. Add each `ANTHROPIC_API_KEY__ALIAS` through the server environment (alias uppercase, hyphens become underscores). Use an eligible API/personal/service-account key capable of both model execution and its own organization preflight. If `/v1/organizations/me` rejects that key, fail closed. Do not substitute an Admin key as evidence for another execution credential. Consult the [Admin authentication guide](https://platform.claude.com/docs/en/manage-claude/admin-api) and [organization endpoint](https://platform.claude.com/docs/en/api/http/organization/retrieve). The broker pins the required anthropic-workspace-id header for model requests using an organization-unscoped key; workspace access is verified separately with the same key. See the [workspace authentication requirements](https://platform.claude.com/docs/en/manage-claude/authentication). No human/email identity is inferred.
6. Create `CLAUDE_FLEET_MANAGER_SECRET` distinct from `CRON_SECRET`. Application sessions and cron credentials do not grant manager rights. Keep `CLAUDE_FLEET_WORKERS_ENABLED=false` and `CLAUDE_FLEET_PAID_PROBES_APPROVED=false` until live synthetic probes are authorized. Set concurrency/daily reservations deliberately.
7. Deploy through the existing release process and verify the correct revision/route. Then enable both execution gates in the acceptance environment and explicitly `resume`. Verify one account before testing parallel accounts. The optional organization-only preflight uses `CLAUDE_FLEET_PROBES_ENABLED` and separate `ANTHROPIC_ADMIN_API_KEY__ALIAS`; it reports `workerConnection: not_checked` and is not worker acceptance.

## Controls

All controls POST JSON with a manager bearer token to `/api/cron/claude-fleet`. Only `application/json` is accepted; bodies are streamed with an 8 KiB cap and action fields checked strictly. Responses are not cached. Authorization precedes body/configuration/database reads.

| Action | Fields after action | Behavior |
|---|---|---|
| submit | alias, requestKey | Queue server-bound fixed probe; duplicate returns original |
| continue | alias, requestKey, previousJobId | Queue one exact same-session continuation |
| status, result, cancel | jobId | Safe metadata, verified nonce result, or cancellation |
| list | none | Latest 100 jobs and pause state |
| pause | none | Block future dispatch; existing command is not forcibly stopped |
| resume | none | Validate gates/configuration and allow dispatch |
| stop | none | Pause, cancel queued claims, and attempt verified active cleanup |
| tick | none | Run one bounded tick through the same supervisor |

The CLI uses the exact trusted HTTPS `CLAUDE_FLEET_MANAGER_URL` and environment `CLAUDE_FLEET_MANAGER_SECRET`. It rejects local targets, URL credentials, query/fragment, and redirects, bounds responses, and prints neither raw errors nor secret fields.

```text
node scripts/claude-fleet.mjs --help
node scripts/claude-fleet.mjs submit SyntheticAccount synthetic:probe:1
node scripts/claude-fleet.mjs tick
node scripts/claude-fleet.mjs status <jobId>
node scripts/claude-fleet.mjs result <jobId>
node scripts/claude-fleet.mjs continue SyntheticAccount synthetic:probe:2 <previousJobId>
node scripts/claude-fleet.mjs cancel <jobId>
node scripts/claude-fleet.mjs pause
node scripts/claude-fleet.mjs stop
```

Status/result/list, pause/stop, and cancellation remain available when paid execution is disabled. Unknown-Sandbox quarantine needs operator reconciliation with Vercel; do not assume the resource stopped because a lease or expected timeout elapsed. There is deliberately no force-release control.

## Verification and acceptance

Local tests use synthetic credentials, SQLite, and injected SDK/provider responses. Two-client file-backed SQLite tests prove atomic claims/admission, reopened persistence, permanent dedupe, stale fencing, retained quarantine slots, exact continuation, and commit-response loss. Worker/adapter tests cover auth/path/session mismatches, result/deadline/output limits, immutable-session cancellation races, and cleanup. Manager/service/CLI tests exercise combined controls and a synthetic end-to-end probe. These tests are not remote execution evidence.

Before closure, record actual submit/status/result/cancel, exact continuation, two-account concurrency, auth/usage failures, timeout, duplicate prevention, restart/lost-response recovery, quarantine, and verified stop. Verify remote queue persistence across deployment restarts and the existing scheduler invoking the correct revision. Reconcile provider/Sandbox costs and snapshot retention. Keep release decisions within CI, branch protection, independent review, and normal rollback.

The intended labels remain unverified:

| Alias | Verified identity | Worktree/branch | Probe job | Session ID | Result | Permissions | Blocker | Checked |
|---|---|---|---|---|---|---|---|---|
| BubalySupport | Unverified | Unbound | None | None | Not run | No tools proposed | Owner binding/live acceptance missing | Not checked |
| NewWorldVenture | Unverified | Unbound | None | None | Not run | No tools proposed | Owner binding/live acceptance missing | Not checked |
| Daniel | Unverified | Unbound | None | None | Not run | No tools proposed | Owner binding/live acceptance missing | Not checked |
| Blacksonte | Unverified | Unbound | None | None | Not run | No tools proposed | Owner binding/live acceptance missing | Not checked |
| Surge | Unverified | Unbound | None | None | Not run | No tools proposed | Owner binding/live acceptance missing | Not checked |

Configuration, org preflight, process heartbeat, and synthetic tests do not establish a connected account. Existing Claude browser conversations require an explicit authorized task/branch/progress handoff. Broader execution follows read-only acceptance and separate design/review.
