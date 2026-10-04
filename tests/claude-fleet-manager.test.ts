import { createClient, type Client } from '@libsql/client';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFleetManagerRequest, type FleetManagerDependencies } from '@/lib/claude-fleet/manager';
import { FleetConfigurationError, type FleetWorkerRegistration } from '@/lib/claude-fleet/runtime-config';
import { fleetProbePayload, type FleetSupervisorDependencies } from '@/lib/claude-fleet/service';
import { ClaudeFleetStore, type FleetJob } from '@/lib/claude-fleet/store';
import { claudeWorkerPaths, claudeWorkerProbeResult, type ClaudeWorkerAdapter } from '@/lib/claude-fleet/worker';

const MANAGER_SECRET = 'synthetic-manager-secret';
const CRON_SECRET = 'synthetic-distinct-cron-secret';
const EXECUTION_KEY = 'sk-ant-synthetic-execution-key';
const ORGANIZATION = '00000000-0000-4000-8000-000000000000';
const WORKSPACE = 'wrkspc_SyntheticA';
const SESSION = '11111111-1111-4111-8111-111111111111';
const registration = (alias = 'SYNTHETIC_ONE'): FleetWorkerRegistration => {
  const executionKey = alias === 'SYNTHETIC_TWO' ? `${EXECUTION_KEY}-second` : EXECUTION_KEY;
  return {
    alias, expectedOrganizationId: ORGANIZATION, workspaceId: alias === 'SYNTHETIC_TWO' ? 'wrkspc_SyntheticB' : WORKSPACE,
    branch: `codex/${alias}`, revision: 'a'.repeat(40),
    baseSnapshotId: `snap_${alias}`, executionKey,
    credentialBindingId: createHash('sha256').update(executionKey).digest('hex'),
  };
};

