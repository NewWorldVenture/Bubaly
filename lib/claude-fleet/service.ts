import { createHash } from 'node:crypto';
import { isOrganizationId, isWorkspaceId, verifyAnthropicOrganization } from './anthropic-identity';
import type { FleetWorkerRegistration } from './runtime-config';
import { ClaudeFleetStore, type FleetJob, type FleetJobError, type FleetJobPayload } from './store';
import {
  claudeWorkerPaths, claudeWorkerProbeResult, runClaudeReadOnlyWorker,
  type ClaudeWorkerAdapter, type ClaudeWorkerOutcome, type ConfirmedClaudeWorkerSession,
} from './worker';

export const FLEET_PROBE_BUDGET_USD = 0.05;
export const FLEET_PROBE_TIMEOUT_MS = 20_000;
const CLAIM_LEASE_MS = 90_000;
const STOP_TIMEOUT_MS = 5_000;

export type FleetSupervisorDependencies = {
  adapterFactory(registration: FleetWorkerRegistration, onCreated: (id: string) => Promise<boolean>, isActive: () => Promise<boolean>): ClaudeWorkerAdapter;
  stopSandbox(id: string): Promise<boolean>;
  verifyIdentity?: typeof verifyAnthropicOrganization;
  runWorker?: typeof runClaudeReadOnlyWorker;
  now?: () => number;
};

export function fleetProbePayload(registration: FleetWorkerRegistration, previousJobId?: string): FleetJobPayload {
  return {
    mode: 'read_only', alias: registration.alias,
    expectedOrganizationId: registration.expectedOrganizationId,
    workspaceId: registration.workspaceId,
    credentialBindingId: registration.credentialBindingId,
    branch: registration.branch, revision: registration.revision,
    prompt: 'Read-only synthetic worker probe',
    ...(previousJobId ? { previousJobId } : {}),
    maxBudgetUsd: FLEET_PROBE_BUDGET_USD, timeoutMs: FLEET_PROBE_TIMEOUT_MS,
  };
}

/** Never expose the fencing token or a transient credential through the manager API. */
export function fleetJobView(job: FleetJob) {
  return {
    id: job.id, alias: job.payload.alias, organizationId: job.payload.expectedOrganizationId,
    workspaceId: isWorkspaceId(job.payload.workspaceId) ? job.payload.workspaceId : null,
    branch: job.payload.branch, revision: job.payload.revision, mode: job.payload.mode,
    status: job.status, attempts: job.attempts, error: job.error,
    createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
    sessionId: job.sessionId, snapshotId: job.snapshotId, sandboxId: job.sandboxId,
    permissions: 'no_tools', workerConnection: job.status === 'succeeded' && isWorkspaceId(job.payload.workspaceId) ? 'probe_verified' : 'unverified',
  };
}

function registrationMatches(job: FleetJob, registration: FleetWorkerRegistration): boolean {
  const payload = job.payload;
  return payload.alias === registration.alias && payload.expectedOrganizationId === registration.expectedOrganizationId
    && isWorkspaceId(payload.workspaceId) && isWorkspaceId(registration.workspaceId)
    && payload.workspaceId === registration.workspaceId
    && payload.credentialBindingId === registration.credentialBindingId
    && payload.branch === registration.branch && payload.revision === registration.revision;
}

async function previousSession(store: ClaudeFleetStore, job: FleetJob): Promise<ConfirmedClaudeWorkerSession | undefined> {
  if (!job.payload.previousJobId) return undefined;
  const parent = await store.get(job.payload.previousJobId);
  if (!parent || parent.status !== 'succeeded' || !isOrganizationId(parent.sessionId) || !parent.snapshotId || !parent.sandboxId
    || parent.payload.alias !== job.payload.alias || parent.payload.expectedOrganizationId !== job.payload.expectedOrganizationId
    || !isWorkspaceId(parent.payload.workspaceId) || parent.payload.workspaceId !== job.payload.workspaceId
    || parent.payload.credentialBindingId !== job.payload.credentialBindingId || parent.payload.branch !== job.payload.branch
    || parent.payload.revision !== job.payload.revision) {
    throw new Error('invalid_continuation');
  }
  return {
    alias: parent.payload.alias, expectedOrganizationId: parent.payload.expectedOrganizationId,
    workspaceId: parent.payload.workspaceId,
    credentialBindingId: parent.payload.credentialBindingId, branch: parent.payload.branch, revision: parent.payload.revision,
    ...claudeWorkerPaths(parent.payload.alias), confirmed: true, sessionId: parent.sessionId,
    snapshotId: parent.snapshotId, sandboxId: parent.sandboxId,
  };
}

