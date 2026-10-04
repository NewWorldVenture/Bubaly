import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cancelFleetJob, fleetJobView, fleetProbePayload, runFleetTick, type FleetSupervisorDependencies } from '@/lib/claude-fleet/service';
import { ClaudeFleetStore, type FleetJob } from '@/lib/claude-fleet/store';
import type { FleetWorkerRegistration } from '@/lib/claude-fleet/runtime-config';
import { claudeWorkerProbeResult, runClaudeReadOnlyWorker, type ClaudeWorkerAdapter, type ClaudeWorkerOutcome } from '@/lib/claude-fleet/worker';

const ORG = '00000000-0000-4000-8000-000000000000';
const OTHER_ORG = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'wrkspc_SyntheticA';
const OTHER_WORKSPACE = 'wrkspc_SyntheticB';
const SESSION = '22222222-2222-4222-8222-222222222222';

function registration(alias = 'SYNTHETIC_A'): FleetWorkerRegistration {
  const executionKey = `synthetic-execution-key-${alias}`;
  return {
    alias, expectedOrganizationId: ORG, branch: 'synthetic/read-only', revision: 'a'.repeat(40),
    workspaceId: alias === 'SYNTHETIC_A' ? WORKSPACE : OTHER_WORKSPACE,
    baseSnapshotId: `snap_base_${alias}`, executionKey,
    credentialBindingId: createHash('sha256').update(executionKey).digest('hex'),
  };
}