function request(body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  return new Request('https://manager.invalid/api/claude-fleet', {
    method, headers: { authorization: `Bearer ${MANAGER_SECRET}`, 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

describe('privileged fleet manager controls with real synthetic SQLite', () => {
  let client: Client;
  let directory: string;
  let store: ClaudeFleetStore;
  let dependencies: FleetManagerDependencies;
  let close: ReturnType<typeof vi.fn<() => void>>;
  let openStore: ReturnType<typeof vi.fn<NonNullable<FleetManagerDependencies['openStore']>>>;
  let registrations: ReturnType<typeof vi.fn<() => FleetWorkerRegistration[]>>;
  let supervisor: FleetSupervisorDependencies;

  beforeEach(async () => {
    vi.stubEnv('CLAUDE_FLEET_MANAGER_SECRET', MANAGER_SECRET);
    vi.stubEnv('CRON_SECRET', CRON_SECRET);
    vi.stubEnv('CLAUDE_FLEET_WORKERS_ENABLED', 'true');
    vi.stubEnv('CLAUDE_FLEET_PAID_PROBES_APPROVED', 'true');
    vi.stubEnv('CLAUDE_FLEET_MAX_CONCURRENCY', '2');
    vi.stubEnv('CLAUDE_FLEET_DAILY_BUDGET_USD', '0.25');
    // Transactions use separate native connections; a real file preserves the
    // schema across them whereas an anonymous in-memory database does not.
    directory = await mkdtemp(join(tmpdir(), 'bubaly-fleet-manager-test-'));
    client = createClient({ url: pathToFileURL(join(directory, 'synthetic.db')).href, timeout: 0 });
    await client.execute('PRAGMA journal_mode = WAL');
    store = new ClaudeFleetStore(client);
    await store.initialize();
    await store.setPaused(false);
    close = vi.fn();
    openStore = vi.fn(() => ({ store, close }));
    registrations = vi.fn(() => [registration(), registration('SYNTHETIC_TWO')]);
    supervisor = {
      verifyIdentity: vi.fn<NonNullable<FleetSupervisorDependencies['verifyIdentity']>>(async (options) => ({ status: 'organization_verified', organizationId: ORGANIZATION, workspaceId: options.workspaceId, checkedAt: new Date().toISOString() })),
      stopSandbox: vi.fn(async () => true),
      adapterFactory: vi.fn((account, onCreated, isActive): ClaudeWorkerAdapter => ({
        async open(input) {
          const sandboxId = `sandbox_${input.jobId}`;
          if (!await isActive() || !await onCreated(sandboxId)) throw new Error('lost_claim');
          return {
            sandboxId, binding: input.binding, paths: input.paths,
            executionAuth: { kind: 'api_key', organizationId: account.expectedOrganizationId, workspaceId: account.workspaceId, credentialBindingId: account.credentialBindingId },
            runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            snapshot: vi.fn(async () => ({ snapshotId: `snap_${input.jobId}` })),
            stop: vi.fn(async () => {}),
          };
        },
      })),
      runWorker: vi.fn<NonNullable<FleetSupervisorDependencies['runWorker']>>(async (input, adapter) => {
        const paths = claudeWorkerPaths(input.binding.alias);
        const sandbox = await adapter.open({ jobId: input.jobId, binding: input.binding, paths, previousSession: input.previousSession }, new AbortController().signal);
        return {
          status: 'succeeded', result: claudeWorkerProbeResult(input.jobId), permissions: 'no_tools', checkedAt: new Date().toISOString(),
          sandboxId: sandbox.sandboxId, stoppedSandboxId: sandbox.sandboxId, stopConfirmed: true,
          session: { ...input.binding, ...paths, confirmed: true, sessionId: SESSION, sandboxId: sandbox.sandboxId, snapshotId: `snap_${input.jobId}` },
        };
      }),
    };
    dependencies = { openStore, registrations, supervisor };
  });

  afterEach(async () => {
    client?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
    if (directory) {
      const target = resolve(directory);
      expect(target.startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
      expect(basename(target).startsWith('bubaly-fleet-manager-test-')).toBe(true);
      try { await rm(target, { recursive: true, force: true }); }
      catch (error) {
        // Windows native finalizers can hold a closed synthetic DB until exit.
        if (process.platform !== 'win32' || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'EBUSY') throw error;
      }
    }
  });

  async function call(body: unknown, headers: Record<string, string> = {}) {
    const response = await handleFleetManagerRequest(request(body, headers), dependencies);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return { status: response.status, body: await response.json() };
  }

  async function queued(key = 'synthetic:one', alias = 'SYNTHETIC_ONE') {
    return (await store.submit(key, fleetProbePayload(registration(alias)))).job;
  }

  async function running(key = 'synthetic:one', alias = 'SYNTHETIC_ONE'): Promise<FleetJob> {
    const pending = await queued(key, alias);
    const job = (await store.claim({ maxConcurrency: 2, leaseMs: 90_000 }))!;
    expect(job.id).toBe(pending.id);
    expect(await store.markDispatched(job.id, job.claimToken!)).toBe(true);
    expect(await store.attachSandbox(job.id, job.claimToken!, `sandbox_${job.id}`)).toBe(true);
    return (await store.get(job.id))!;
  }

  async function succeed(job: FleetJob, result = claudeWorkerProbeResult(job.id)) {
    expect(await store.complete(job.id, job.claimToken!, {
      sandboxId: job.sandboxId!, stoppedSandboxId: job.sandboxId!, sessionId: SESSION,
      snapshotId: `snap_${job.id}`, result,
    })).toBe(true);
  }

  it.each([undefined, '', `Bearer ${CRON_SECRET}`, 'Bearer wrong', `bearer ${MANAGER_SECRET}`])('authorizes before reading the body or opening the database (%s)', async (authorization) => {
    const req = request('malformed JSON', authorization === undefined ? {} : { authorization });
    if (authorization === undefined) req.headers.delete('authorization');
    const getReader = vi.spyOn(req.body!, 'getReader');
    const response = await handleFleetManagerRequest(req, dependencies);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(getReader).not.toHaveBeenCalled();
    expect(openStore).not.toHaveBeenCalled();
    expect(registrations).not.toHaveBeenCalled();
  });

  it('fails closed when the manager secret is unset or reuses the cron secret', async () => {
    vi.stubEnv('CLAUDE_FLEET_MANAGER_SECRET', '');
    expect((await call({ action: 'list' })).status).toBe(401);
    vi.stubEnv('CLAUDE_FLEET_MANAGER_SECRET', CRON_SECRET);
    expect((await call({ action: 'stop' }, { authorization: `Bearer ${CRON_SECRET}` })).status).toBe(401);
    expect(openStore).not.toHaveBeenCalled();
  });

  it('requires POST and the exact JSON media type', async () => {
    expect((await handleFleetManagerRequest(request({}, {}, 'GET'), dependencies)).status).toBe(405);
    expect((await call({ action: 'pause' }, { 'content-type': 'application/jsonish' })).status).toBe(415);
    expect(openStore).not.toHaveBeenCalled();
    expect((await call({ action: 'list' }, { 'content-type': 'Application/JSON; charset=utf-8' })).status).toBe(200);
  });

  it('rejects declared oversize before body reading and cancels a streamed request at 8KB', async () => {
    const declared = request({ action: 'stop' }, { 'content-length': '8193' });
    const getReader = vi.spyOn(declared.body!, 'getReader');
    expect((await handleFleetManagerRequest(declared, dependencies)).status).toBe(413);
    expect(getReader).not.toHaveBeenCalled();
    const cancelled = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(4097)); },
      cancel: cancelled,
    });
    const streamed = new Request('https://manager.invalid/api/claude-fleet', {
      method: 'POST', headers: { authorization: `Bearer ${MANAGER_SECRET}`, 'content-type': 'application/json' },
      body: stream, duplex: 'half',
    } as RequestInit);
    expect((await handleFleetManagerRequest(streamed, dependencies)).status).toBe(413);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(pulls).toBeLessThanOrEqual(3);
    expect(openStore).not.toHaveBeenCalled();
  });

  it('allows exactly 8KB of valid JSON and counts multibyte input by bytes', async () => {
    const json = JSON.stringify({ action: 'list' });
    expect((await call(json + ' '.repeat(8192 - Buffer.byteLength(json)))).status).toBe(200);
    expect((await call({ action: 'submit', alias: 'é'.repeat(4096), requestKey: 'request:one' })).status).toBe(413);
    expect(openStore).toHaveBeenCalledTimes(1);
  });

  it.each(['[]', 'null', '{', '{"action":"constructor"}', '{"action":"toString"}', '{"action":"__proto__"}', '{"action":"list","unexpected":1}'])('rejects malformed shapes and inherited action names before opening storage (%s)', async (body) => {
    expect(await call(body)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(openStore).not.toHaveBeenCalled();
  });

  it.each(['submit', 'continue', 'resume', 'tick'])('requires both execution switches before admitting %s', async (action) => {
    const body = { action, ...(['submit', 'continue'].includes(action) ? { alias: 'synthetic-one', requestKey: 'request:one' } : {}), ...(action === 'continue' ? { previousJobId: 'previous' } : {}) };
    vi.stubEnv('CLAUDE_FLEET_WORKERS_ENABLED', 'false');
    expect(await call(body)).toEqual({ status: 503, body: { error: 'worker_execution_disabled' } });
    vi.stubEnv('CLAUDE_FLEET_WORKERS_ENABLED', 'true');
    vi.stubEnv('CLAUDE_FLEET_PAID_PROBES_APPROVED', 'false');
    expect((await call(body)).status).toBe(503);
    expect(openStore).not.toHaveBeenCalled();
    expect(supervisor.runWorker).not.toHaveBeenCalled();
  });

  it.each(['prompt', 'revision', 'branch', 'executionKey', 'expectedOrganizationId', 'workspaceId', 'credentialBindingId', 'timeoutMs', 'maxBudgetUsd'])('rejects caller-controlled job field %s', async (field) => {
    const response = await call({ action: 'submit', alias: 'synthetic-one', requestKey: 'request:one', [field]: 'tampered' });
    expect(response.status).toBe(400);
    expect(openStore).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(0);
  });

  it('binds an admitted job to exact server configuration, preserves idempotency and rejects changed bindings', async () => {
    const admitted = await call({ action: 'submit', alias: 'synthetic-one', requestKey: 'request:one' });
    expect(admitted.status).toBe(202);
    expect(admitted.body.reused).toBe(false);
    const job = (await store.get(admitted.body.job.id))!;
    expect(job.payload).toEqual(fleetProbePayload(registration()));
    const repeated = await call({ action: 'submit', alias: 'Synthetic-One', requestKey: 'request:one' });
    expect(repeated).toMatchObject({ status: 200, body: { reused: true, job: { id: job.id } } });
    registrations.mockReturnValue([{ ...registration(), revision: 'b'.repeat(40) }]);
    expect(await call({ action: 'submit', alias: 'synthetic-one', requestKey: 'request:one' })).toEqual({ status: 409, body: { error: 'request_key_conflict' } });
    expect(await store.list()).toHaveLength(1);
    expect(JSON.stringify([admitted, repeated])).not.toContain(EXECUTION_KEY);
    expect(JSON.stringify([admitted, repeated])).not.toContain('credentialBindingId');
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('rejects unknown accounts and missing/invalid job identifiers', async () => {
    expect((await call({ action: 'submit', alias: 'Unknown', requestKey: 'request:one' })).body).toEqual({ error: 'unknown_account' });
    expect(await call({ action: 'status' })).toEqual({ status: 400, body: { error: 'invalid_job_id' } });
    expect((await call({ action: 'cancel', jobId: '../other' })).status).toBe(400);
    for (const action of ['status', 'result', 'cancel']) {
      expect(await call({ action, jobId: 'missing' })).toEqual({ status: 404, body: { error: 'not_found' } });
    }
  });

  it('does not reuse a request key after its approved server-side workspace changes', async () => {
    const body = { action: 'submit', alias: 'synthetic-one', requestKey: 'request:workspace' };
    const admitted = await call(body);
    expect(admitted.status).toBe(202);
    registrations.mockReturnValue([{ ...registration(), workspaceId: 'wrkspc_SyntheticB' }]);
    expect(await call(body)).toEqual({ status: 409, body: { error: 'request_key_conflict' } });
    const jobs = await store.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.workspaceId).toBe(WORKSPACE);
    expect(supervisor.runWorker).not.toHaveBeenCalled();
  });

  it('lists/statuses/results expose no credentials, request keys, job payload or claim fences', async () => {
    const job = await running();
    const active = await call({ action: 'status', jobId: job.id });
    expect(active.body.job).toMatchObject({ status: 'running', workerConnection: 'unverified', permissions: 'no_tools' });
    expect((await call({ action: 'result', jobId: job.id })).body.result).toBeNull();
    await succeed(job);
    const result = await call({ action: 'result', jobId: job.id });
    expect(result.body).toMatchObject({ result: claudeWorkerProbeResult(job.id), job: { status: 'succeeded', workerConnection: 'probe_verified' } });
    const list = await call({ action: 'list' });
    expect(list.body.jobs).toHaveLength(1);
    for (const response of [active, result, list]) {
      const raw = JSON.stringify(response);
      for (const forbidden of [EXECUTION_KEY, job.claimToken!, job.requestKey, 'credentialBindingId', 'claimToken', 'payload', 'leaseExpiresAt']) {
        expect(raw).not.toContain(forbidden);
      }
    }
  });

  it('does not return contaminated stored provider output as a successful probe result', async () => {
    const job = await running();
    await succeed(job, `provider diagnostic ${EXECUTION_KEY}`);
    const response = await call({ action: 'result', jobId: job.id });
    expect(response.body.result).toBeNull();
    expect(JSON.stringify(response)).not.toContain(EXECUTION_KEY);
  });

  it('pause prevents tick execution and resume validates registration/concurrency/budget before unpausing', async () => {
    await queued();
    expect(await call({ action: 'pause' })).toEqual({ status: 200, body: { paused: true } });
    expect(await call({ action: 'tick' })).toEqual({ status: 200, body: { status: 'idle' } });
    expect(supervisor.verifyIdentity).not.toHaveBeenCalled();
    registrations.mockImplementation(() => { throw new FleetConfigurationError('accounts_unconfigured'); });
    expect((await call({ action: 'resume' })).status).toBe(503);
    expect(await store.isPaused()).toBe(true);
    registrations.mockReturnValue([registration()]);
    vi.stubEnv('CLAUDE_FLEET_MAX_CONCURRENCY', '9');
    expect((await call({ action: 'resume' })).body).toEqual({ error: 'invalid_concurrency' });
    expect(await store.isPaused()).toBe(true);
    vi.stubEnv('CLAUDE_FLEET_MAX_CONCURRENCY', '2');
    vi.stubEnv('CLAUDE_FLEET_DAILY_BUDGET_USD', '10');
    expect((await call({ action: 'resume' })).body).toEqual({ error: 'invalid_daily_budget' });
    expect(await store.isPaused()).toBe(true);
    vi.stubEnv('CLAUDE_FLEET_DAILY_BUDGET_USD', '0.25');
    expect(await call({ action: 'resume' })).toEqual({ status: 200, body: { paused: false } });
    expect(await store.isPaused()).toBe(false);
  });

  it('cancels queued work and confirms exact running Sandbox stops even while execution is disabled', async () => {
    const pending = await queued('pending', 'SYNTHETIC_TWO');
    expect((await call({ action: 'cancel', jobId: pending.id })).body.job.status).toBe('cancelled');
    expect(supervisor.stopSandbox).not.toHaveBeenCalled();
    const job = await running();
    vi.stubEnv('CLAUDE_FLEET_WORKERS_ENABLED', 'false');
    const cancelled = await call({ action: 'cancel', jobId: job.id });
    expect(cancelled.body.job.status).toBe('cancelled');
    expect(supervisor.stopSandbox).toHaveBeenCalledWith(job.sandboxId);
    expect(await store.listActive()).toHaveLength(0);
  });

  it('uncertain cancellation retains the account slot and exposes only its fixed error code', async () => {
    const job = await running();
    vi.mocked(supervisor.stopSandbox).mockRejectedValue(new Error(`remote stop diagnostic ${EXECUTION_KEY}`));
    const cancelled = await call({ action: 'cancel', jobId: job.id });
    expect(cancelled.body.job).toMatchObject({ status: 'quarantined', error: 'cancel_uncertain' });
    expect(JSON.stringify(cancelled)).not.toContain(EXECUTION_KEY);
    await queued('next');
    expect(await store.claim({ maxConcurrency: 2, leaseMs: 90_000 })).toBeNull();
    expect(await store.listActive()).toHaveLength(1);
  });

  it('an explicit cancellation reconciles quarantined work only after the exact Sandbox is confirmed stopped', async () => {
    const job = await running();
    vi.mocked(supervisor.stopSandbox).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await call({ action: 'cancel', jobId: job.id })).body.job.status).toBe('quarantined');
    expect(await store.listActive()).toHaveLength(1);
    expect((await call({ action: 'cancel', jobId: job.id })).body.job.status).toBe('cancelled');
    expect(supervisor.stopSandbox).toHaveBeenNthCalledWith(1, job.sandboxId);
    expect(supervisor.stopSandbox).toHaveBeenNthCalledWith(2, job.sandboxId);
    expect(await store.listActive()).toHaveLength(0);
  });

  it('stop pauses globally, cancels queued jobs and retains unresolved active Sandbox slots', async () => {
    const job = await running();
    const pending = await queued('pending', 'SYNTHETIC_TWO');
    vi.mocked(supervisor.stopSandbox).mockResolvedValue(false);
    vi.stubEnv('CLAUDE_FLEET_PAID_PROBES_APPROVED', 'false');
    const stopped = await call({ action: 'stop' });
    expect(stopped.body).toMatchObject({ paused: true, active: [{ id: job.id, status: 'quarantined', error: 'cancel_uncertain' }] });
    expect((await store.get(pending.id))!.status).toBe('cancelled');
    expect(await store.isPaused()).toBe(true);
    expect(supervisor.stopSandbox).toHaveBeenCalledWith(job.sandboxId);
    expect(JSON.stringify(stopped)).not.toContain(job.claimToken!);
    expect(supervisor.runWorker).not.toHaveBeenCalled();
  });

  it('stops separate active accounts concurrently and waits for every stop confirmation', async () => {
    const first = await running('first');
    const second = await running('second', 'SYNTHETIC_TWO');
    const pending = new Map<string, (stopped: boolean) => void>();
    vi.mocked(supervisor.stopSandbox).mockImplementation(async (id) => new Promise<boolean>((resolveStop) => pending.set(id, resolveStop)));
    const stopping = call({ action: 'stop' });
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get(first.sandboxId!)!(true);
    expect(await store.isPaused()).toBe(true);
    pending.get(second.sandboxId!)!(true);
    expect(await stopping).toEqual({ status: 200, body: { paused: true, active: [] } });
    expect((await store.get(first.id))!.status).toBe('cancelled');
    expect((await store.get(second.id))!.status).toBe('cancelled');
  });

  it('continues only a confirmed same-account/same-binding session once, with idempotent replay', async () => {
    const parent = await running();
    const body = { action: 'continue', alias: 'synthetic-one', requestKey: 'continue:one', previousJobId: parent.id };
    expect((await call(body)).body).toEqual({ error: 'invalid_continuation' });
    await succeed(parent);
    expect((await call({ ...body, alias: 'synthetic-two' })).body).toEqual({ error: 'invalid_continuation' });
    registrations.mockReturnValue([{ ...registration(), credentialBindingId: 'other-binding' }]);
    expect((await call(body)).body).toEqual({ error: 'invalid_continuation' });
    registrations.mockReturnValue([{ ...registration(), workspaceId: 'wrkspc_SyntheticB' }]);
    expect((await call(body)).body).toEqual({ error: 'invalid_continuation' });
    registrations.mockReturnValue([registration()]);
    const admitted = await call(body);
    expect(admitted.status).toBe(202);
    expect((await store.get(admitted.body.job.id))!.payload.previousJobId).toBe(parent.id);
    expect(await call(body)).toMatchObject({ status: 200, body: { reused: true, job: { id: admitted.body.job.id } } });
    expect((await call({ ...body, requestKey: 'continue:two' })).body).toEqual({ error: 'continuation_already_submitted' });
  });

  it('tick dispatches exactly the admitted synthetic binding and returns only outcome identifiers', async () => {
    const admitted = await call({ action: 'submit', alias: 'synthetic-one', requestKey: 'request:one' });
    const tick = await call({ action: 'tick' });
    expect(tick).toEqual({ status: 200, body: { status: 'succeeded', jobId: admitted.body.job.id } });
    expect((await store.get(admitted.body.job.id))!.status).toBe('succeeded');
    expect(supervisor.verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ apiKey: EXECUTION_KEY, expectedOrganizationId: ORGANIZATION, workspaceId: WORKSPACE }));
    expect(JSON.stringify(tick)).not.toContain(EXECUTION_KEY);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('normalizes store/provider/configuration failures and always closes an opened client handle', async () => {
    registrations.mockImplementation(() => { throw new Error(`provider error ${EXECUTION_KEY}`); });
    expect(await call({ action: 'submit', alias: 'synthetic-one', requestKey: 'request:one' })).toEqual({ status: 503, body: { error: 'fleet_operation_failed' } });
    expect(close).toHaveBeenCalledTimes(1);
    registrations.mockImplementation(() => { throw new FleetConfigurationError(EXECUTION_KEY); });
    expect((await call({ action: 'resume' })).body).toEqual({ error: 'fleet_operation_failed' });
    openStore.mockImplementation(() => { throw new Error(`database url/key ${EXECUTION_KEY}`); });
    expect(await call({ action: 'list' })).toEqual({ status: 503, body: { error: 'fleet_operation_failed' } });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each(['invalid_worker_workspace', 'isolated_credential_required'])('returns the safe configuration code %s without unpausing the fleet', async (code) => {
    await store.setPaused(true);
    registrations.mockImplementation(() => { throw new FleetConfigurationError(code); });
    expect(await call({ action: 'resume' })).toEqual({ status: 503, body: { error: code } });
    expect(await store.isPaused()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(supervisor.runWorker).not.toHaveBeenCalled();
  });
});