/** A cancellation keeps its execution slot until the exact Sandbox is proven stopped. */
export async function cancelFleetJob(store: ClaudeFleetStore, id: string, dependencies: Pick<FleetSupervisorDependencies, 'stopSandbox'>) {
  await store.requestCancel(id);
  const job = await store.get(id);
  if (job && ['cancel_requested', 'quarantined'].includes(job.status) && job.claimToken) {
    if (job.sandboxId) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        stopped = await Promise.race([
          dependencies.stopSandbox(job.sandboxId),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS); }),
        ]);
      } catch { /* normalized below */ }
      finally { if (timer) clearTimeout(timer); }
      if (stopped) await store.confirmCancelled(job.id, job.claimToken, job.sandboxId);
      else await store.quarantine(job.id, job.claimToken, 'cancel_uncertain');
    } else {
      // Creation may have committed remotely even if its response never arrived.
      await store.quarantine(job.id, job.claimToken, 'cancel_uncertain');
    }
  }
  return store.get(id);
}

function validSuccess(job: FleetJob, outcome: Extract<ClaudeWorkerOutcome, { status: 'succeeded' }>, previous?: ConfirmedClaudeWorkerSession): boolean {
  const session = outcome.session;
  const paths = claudeWorkerPaths(job.payload.alias);
  return outcome.stopConfirmed === true && outcome.sandboxId === job.sandboxId && outcome.stoppedSandboxId === job.sandboxId
    && outcome.result === claudeWorkerProbeResult(job.id) && session?.confirmed === true
    && session.alias === job.payload.alias && session.expectedOrganizationId === job.payload.expectedOrganizationId
    && isWorkspaceId(session.workspaceId) && session.workspaceId === job.payload.workspaceId
    && session.credentialBindingId === job.payload.credentialBindingId && session.branch === job.payload.branch
    && session.revision === job.payload.revision && session.configDirectory === paths.configDirectory
    && session.worktreePath === paths.worktreePath && session.sandboxId === job.sandboxId
    && isOrganizationId(session.sessionId) && (!previous || previous.sessionId === session.sessionId);
}

async function currentTickResult(store: ClaudeFleetStore, id: string, reason?: string) {
  const persisted = await store.get(id);
  return { status: persisted?.status ?? 'claim_lost', jobId: id, ...(reason ? { reason } : {}) };
}

async function confirmStoppedCancellation(store: ClaudeFleetStore, job: FleetJob | null, token: string, outcome: ClaudeWorkerOutcome): Promise<boolean> {
  if (!job || !['cancel_requested', 'quarantined'].includes(job.status)
    || job.claimToken !== token || !outcome.stopConfirmed || !outcome.stoppedSandboxId
    || outcome.stoppedSandboxId !== job.sandboxId) return false;
  return store.confirmCancelled(job.id, token, outcome.stoppedSandboxId);
}

