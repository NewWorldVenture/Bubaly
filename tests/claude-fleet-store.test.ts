import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client, type TransactionMode } from '@libsql/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeFleetStore, type FleetJob, type FleetJobPayload } from '@/lib/claude-fleet/store';

const ORG = '00000000-0000-4000-8000-000000000000';
const payload = (alias = 'SyntheticAccount'): FleetJobPayload => ({
  mode: 'read_only', alias, expectedOrganizationId: ORG, workspaceId: 'wrkspc_synthetic', credentialBindingId: 'synthetic-binding',
  branch: 'codex/synthetic-worker', revision: 'a'.repeat(40), prompt: 'Read-only synthetic worker probe',
  maxBudgetUsd: 0.05, timeoutMs: 20_000,
});
const options = { maxConcurrency: 2, leaseMs: 10_000 };

describe('durable Claude fleet store using separate SQLite clients', () => {
  let directory: string;
  let clients: Client[];
  let first: ClaudeFleetStore;
  let second: ClaudeFleetStore;
  let now: number;

  beforeEach(async () => {
    now = 100_000;
    directory = await mkdtemp(join(tmpdir(), 'bubaly-fleet-test-'));
    const url = pathToFileURL(join(directory, 'synthetic.db')).href;
    clients = [createClient({ url, timeout: 0 }), createClient({ url, timeout: 0 })];
    await clients[0].execute('PRAGMA journal_mode = WAL');
    first = new ClaudeFleetStore(clients[0], { now: () => now });
    second = new ClaudeFleetStore(clients[1], { now: () => now });
    await first.initialize();
    await first.setPaused(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of clients ?? []) {
      client.close();
      expect(client.closed).toBe(true);
    }
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        // libSQL's Windows native statement finalizers can retain a closed DB until process teardown.
        // Keep only our owned synthetic temp directory in that case; SQL/race failures still fail.
        if (process.platform !== 'win32' || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'EBUSY') throw error;
      }
    }
  });

  async function running(store = first, key = 'probe:one', alias = 'SyntheticAccount'): Promise<FleetJob> {
    await store.submit(key, payload(alias));
    const job = (await store.claim(options))!;
    expect(await store.markDispatched(job.id, job.claimToken!)).toBe(true);
    expect(await store.attachSandbox(job.id, job.claimToken!, `sandbox_${job.id}`)).toBe(true);
    return (await store.get(job.id))!;
  }

  async function success(job: FleetJob): Promise<void> {
    expect(await first.complete(job.id, job.claimToken!, {
      sandboxId: job.sandboxId!, stoppedSandboxId: job.sandboxId!, sessionId: 'session_synthetic',
      snapshotId: 'snapshot_synthetic', result: 'Synthetic probe verified',
    })).toBe(true);
  }

  async function advanceClockAfterWriteContention(nextTime: number) {
    const held = await clients[1].transaction('write');
    const acquire = clients[0].transaction.bind(clients[0]);
    return vi.spyOn(clients[0], 'transaction').mockImplementationOnce(async (mode?: TransactionMode) => {
      try {
        // This acquisition hits a real SQLite lock held by the other client.
        return await acquire(mode);
      } catch (error) {
        expect(error).toMatchObject({ code: 'SQLITE_BUSY' });
        throw error;
      } finally {
        now = nextTime;
        await held.rollback();
        held.close();
      }
    });
  }

  it('initialization starts paused and is idempotent without resetting the pause switch', async () => {
    await first.setPaused(true);
    await first.initialize();
    expect(await second.isPaused()).toBe(true);
    await first.submit('paused:one', payload());
    expect(await second.claim(options)).toBeNull();
    await first.setPaused(false);
    await first.initialize();
    expect(await second.isPaused()).toBe(false);
    expect(await second.claim(options)).not.toBeNull();
  });

  it('deduplicates concurrent submits across clients and persists keys after success', async () => {
    const submissions = await Promise.all([first.submit('same-request', payload()), second.submit('same-request', payload('syntheticaccount'))]);
    expect(submissions[0].job.id).toBe(submissions[1].job.id);
    expect(submissions.filter((submission) => !submission.reused)).toHaveLength(1);
    const job = (await first.claim(options))!;
    await first.markDispatched(job.id, job.claimToken!);
    await first.attachSandbox(job.id, job.claimToken!, 'sandbox_synthetic');
    await success((await first.get(job.id))!);
    const again = await second.submit('same-request', payload());
    expect(again).toMatchObject({ reused: true, job: { id: job.id, status: 'succeeded' } });
    expect(await second.list()).toHaveLength(1);
  });

  it('rejects reuse of a request key with different work', async () => {
    await first.submit('same-request', payload());
    await expect(second.submit('same-request', { ...payload(), prompt: 'different' })).rejects.toMatchObject({ code: 'request_key_conflict' });
    await expect(second.submit('same-request', { ...payload(), workspaceId: 'wrkspc_different' })).rejects.toMatchObject({ code: 'request_key_conflict' });
  });

  it('never creates a second active slot for normalized account aliases', async () => {
    await first.submit('alias-one', payload('synthetic-account'));
    await first.submit('alias-two', payload('SYNTHETIC_ACCOUNT'));
    const claims = await Promise.all([first.claim(options), second.claim(options)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await first.list()).map((job) => job.status).sort()).toEqual(['claimed', 'queued']);
  });

  it('enforces global concurrency under concurrent claims for separate aliases', async () => {
    await first.submit('global-one', payload('synthetic-one'));
    await first.submit('global-two', payload('synthetic-two'));
    const claims = await Promise.all([first.claim({ ...options, maxConcurrency: 1 }), second.claim({ ...options, maxConcurrency: 1 })]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await second.claim({ ...options, maxConcurrency: 1 })).toBeNull();
    expect(await second.claim(options)).not.toBeNull();
  });

  it('recovers expired claims before dispatch with a new fence and bounded attempts', async () => {
    await first.submit('expiry-one', payload());
    const old = (await first.claim(options))!;
    now += options.leaseMs;
    const fresh = (await second.claim(options))!;
    expect(fresh.id).toBe(old.id);
    expect(fresh.claimToken).not.toBe(old.claimToken);
    expect(fresh.attempts).toBe(2);
    expect(await first.markDispatched(old.id, old.claimToken!)).toBe(false);
    expect(await first.heartbeat(old.id, old.claimToken!, options.leaseMs)).toBe(false);
    now += options.leaseMs;
    const third = (await first.claim(options))!;
    expect(third.attempts).toBe(3);
    now += options.leaseMs;
    expect(await second.claim(options)).toBeNull();
    expect(await first.get(old.id)).toMatchObject({ status: 'failed', error: 'attempts_exhausted', attempts: 3 });
  });

  it('quarantines dispatch uncertainty and keeps its account and global slot occupied', async () => {
    const job = await running();
    await second.submit('same-alias:next', payload());
    await second.submit('other-alias:next', payload('OtherAccount'));
    now += options.leaseMs;
    expect(await second.claim({ ...options, maxConcurrency: 1 })).toBeNull();
    expect(await first.get(job.id)).toMatchObject({ status: 'quarantined', error: 'execution_uncertain' });
    const other = (await second.claim(options))!;
    expect(other.payload.alias).toBe('OTHERACCOUNT');
    expect(await first.complete(job.id, job.claimToken!, {
      sandboxId: job.sandboxId!, stoppedSandboxId: job.sandboxId!, sessionId: 'session_late', snapshotId: 'snapshot_late', result: 'late',
    })).toBe(false);
    expect(await first.failBeforeDispatch(job.id, job.claimToken!, 'setup_failed')).toBe(false);
  });

  it('preserves cancellation intent when an expired dispatched lease is recovered', async () => {
    const job = await running();
    await second.requestCancel(job.id);
    await second.submit('after-cancel-expiry', payload());
    now += options.leaseMs;
    expect(await first.claim({ ...options, maxConcurrency: 1 })).toBeNull();
    expect(await second.get(job.id)).toMatchObject({ status: 'quarantined', error: 'cancel_uncertain' });
    expect(await second.listActive()).toHaveLength(1);
    expect(await first.confirmCancelled(job.id, job.claimToken!, job.sandboxId!)).toBe(true);
    expect(await second.claim({ ...options, maxConcurrency: 1 })).not.toBeNull();
  });

  it('does not dispatch after a concurrent pre-dispatch cancellation', async () => {
    const submitted = await first.submit('cancel-before', payload());
    const job = (await first.claim(options))!;
    expect(await second.requestCancel(job.id)).toMatchObject({ status: 'cancelled' });
    expect(await first.markDispatched(job.id, job.claimToken!)).toBe(false);
    expect(await first.get(submitted.job.id)).toMatchObject({ status: 'cancelled', claimToken: null });
  });

  it('preserves slots on cancellation until exact Sandbox stop is confirmed', async () => {
    const job = await running();
    await first.submit('cancel-after:next', payload());
    expect(await second.requestCancel(job.id)).toMatchObject({ status: 'cancel_requested' });
    expect(await first.claim(options)).toBeNull();
    expect(await first.confirmCancelled(job.id, job.claimToken!)).toBe(false);
    expect(await first.confirmCancelled(job.id, 'stale-fence', job.sandboxId!)).toBe(false);
    expect(await first.confirmCancelled(job.id, job.claimToken!, 'other-sandbox')).toBe(false);
    expect(await first.confirmCancelled(job.id, job.claimToken!, job.sandboxId!)).toBe(true);
    expect(await second.claim(options)).not.toBeNull();
  });

  it('allows fenced stop reconciliation from quarantine but never blind replay', async () => {
    const job = await running();
    await first.quarantine(job.id, job.claimToken!, 'cancel_uncertain');
    expect(await second.confirmCancelled(job.id, job.claimToken!, job.sandboxId!)).toBe(true);
    expect(await first.get(job.id)).toMatchObject({ status: 'cancelled' });
  });

  it.each([true, false])('records cancellation intent for an already quarantined job with known Sandbox %s', async (knownSandbox) => {
    await first.submit('quarantined-cancel', payload());
    const claim = (await first.claim(options))!;
    await first.markDispatched(claim.id, claim.claimToken!);
    if (knownSandbox) await first.attachSandbox(claim.id, claim.claimToken!, 'sandbox_quarantined');
    await first.quarantine(claim.id, claim.claimToken!, 'execution_uncertain');
    const before = (await first.get(claim.id))!;
    const cancelled = await second.requestCancel(claim.id);
    expect(cancelled).toMatchObject({
      status: 'quarantined', error: 'cancel_uncertain', claimToken: before.claimToken,
      dispatchStartedAt: before.dispatchStartedAt, sandboxId: before.sandboxId,
      leaseExpiresAt: before.leaseExpiresAt, finishedAt: null,
    });
    await first.submit('quarantined-cancel:next', payload());
    expect(await first.claim(options)).toBeNull();
  });

  it('retries only safe pre-dispatch failures and limits attempts', async () => {
    await first.submit('bounded-retry', payload());
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = (await first.claim(options))!;
      expect(job.attempts).toBe(attempt);
      expect(await second.failBeforeDispatch(job.id, job.claimToken!, 'setup_failed')).toBe(true);
    }
    expect(await first.claim(options)).toBeNull();
    expect((await first.list())[0]).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('rejects post-dispatch retry and authentication failures are terminal', async () => {
    const job = await running();
    expect(await first.failBeforeDispatch(job.id, job.claimToken!, 'setup_failed')).toBe(false);
    await first.submit('auth-failure', payload('OtherAccount'));
    const other = (await first.claim(options))!;
    expect(await first.failBeforeDispatch(other.id, other.claimToken!, 'provider_auth_rejected')).toBe(true);
    expect(await first.get(other.id)).toMatchObject({ status: 'failed', error: 'provider_auth_rejected' });
  });

  it('requires exact successful account, repository and saved session for continuation', async () => {
    const job = await running();
    await expect(first.submit('unconfirmed', { ...payload(), previousJobId: job.id })).rejects.toMatchObject({ code: 'invalid_continuation' });
    await success(job);
    for (const difference of [
      { alias: 'OtherAccount' }, { expectedOrganizationId: '11111111-1111-4111-8111-111111111111' },
      { workspaceId: 'wrkspc_other' },
      { credentialBindingId: 'different-key' }, { branch: 'codex/different' }, { revision: 'b'.repeat(40) },
    ]) {
      await expect(second.submit('invalid-continuation', { ...payload(), ...difference, previousJobId: job.id })).rejects.toMatchObject({ code: 'invalid_continuation' });
    }
    const valid = await second.submit('valid-continuation', { ...payload(), previousJobId: job.id });
    expect(valid.job.payload.previousJobId).toBe(job.id);
    await expect(first.submit('fork-session', { ...payload(), previousJobId: job.id })).rejects.toMatchObject({ code: 'continuation_already_submitted' });
  });

  it('rejects forged completion and late results after cancellation', async () => {
    const job = await running();
    await expect(first.complete(job.id, job.claimToken!, {
      sandboxId: job.sandboxId!, stoppedSandboxId: 'forged', sessionId: 'session', snapshotId: 'snapshot', result: 'x',
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await second.requestCancel(job.id);
    expect(await first.complete(job.id, job.claimToken!, {
      sandboxId: job.sandboxId!, stoppedSandboxId: job.sandboxId!, sessionId: 'session', snapshotId: 'snapshot', result: 'x',
    })).toBe(false);
  });

  it('rejects secret-shaped extra fields and requests above fixed probe limits', async () => {
    for (const invalid of [
      { ...payload(), apiKey: 'synthetic-secret' }, { ...payload(), mode: 'edit' }, { ...payload(), maxBudgetUsd: 1 },
      { ...payload(), timeoutMs: 21_000 }, { ...payload(), revision: 'main' }, { ...payload(), branch: '../outside' },
      { ...payload(), workspaceId: undefined }, { ...payload(), workspaceId: 'workspace_invalid' },
    ]) {
      await expect(first.submit('invalid', invalid as FleetJobPayload)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(await first.list()).toEqual([]);
  });

  it('survives reopening clients and retains output and request identity', async () => {
    const job = await running();
    await success(job);
    const reopenedClient = createClient({ url: pathToFileURL(join(directory, 'synthetic.db')).href });
    clients.push(reopenedClient);
    const reopened = new ClaudeFleetStore(reopenedClient);
    expect(await reopened.get(job.id)).toMatchObject({ status: 'succeeded', sessionId: 'session_synthetic', snapshotId: 'snapshot_synthetic', result: 'Synthetic probe verified' });
    expect((await reopened.submit('probe:one', payload())).reused).toBe(true);
  });

  it('atomically reserves a UTC daily cap and retains uncertain/cancelled reservations', async () => {
    await first.submit('budget:one', payload('AccountOne'));
    await second.submit('budget:two', payload('AccountTwo'));
    const one = (await first.claim(options))!;
    const two = (await second.claim(options))!;
    const outcomes = await Promise.all([
      first.markDispatched(one.id, one.claimToken!, { dailyBudgetUsd: 0.05 }),
      second.markDispatched(two.id, two.claimToken!, { dailyBudgetUsd: 0.05 }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = outcomes[0] ? one : two;
    const pending = outcomes[0] ? two : one;
    await first.attachSandbox(winner.id, winner.claimToken!, 'sandbox_budget');
    await first.requestCancel(winner.id);
    await first.confirmCancelled(winner.id, winner.claimToken!, 'sandbox_budget');
    expect(await second.markDispatched(pending.id, pending.claimToken!, { dailyBudgetUsd: 0.05 })).toBe(false);
    now = 86_400_001;
    const fresh = (await second.claim(options))!;
    expect(fresh.id).toBe(pending.id);
    expect(await second.markDispatched(fresh.id, fresh.claimToken!, { dailyBudgetUsd: 0.05 })).toBe(true);
  });

  it('refreshes dispatch admission after write contention instead of admitting an expired lease', async () => {
    await first.submit('dispatch-contention:expiry', payload());
    const claim = (await first.claim(options))!;
    const transaction = await advanceClockAfterWriteContention(claim.leaseExpiresAt!);
    expect(await first.markDispatched(claim.id, claim.claimToken!)).toBe(false);
    expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await first.get(claim.id)).toMatchObject({ status: 'claimed', dispatchStartedAt: null });
    const recovered = (await second.claim(options))!;
    expect(recovered).toMatchObject({ id: claim.id, status: 'claimed', attempts: 2 });
    expect(recovered.claimToken).not.toBe(claim.claimToken);
  });

  it('charges dispatch admission to the current UTC day after write contention', async () => {
    now = Date.parse('2026-10-04T23:59:59.990Z');
    await first.submit('dispatch-contention:midnight-one', payload('AccountOne'));
    await second.submit('dispatch-contention:midnight-two', payload('AccountTwo'));
    const one = (await first.claim(options))!;
    const two = (await second.claim(options))!;
    const nextDay = Date.parse('2026-10-05T00:00:00.010Z');
    const transaction = await advanceClockAfterWriteContention(nextDay);
    expect(await first.markDispatched(one.id, one.claimToken!, { dailyBudgetUsd: 0.05 })).toBe(true);
    expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await first.get(one.id)).toMatchObject({ dispatchStartedAt: nextDay, updatedAt: nextDay });
    expect(await second.markDispatched(two.id, two.claimToken!, { dailyBudgetUsd: 0.05 })).toBe(false);
    expect((await first.list()).filter((job) => job.dispatchStartedAt !== null)).toHaveLength(1);
  });

  it.each(['lease expiry', 'UTC midnight'])('rechecks dispatch admission when %s passes during the budget read', async (boundary) => {
    if (boundary === 'UTC midnight') now = Date.parse('2026-10-04T23:59:59.990Z');
    await first.submit('dispatch-budget-read', payload());
    const claim = (await first.claim(options))!;
    const nextTime = boundary === 'lease expiry' ? claim.leaseExpiresAt! : Date.parse('2026-10-05T00:00:00.010Z');
    const acquire = clients[0].transaction.bind(clients[0]);
    let budgetRead = false;
    vi.spyOn(clients[0], 'transaction').mockImplementationOnce(async (mode?: TransactionMode) => {
      const tx = await acquire(mode);
      const execute = tx.execute.bind(tx);
      tx.execute = async (statement) => {
        const result = await execute(statement);
        const sql = typeof statement === 'string' ? statement : statement.sql;
        if (sql.includes('SUM(CAST(json_extract')) {
          budgetRead = true;
          now = nextTime;
        }
        return result;
      };
      return tx;
    });
    expect(await first.markDispatched(claim.id, claim.claimToken!)).toBe(false);
    expect(budgetRead).toBe(true);
    expect(await first.get(claim.id)).toMatchObject({ status: 'claimed', dispatchStartedAt: null });
    if (boundary === 'UTC midnight') {
      // A fresh attempt reads the new day's budget and records the correct reservation.
      expect(await first.markDispatched(claim.id, claim.claimToken!)).toBe(true);
      expect(await first.get(claim.id)).toMatchObject({ dispatchStartedAt: nextTime, updatedAt: nextTime });
    }
  });

  it('pauses pre-dispatch admission and stop cancels only safe pending work', async () => {
    const runningJob = await running();
    await first.submit('pending-stop', payload('AccountTwo'));
    const claimed = (await first.claim(options))!;
    await first.submit('queued-stop', payload('AccountThree'));
    await first.setPaused(true);
    expect(await first.markDispatched(claimed.id, claimed.claimToken!)).toBe(false);
    expect(await first.cancelQueued()).toBe(2);
    expect(await second.listActive()).toHaveLength(1);
    expect(await second.get(runningJob.id)).toMatchObject({ status: 'running' });
  });

  it('never retries a lost commit response and recovers by the durable request key', async () => {
    const realTransaction = clients[0].transaction.bind(clients[0]);
    const transaction = vi.spyOn(clients[0], 'transaction').mockImplementationOnce(async () => {
      const tx = await realTransaction('write');
      const commit = tx.commit.bind(tx);
      tx.commit = async () => {
        await commit();
        throw Object.assign(new Error('Synthetic response loss'), { code: 'NETWORK_ERROR' });
      };
      return tx;
    });
    await expect(first.submit('lost-response', payload())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockRestore();
    const recovered = await second.submit('lost-response', payload());
    expect(recovered.reused).toBe(true);
    expect(await second.list()).toHaveLength(1);
  });
});