describe('Claude fleet supervisor integration with two real synthetic SQLite clients', () => {
  let directory: string;
  let clients: Client[];
  let first: ClaudeFleetStore;
  let second: ClaudeFleetStore;
  let now: number;
  let dependencies: FleetSupervisorDependencies;
  let bindings: FleetWorkerRegistration[];

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 4, 20);
    directory = await mkdtemp(join(tmpdir(), 'bubaly-fleet-service-'));
    const url = pathToFileURL(join(directory, 'synthetic.db')).href;
    clients = [createClient({ url, timeout: 0 }), createClient({ url, timeout: 0 })];
    await clients[0].execute('PRAGMA journal_mode = WAL');
    first = new ClaudeFleetStore(clients[0], { now: () => now });
    second = new ClaudeFleetStore(clients[1], { now: () => now });
    await first.initialize();
    await first.setPaused(false);
    bindings = [registration()];
    dependencies = {
      now: () => now,
      verifyIdentity: vi.fn(async (options) => ({ status: 'organization_verified' as const, organizationId: ORG, workspaceId: options.workspaceId, checkedAt: new Date(now).toISOString() })),
      adapterFactory: vi.fn((bound, onCreated, isActive): ClaudeWorkerAdapter => ({
        async open(input) {
          if (!await isActive()) throw new Error('claim_lost_before_create');
          const sandboxId = `sbx_${input.jobId}`;
          if (!await onCreated(sandboxId)) throw new Error('claim_lost_after_create');
          return {
            sandboxId, binding: input.binding, paths: input.paths,
            executionAuth: { kind: 'api_key', organizationId: bound.expectedOrganizationId, workspaceId: bound.workspaceId, credentialBindingId: bound.credentialBindingId },
            async runCommand(command) {
              if (!await isActive()) throw new Error('claim_lost_before_command');
              return {
                exitCode: 0, stderr: '',
                stdout: command.args[0] === 'auth'
                  ? JSON.stringify({ loggedIn: true, authMethod: 'api_key', configDirectory: input.paths.configDirectory })
                  : JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, num_turns: 1, result: claudeWorkerProbeResult(input.jobId) }),
              };
            },
            async snapshot() {
              if (!await isActive()) throw new Error('claim_lost_before_snapshot');
              return { snapshotId: `snap_${input.jobId}` };
            },
            async stop() {},
          };
        },
      })),
      stopSandbox: vi.fn(async () => true),
      runWorker: vi.fn(runClaudeReadOnlyWorker),
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const client of clients ?? []) client.close();
    // Delete only this suite's freshly created synthetic directory.
    if (directory && resolve(directory).startsWith(`${resolve(tmpdir())}${sep}bubaly-fleet-service-`)) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (error) {
        if (process.platform !== 'win32' || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'EBUSY') throw error;
      }
    }
  });

  async function submit(key = 'synthetic:request', bound = bindings[0], previousJobId?: string) {
    return (await first.submit(key, fleetProbePayload(bound, previousJobId))).job;
  }
  const tick = (store = first, budget = 0.25, signal?: AbortSignal) => runFleetTick(store, bindings, 2, dependencies, signal, budget);
  async function running(): Promise<FleetJob> {
    await submit();
    const claim = (await first.claim({ maxConcurrency: 2, leaseMs: 90_000 }))!;
    await first.markDispatched(claim.id, claim.claimToken!);
    await first.attachSandbox(claim.id, claim.claimToken!, `sbx_${claim.id}`);
    return (await first.get(claim.id))!;
  }

  it('executes the complete fixed probe through durable state and stores stopped session evidence', async () => {
    const job = await submit();
    expect(await tick()).toEqual({ status: 'succeeded', jobId: job.id });
    const stored = (await second.get(job.id))!;
    expect(stored).toMatchObject({ status: 'succeeded', attempts: 1, sessionId: SESSION, snapshotId: `snap_${job.id}`, sandboxId: `sbx_${job.id}`, result: claudeWorkerProbeResult(job.id) });
    expect(dependencies.verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ apiKey: bindings[0].executionKey, expectedOrganizationId: ORG, workspaceId: WORKSPACE }));
    expect(dependencies.adapterFactory).toHaveBeenCalledOnce();
    expect(fleetJobView(stored)).toMatchObject({ status: 'succeeded', workerConnection: 'probe_verified', permissions: 'no_tools', workspaceId: WORKSPACE });
    const exposed = JSON.stringify(fleetJobView(stored));
    expect(exposed).not.toContain(stored.claimToken);
    expect(exposed).not.toContain(bindings[0].executionKey);
    expect(exposed).not.toContain(bindings[0].credentialBindingId);
  });

  it('verifies that the exact execution key hashes to the registered fingerprint before even preflight', async () => {
    bindings[0].credentialBindingId = 'wrong-fingerprint';
    const job = await submit();
    expect(await tick()).toMatchObject({ status: 'failed', reason: 'execution_identity_unverified' });
    expect(await first.get(job.id)).toMatchObject({ dispatchStartedAt: null, error: 'credentials_unavailable' });
    expect(dependencies.verifyIdentity).not.toHaveBeenCalled();
    expect(dependencies.adapterFactory).not.toHaveBeenCalled();
  });

  it('fails closed for legacy persisted jobs without a workspace instead of dispatching them', async () => {
    const job = await submit();
    await clients[1].execute({ sql: 'UPDATE claude_fleet_jobs SET payload_json = ? WHERE id = ?', args: [JSON.stringify({ ...job.payload, workspaceId: undefined }), job.id] });
    expect(await tick()).toMatchObject({ status: 'blocked', reason: 'binding_changed' });
    expect(await first.get(job.id)).toMatchObject({ status: 'failed', dispatchStartedAt: null });
    expect(dependencies.verifyIdentity).not.toHaveBeenCalled();
    expect(dependencies.runWorker).not.toHaveBeenCalled();
  });

  it('never labels a legacy successful job without workspace evidence as a verified worker', async () => {
    const job = await submit();
    await tick();
    const stored = (await first.get(job.id))!;
    await clients[1].execute({ sql: 'UPDATE claude_fleet_jobs SET payload_json = ? WHERE id = ?', args: [JSON.stringify({ ...stored.payload, workspaceId: undefined }), job.id] });
    expect(fleetJobView((await first.get(job.id))!)).toMatchObject({ status: 'succeeded', workspaceId: null, workerConnection: 'unverified' });
  });

  it.each([
    { organizationId: OTHER_ORG },
    { workspaceId: OTHER_WORKSPACE }, { workspaceId: undefined },
    { checkedAt: '2026-10-04T19:58:00.000Z' },
    { checkedAt: '2026-10-04T20:00:00.001Z' },
    { checkedAt: 'invalid' },
  ])('rejects falsely verified or stale org evidence before reserving a paid dispatch: %j', async (change) => {
    const job = await submit();
    vi.mocked(dependencies.verifyIdentity!).mockResolvedValue({ status: 'organization_verified', organizationId: ORG, workspaceId: WORKSPACE, checkedAt: new Date(now).toISOString(), ...change });
    expect(await tick()).toMatchObject({ status: 'failed', reason: 'execution_identity_unverified' });
    expect(await first.get(job.id)).toMatchObject({ dispatchStartedAt: null });
    expect(dependencies.runWorker).not.toHaveBeenCalled();
  });

  it('captures a single key even if the configured registration is mutated during preflight', async () => {
    const originalKey = bindings[0].executionKey;
    const job = await submit();
    vi.mocked(dependencies.verifyIdentity!).mockImplementation(async () => {
      bindings[0].executionKey = 'synthetic-mutated-key';
      return { status: 'organization_verified', organizationId: ORG, workspaceId: WORKSPACE, checkedAt: new Date(now).toISOString() };
    });
    expect(await tick()).toEqual({ status: 'succeeded', jobId: job.id });
    expect(vi.mocked(dependencies.adapterFactory).mock.calls[0][0].executionKey).toBe(originalKey);
  });

  it('normalizes thrown identity diagnostics into bounded pre-dispatch retries without exposing them', async () => {
    const job = await submit();
    vi.mocked(dependencies.verifyIdentity!).mockRejectedValue(new Error('private provider diagnostic sk-ant-synthetic-secret'));
    expect(await tick()).toEqual({ status: 'queued', jobId: job.id, reason: 'provider_unreachable' });
    expect(await tick()).toEqual({ status: 'failed', jobId: job.id, reason: 'provider_unreachable' });
    expect(await tick()).toEqual({ status: 'idle' });
    const stored = (await first.get(job.id))!;
    expect(stored).toMatchObject({ status: 'failed', attempts: 2, dispatchStartedAt: null });
    expect(JSON.stringify(stored)).not.toContain('sk-ant-synthetic-secret');
    expect(dependencies.adapterFactory).not.toHaveBeenCalled();
  });

  it('bounds retryable provider usage errors before dispatch', async () => {
    await submit();
    vi.mocked(dependencies.verifyIdentity!).mockResolvedValue({ status: 'rate_limited', checkedAt: new Date(now).toISOString() });
    expect(await tick()).toMatchObject({ status: 'queued', reason: 'rate_limited' });
    expect(await tick()).toMatchObject({ status: 'failed', reason: 'rate_limited' });
    expect(dependencies.runWorker).not.toHaveBeenCalled();
  });

  it('does not dispatch when a pause wins during identity preflight', async () => {
    const job = await submit();
    vi.mocked(dependencies.verifyIdentity!).mockImplementation(async () => {
      await second.setPaused(true);
      return { status: 'organization_verified', organizationId: ORG, workspaceId: WORKSPACE, checkedAt: new Date(now).toISOString() };
    });
    expect(await tick()).toMatchObject({ status: 'failed', reason: 'dispatch_not_permitted' });
    expect(await first.get(job.id)).toMatchObject({ dispatchStartedAt: null });
    expect(dependencies.adapterFactory).not.toHaveBeenCalled();
  });

  it('reports actual cancellation when another client cancels during preflight', async () => {
    const job = await submit();
    vi.mocked(dependencies.verifyIdentity!).mockImplementation(async () => {
      await second.requestCancel(job.id);
      return { status: 'organization_verified', organizationId: ORG, workspaceId: WORKSPACE, checkedAt: new Date(now).toISOString() };
    });
    expect(await tick()).toMatchObject({ status: 'cancelled', jobId: job.id });
    expect(await first.get(job.id)).toMatchObject({ status: 'cancelled', dispatchStartedAt: null });
    expect(dependencies.runWorker).not.toHaveBeenCalled();
  });

  it('honors cancellation before allocation and after preflight', async () => {
    const job = await submit();
    const controller = new AbortController();
    controller.abort();
    expect(await tick(first, 0.25, controller.signal)).toEqual({ status: 'cancelled' });
    expect(await first.get(job.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(dependencies.verifyIdentity).not.toHaveBeenCalled();
    const afterPreflight = new AbortController();
    vi.mocked(dependencies.verifyIdentity!).mockImplementation(async () => {
      afterPreflight.abort();
      return { status: 'organization_verified', organizationId: ORG, workspaceId: WORKSPACE, checkedAt: new Date(now).toISOString() };
    });
    expect(await tick(first, 0.25, afterPreflight.signal)).toMatchObject({ status: 'cancelled', reason: 'cancelled_before_dispatch' });
    expect(dependencies.runWorker).not.toHaveBeenCalled();
  });

  it('persists a created Sandbox ID before rejecting the fence after concurrent cancellation', async () => {
    const job = await submit();
    vi.mocked(dependencies.adapterFactory).mockImplementation((_, onCreated, isActive) => ({
      async open() {
        expect(await isActive()).toBe(true);
        await second.requestCancel(job.id);
        expect(await onCreated(`sbx_${job.id}`)).toBe(false);
        expect(await second.get(job.id)).toMatchObject({ sandboxId: `sbx_${job.id}` });
        throw new Error('synthetic_creation_cancelled');
      },
    }));
    expect(await tick()).toMatchObject({ status: 'quarantined' });
    expect(await cancelFleetJob(second, job.id, dependencies)).toMatchObject({ status: 'cancelled' });
    expect(dependencies.stopSandbox).toHaveBeenCalledWith(`sbx_${job.id}`);
  });

  it('returns cancellation after the worker succeeds while another client requests a stop', async () => {
    const job = await submit();
    vi.mocked(dependencies.runWorker!).mockImplementation(async (input, adapter) => {
      const outcome = await runClaudeReadOnlyWorker(input, adapter);
      await second.requestCancel(job.id);
      return outcome;
    });
    expect(await tick()).toEqual({ status: 'cancelled', jobId: job.id });
    expect(await first.get(job.id)).toMatchObject({ status: 'cancelled', sessionId: null, snapshotId: null, result: null });
  });

  it('reconciles cancellation that wins precisely between the outcome read and completion CAS', async () => {
    const job = await submit();
    const complete = first.complete.bind(first);
    vi.spyOn(first, 'complete').mockImplementationOnce(async (...args) => {
      await second.requestCancel(job.id);
      return complete(...args);
    });
    expect(await tick()).toEqual({ status: 'cancelled', jobId: job.id });
    expect(await first.get(job.id)).toMatchObject({ status: 'cancelled', result: null });
  });

  it('reconciles cancellation that wins precisely between a failed outcome read and quarantine CAS', async () => {
    const job = await submit();
    vi.mocked(dependencies.runWorker!).mockImplementation(async (input, adapter) => {
      const outcome = await runClaudeReadOnlyWorker(input, adapter);
      if (outcome.status !== 'succeeded') throw new Error('synthetic setup unexpectedly failed');
      return {
        status: 'quarantined', reason: 'worker_crash', checkedAt: outcome.checkedAt, permissions: 'no_tools',
        sandboxId: outcome.sandboxId, stoppedSandboxId: outcome.stoppedSandboxId, stopConfirmed: true,
      };
    });
    const quarantine = first.quarantine.bind(first);
    vi.spyOn(first, 'quarantine').mockImplementationOnce(async (...args) => {
      await second.requestCancel(job.id);
      return quarantine(...args);
    });
    expect(await tick()).toEqual({ status: 'cancelled', jobId: job.id });
    expect(await first.get(job.id)).toMatchObject({ status: 'cancelled', result: null });
  });

  it('keeps interrupted cancellation intent durable and reconciles its known Sandbox on the next tick', async () => {
    const job = await running();
    await second.requestCancel(job.id);
    await first.quarantine(job.id, job.claimToken!, 'execution_uncertain');
    expect(await first.get(job.id)).toMatchObject({ status: 'quarantined', error: 'cancel_uncertain' });
    await first.setPaused(true);
    expect(await tick()).toEqual({ status: 'idle' });
    expect(await first.get(job.id)).toMatchObject({ status: 'cancelled' });
    expect(dependencies.runWorker).not.toHaveBeenCalled();
  });

  it('preserves a cancellation already confirmed by a second manager despite a late successful outcome', async () => {
    const job = await submit();
    vi.mocked(dependencies.runWorker!).mockImplementation(async (input, adapter) => {
      const outcome = await runClaudeReadOnlyWorker(input, adapter);
      await cancelFleetJob(second, job.id, dependencies);
      return outcome;
    });
    expect(await tick()).toEqual({ status: 'cancelled', jobId: job.id });
    expect(await second.get(job.id)).toMatchObject({ status: 'cancelled', result: null });
  });

  it('keeps an uncertain crash quarantined and never replays its dispatched job', async () => {
    const job = await submit();
    vi.mocked(dependencies.runWorker!).mockImplementation(async (input, adapter) => {
      await adapter.open({ jobId: input.jobId, binding: input.binding, paths: { configDirectory: '/unused', worktreePath: '/unused' } }, new AbortController().signal);
      throw new Error('private crash sk-ant-synthetic-secret');
    });
    expect(await tick()).toEqual({ status: 'quarantined', jobId: job.id });
    expect(await tick()).toEqual({ status: 'idle' });
    const stored = (await first.get(job.id))!;
    expect(stored).toMatchObject({ status: 'quarantined', attempts: 1, error: 'execution_uncertain' });
    expect(stored.dispatchStartedAt).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain('sk-ant-synthetic-secret');
    expect(dependencies.runWorker).toHaveBeenCalledOnce();
  });

  it('can cancel a quarantined job with a known stopped Sandbox and free its account slot', async () => {
    const job = await running();
    await first.quarantine(job.id, job.claimToken!, 'execution_uncertain');
    const next = await submit('synthetic:next');
    expect(await first.claim({ maxConcurrency: 2, leaseMs: 10_000 })).toBeNull();
    expect(await cancelFleetJob(second, job.id, dependencies)).toMatchObject({ status: 'cancelled' });
    expect((await first.claim({ maxConcurrency: 2, leaseMs: 10_000 }))?.id).toBe(next.id);
  });

  it.each(['false', 'throw'])('retains a quarantined account slot when stop is %s', async (mode) => {
    const job = await running();
    await first.quarantine(job.id, job.claimToken!, 'execution_uncertain');
    if (mode === 'false') vi.mocked(dependencies.stopSandbox).mockResolvedValue(false);
    else vi.mocked(dependencies.stopSandbox).mockRejectedValue(new Error('private stop error'));
    expect(await cancelFleetJob(second, job.id, dependencies)).toMatchObject({ status: 'quarantined', error: 'cancel_uncertain' });
    await submit('synthetic:next');
    expect(await first.claim({ maxConcurrency: 2, leaseMs: 10_000 })).toBeNull();
    await first.setPaused(true);
    vi.mocked(dependencies.stopSandbox).mockResolvedValue(true);
    expect(await tick()).toEqual({ status: 'idle' });
    expect(dependencies.stopSandbox).toHaveBeenCalledTimes(2);
    expect(await first.get(job.id)).toMatchObject({ status: 'cancelled', sandboxId: job.sandboxId });
  });

  it('bounds an unresponsive cancellation stop and keeps the uncertain slot', async () => {
    const job = await running();
    vi.mocked(dependencies.stopSandbox).mockImplementation(async () => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = cancelFleetJob(second, job.id, dependencies);
    await vi.waitFor(() => expect(dependencies.stopSandbox).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await pending).toMatchObject({ status: 'quarantined', error: 'cancel_uncertain' });
  });

  it('reconciles old cancellation requests even after over 100 newer queued jobs are added', async () => {
    const job = await running();
    await second.requestCancel(job.id);
    now += 1;
    for (let i = 0; i < 101; i++) await submit(`synthetic:new:${i}`);
    expect((await first.list(100)).some((entry) => entry.id === job.id)).toBe(false);
    await first.setPaused(true);
    expect(await tick()).toEqual({ status: 'idle' });
    expect(await first.get(job.id)).toMatchObject({ status: 'cancelled' });
  });

  it('reserves the daily cap atomically across supervisors and never starts excess paid work', async () => {
    bindings.push(registration('SYNTHETIC_B'));
    const a = await submit('cap:a', bindings[0]);
    const b = await submit('cap:b', bindings[1]);
    const results = await Promise.all([tick(first, 0.05), tick(second, 0.05)]);
    expect(results.map((result) => result.status).sort()).toEqual(['failed', 'succeeded']);
    expect(dependencies.runWorker).toHaveBeenCalledOnce();
    const jobs = [await first.get(a.id), await first.get(b.id)];
    expect(jobs.filter((job) => job?.dispatchStartedAt !== null)).toHaveLength(1);
  });

  it('does not refund the daily reservation after cancellation of a dispatched job', async () => {
    bindings.push(registration('SYNTHETIC_B'));
    const firstJob = await submit('cap:cancel', bindings[0]);
    vi.mocked(dependencies.runWorker!).mockImplementationOnce(async (input, adapter) => {
      const outcome = await runClaudeReadOnlyWorker(input, adapter);
      await second.requestCancel(firstJob.id);
      return outcome;
    });
    expect(await tick(first, 0.05)).toMatchObject({ status: 'cancelled' });
    const next = await submit('cap:next', bindings[1]);
    expect(await tick(first, 0.05)).toMatchObject({ status: 'failed', reason: 'dispatch_not_permitted' });
    expect(await first.get(next.id)).toMatchObject({ dispatchStartedAt: null });
    expect(dependencies.runWorker).toHaveBeenCalledOnce();
  });

  it('continues only the saved successful session on the exact execution credential and worktree', async () => {
    const parent = await submit();
    await tick();
    const next = await submit('synthetic:continue', bindings[0], parent.id);
    expect(await tick()).toEqual({ status: 'succeeded', jobId: next.id });
    const input = vi.mocked(dependencies.runWorker!).mock.calls[1][0];
    expect(input.previousSession).toMatchObject({ confirmed: true, alias: bindings[0].alias, expectedOrganizationId: ORG, workspaceId: WORKSPACE, credentialBindingId: bindings[0].credentialBindingId, sessionId: SESSION, snapshotId: `snap_${parent.id}` });
    expect(input.previousSession).not.toHaveProperty('prompt');
    expect(input.preflightCredentialBindingId).toBe(bindings[0].credentialBindingId);
  });

  it.each([{ revision: 'b'.repeat(40) }, { workspaceId: OTHER_WORKSPACE }, { workspaceId: undefined }])('revalidates parent association if persisted parent data changed after submission: %j', async (change) => {
    const parent = await submit();
    await tick();
    const next = await submit('synthetic:continue', bindings[0], parent.id);
    const parentJob = (await first.get(parent.id))!;
    await clients[1].execute({ sql: 'UPDATE claude_fleet_jobs SET payload_json = ? WHERE id = ?', args: [JSON.stringify({ ...parentJob.payload, ...change }), parent.id] });
    expect(await tick()).toMatchObject({ status: 'blocked', reason: 'invalid_continuation' });
    expect(await first.get(next.id)).toMatchObject({ status: 'failed', dispatchStartedAt: null });
    expect(dependencies.runWorker).toHaveBeenCalledOnce();
  });

  it('rejects forged worker success from a different workspace before storing session evidence', async () => {
    const job = await submit();
    vi.mocked(dependencies.runWorker!).mockImplementation(async (input, adapter) => {
      const outcome = await runClaudeReadOnlyWorker(input, adapter);
      if (outcome.status !== 'succeeded') throw new Error('synthetic setup unexpectedly failed');
      return { ...outcome, session: { ...outcome.session, workspaceId: OTHER_WORKSPACE } };
    });
    expect(await tick()).toEqual({ status: 'quarantined', jobId: job.id });
    expect(await first.get(job.id)).toMatchObject({ status: 'quarantined', result: null, sessionId: null });
  });

  it('rejects forged worker result text instead of storing or returning private model content', async () => {
    const job = await submit();
    vi.mocked(dependencies.runWorker!).mockImplementation(async (input, adapter) => {
      const outcome = await runClaudeReadOnlyWorker(input, adapter);
      return { ...outcome, result: 'private content sk-ant-synthetic-secret' } as ClaudeWorkerOutcome;
    });
    expect(await tick()).toEqual({ status: 'quarantined', jobId: job.id });
    expect(await first.get(job.id)).toMatchObject({ status: 'quarantined', result: null, sessionId: null });
    expect(JSON.stringify(await first.get(job.id))).not.toContain('sk-ant-synthetic-secret');
  });
});