/** One bounded job per existing scheduler invocation; SQL serializes other invocations. */
export async function runFleetTick(
  store: ClaudeFleetStore, registrations: FleetWorkerRegistration[], maxConcurrency: number,
  dependencies: FleetSupervisorDependencies, signal?: AbortSignal,
  dailyBudgetUsd = 0.25,
) {
  // A previously requested stop is reconciled even while fleet execution is paused.
  await Promise.all((await store.listActive()).filter((job) => job.status === 'cancel_requested'
    || (job.status === 'quarantined' && job.error === 'cancel_uncertain'))
    .map((pending) => cancelFleetJob(store, pending.id, dependencies)));
  if (signal?.aborted) return { status: 'cancelled' as const };
  const job = await store.claim({ maxConcurrency, leaseMs: CLAIM_LEASE_MS, maxAttempts: 2 });
  if (!job || !job.claimToken) return { status: 'idle' as const };
  const token = job.claimToken;
  const configured = registrations.find((entry) => registrationMatches(job, entry));
  // Capture one immutable key/binding for both preflight and paid execution.
  const registration = configured ? { ...configured } : undefined;
  if (!registration) {
    await store.failBeforeDispatch(job.id, token, 'credentials_unavailable', 1);
    return { status: 'blocked' as const, jobId: job.id, reason: 'binding_changed' };
  }
  if (!registration.executionKey?.trim()
    || createHash('sha256').update(registration.executionKey).digest('hex') !== registration.credentialBindingId) {
    await store.failBeforeDispatch(job.id, token, 'credentials_unavailable', 1);
    return currentTickResult(store, job.id, 'execution_identity_unverified');
  }
  let session: ConfirmedClaudeWorkerSession | undefined;
  try { session = await previousSession(store, job); }
  catch {
    await store.failBeforeDispatch(job.id, token, 'setup_failed', 1);
    return { status: 'blocked' as const, jobId: job.id, reason: 'invalid_continuation' };
  }
  const now = dependencies.now ?? Date.now;
  let preflight;
  try {
    preflight = await (dependencies.verifyIdentity ?? verifyAnthropicOrganization)({
      apiKey: registration.executionKey, expectedOrganizationId: registration.expectedOrganizationId,
      workspaceId: registration.workspaceId,
      now: () => new Date(now()),
    });
  } catch {
    await store.failBeforeDispatch(job.id, token, 'setup_failed', 2);
    return currentTickResult(store, job.id, 'provider_unreachable');
  }
  const age = now() - Date.parse(preflight.checkedAt);
  if (preflight.status !== 'organization_verified' || preflight.organizationId !== registration.expectedOrganizationId
    || preflight.workspaceId !== registration.workspaceId
    || !Number.isFinite(age) || age < 0 || age > 60_000) {
    const error: FleetJobError = preflight.status === 'auth_rejected' ? 'provider_auth_rejected'
      : preflight.status === 'rate_limited' ? 'provider_rate_limited' : 'identity_unverified';
    await store.failBeforeDispatch(job.id, token, error, preflight.status === 'rate_limited' ? 2 : 1);
    return currentTickResult(store, job.id, preflight.status === 'organization_verified' ? 'execution_identity_unverified' : preflight.status);
  }
  if (signal?.aborted) {
    await store.requestCancel(job.id);
    return currentTickResult(store, job.id, 'cancelled_before_dispatch');
  }
  if (!await store.markDispatched(job.id, token, { dailyBudgetUsd })) {
    await store.failBeforeDispatch(job.id, token, 'setup_failed', 1);
    return currentTickResult(store, job.id, 'dispatch_not_permitted');
  }
  // Persist the uncertain-dispatch boundary before an external VM or model can start.
  try {
    const isActive = async () => {
      const current = await store.get(job.id);
      return current?.status === 'running' && current.claimToken === token
        && (current.leaseExpiresAt ?? 0) > now() && !signal?.aborted && !await store.isPaused();
    };
    const onCreated = async (id: string) => {
      if (!await store.attachSandbox(job.id, token, id)) return false;
      return isActive();
    };
    const adapter = dependencies.adapterFactory(registration, onCreated, isActive);
    const outcome = await (dependencies.runWorker ?? runClaudeReadOnlyWorker)({
      jobId: job.id, binding: job.payload, preflight,
      preflightCredentialBindingId: registration.credentialBindingId,
      previousSession: session, timeoutMs: job.payload.timeoutMs, maxBudgetUsd: job.payload.maxBudgetUsd, signal,
      now: () => new Date(now()),
    }, adapter);
    let current = await store.get(job.id);
    if (await confirmStoppedCancellation(store, current, token, outcome)) {
      return currentTickResult(store, job.id);
    } else if (outcome.status === 'succeeded' && current && validSuccess(current, outcome, session)) {
      const completed = await store.complete(job.id, token, {
        sandboxId: outcome.sandboxId, stoppedSandboxId: outcome.stoppedSandboxId,
        sessionId: outcome.session.sessionId, snapshotId: outcome.session.snapshotId, result: outcome.result,
      });
      if (!completed) {
        // Cancellation may win between the read above and the completion CAS.
        current = await store.get(job.id);
        if (!await confirmStoppedCancellation(store, current, token, outcome)) {
          await store.quarantine(job.id, token, 'execution_uncertain');
        }
      }
    } else {
      await store.quarantine(job.id, token, 'execution_uncertain');
    }
    current = await store.get(job.id);
    if (current?.status === 'quarantined' && current.error === 'cancel_uncertain') {
      // The database preserves cancellation intent when it wins a quarantine CAS.
      await confirmStoppedCancellation(store, current, token, outcome);
    }
    return currentTickResult(store, job.id);
  } catch {
    // Do not retry a model/Sandbox start whose result may have been lost.
    await store.quarantine(job.id, token, 'execution_uncertain');
    return currentTickResult(store, job.id);
  }
}
