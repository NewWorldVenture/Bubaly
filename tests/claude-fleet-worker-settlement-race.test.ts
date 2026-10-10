import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claudeWorkerPaths, claudeWorkerProbeResult, runClaudeReadOnlyWorker,
  type ClaudeWorkerBinding, type ClaudeWorkerCommandResult,
  type ClaudeWorkerSandbox, type RunClaudeWorkerInput,
} from '@/lib/claude-fleet/worker';

const CHECKED = '2026-10-09T13:00:00.000Z';
const BINDING: ClaudeWorkerBinding = {
  alias: 'Synthetic-A', expectedOrganizationId: '00000000-0000-4000-8000-000000000000',
  workspaceId: 'wrkspc_SyntheticA', branch: 'synthetic/readonly',
  revision: 'a'.repeat(40), credentialBindingId: 'sha256-synthetic-key-a',
};

function fixture() {
  const controller = new AbortController();
  const paths = claudeWorkerPaths(BINDING.alias);
  const input: RunClaudeWorkerInput = {
    jobId: 'synthetic-settlement-job', binding: BINDING, signal: controller.signal,
    preflight: { status: 'organization_verified', organizationId: BINDING.expectedOrganizationId, workspaceId: BINDING.workspaceId, checkedAt: CHECKED },
    preflightCredentialBindingId: BINDING.credentialBindingId, now: () => new Date(CHECKED),
  };
  const auth: ClaudeWorkerCommandResult = {
    exitCode: 0, stderr: '', stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', configDirectory: paths.configDirectory }),
  };
  const completed: ClaudeWorkerCommandResult = {
    exitCode: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: '22222222-2222-4222-8222-222222222222', num_turns: 1, result: claudeWorkerProbeResult(input.jobId) }),
  };
  const sandbox: ClaudeWorkerSandbox = {
    sandboxId: 'sbx_synthetic_settlement', binding: BINDING, paths,
    executionAuth: { kind: 'api_key', organizationId: BINDING.expectedOrganizationId, workspaceId: BINDING.workspaceId, credentialBindingId: BINDING.credentialBindingId },
    runCommand: vi.fn().mockResolvedValueOnce(auth).mockResolvedValueOnce(completed),
    snapshot: vi.fn().mockResolvedValue({ snapshotId: 'snap_synthetic_settlement' }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const adapter = { open: vi.fn().mockResolvedValue(sandbox) };
  return { controller, input, sandbox, adapter, auth, completed };
}
function scheduleAbort(controller: AbortController, depth: number): void {
  queueMicrotask(() => { if (depth > 1) scheduleAbort(controller, depth - 1); else controller.abort(); });
}

afterEach(() => { vi.useRealTimers(); });

describe('Claude worker cancellation at operation settlement', () => {
  it('still accepts a healthy settled probe only after confirmed stop', async () => {
    const f = fixture();
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'succeeded', stopConfirmed: true });
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it('does not publish a confirmed session when a fired deadline settles alongside a snapshot', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let snapshotSignal: AbortSignal | undefined;
    vi.mocked(f.sandbox.snapshot).mockImplementation(async (signal) => {
      snapshotSignal = signal;
      vi.advanceTimersByTime(100);
      return { snapshotId: 'snap_synthetic_settlement' };
    });
    const result = await runClaudeReadOnlyWorker({ ...f.input, timeoutMs: 100 }, f.adapter);
    expect(snapshotSignal?.aborted).toBe(true);
    expect(f.controller.signal.aborted).toBe(false);
    expect(result).toMatchObject({ status: 'quarantined', reason: 'timeout', stopConfirmed: true });
    expect(result).not.toHaveProperty('session');
    expect(f.sandbox.snapshot).toHaveBeenCalledOnce();
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3, 4, 5])('retains cleanup ownership when opening is cancelled at microtask depth %s', async (depth) => {
    const f = fixture();
    vi.mocked(f.adapter.open).mockImplementation(async () => {
      scheduleAbort(f.controller, depth);
      return f.sandbox;
    });
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(f.controller.signal.aborted).toBe(true);
    expect(result.status).not.toBe('succeeded');
    expect(result).toMatchObject({ reason: 'cancelled', sandboxId: f.sandbox.sandboxId, stoppedSandboxId: f.sandbox.sandboxId, stopConfirmed: true });
    expect(result).not.toHaveProperty('session');
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it('keeps one uncertain stop attempt when cancellation rejects an opened resource and stopping fails', async () => {
    const f = fixture();
    vi.mocked(f.adapter.open).mockImplementation(async () => { scheduleAbort(f.controller, 2); return f.sandbox; });
    vi.mocked(f.sandbox.stop).mockRejectedValue(new Error('synthetic stop refusal'));
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(result).toMatchObject({ status: 'quarantined', reason: 'cleanup_failed', sandboxId: f.sandbox.sandboxId, stopConfirmed: false });
    expect(result).not.toHaveProperty('session');
    expect(result).not.toHaveProperty('stoppedSandboxId');
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it('refuses cancellation between inner snapshot settlement and outer acceptance', async () => {
    const f = fixture();
    let abortedAtCleanup = false;
    vi.mocked(f.sandbox.snapshot).mockImplementation(async () => { scheduleAbort(f.controller, 3); return { snapshotId: 'snap_synthetic_settlement' }; });
    vi.mocked(f.sandbox.stop).mockImplementation(async () => { abortedAtCleanup = f.controller.signal.aborted; });
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(abortedAtCleanup).toBe(true);
    expect(result).toMatchObject({ status: 'quarantined', reason: 'cancelled', stopConfirmed: true });
    expect(result).not.toHaveProperty('session');
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it('retains the authentication phase when cancellation precedes outer authentication acceptance', async () => {
    const f = fixture();
    vi.mocked(f.sandbox.runCommand).mockReset().mockImplementation(async () => { scheduleAbort(f.controller, 3); return f.auth; });
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(result).toMatchObject({ status: 'cancelled', reason: 'cancelled', stopConfirmed: true });
    expect(f.sandbox.runCommand).toHaveBeenCalledOnce();
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3])('does not publish a continuation when cancellation occurs during required cleanup at depth %s', async (depth) => {
    const f = fixture();
    vi.mocked(f.sandbox.stop).mockImplementation(async () => { scheduleAbort(f.controller, depth); });
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(f.controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'quarantined', reason: 'cancelled', stoppedSandboxId: f.sandbox.sandboxId, stopConfirmed: true });
    expect(result).not.toHaveProperty('session');
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it('preserves an already completed result when cancellation happens after producer completion', async () => {
    const f = fixture();
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    f.controller.abort();
    expect(result).toMatchObject({ status: 'succeeded', stopConfirmed: true });
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each(['synchronous', 'microtask'] as const)('does not publish a confirmed session when %s cancellation settles alongside a snapshot', async (timing) => {
    const f = fixture();
    vi.mocked(f.sandbox.snapshot).mockImplementation(async () => {
      if (timing === 'synchronous') f.controller.abort();
      else queueMicrotask(() => f.controller.abort());
      return { snapshotId: 'snap_synthetic_settlement' };
    });
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(f.controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'quarantined', reason: 'cancelled', stopConfirmed: true });
    expect(result).not.toHaveProperty('session');
    expect(f.sandbox.snapshot).toHaveBeenCalledOnce();
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each(['synchronous', 'microtask'] as const)('does not dispatch after %s cancellation settles alongside authentication', async (timing) => {
    const f = fixture();
    vi.mocked(f.sandbox.runCommand).mockReset().mockImplementation(async () => {
      if (timing === 'synchronous') f.controller.abort();
      else queueMicrotask(() => f.controller.abort());
      return f.auth;
    });
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(result).toMatchObject({ status: 'cancelled', reason: 'cancelled', stopConfirmed: true });
    expect(result).not.toHaveProperty('session');
    expect(f.sandbox.runCommand).toHaveBeenCalledOnce();
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each(['synchronous', 'microtask'] as const)('retains quarantine and cleanup when %s cancellation settles alongside a dispatched probe', async (timing) => {
    const f = fixture();
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValueOnce(f.auth).mockImplementationOnce(async () => {
      if (timing === 'synchronous') f.controller.abort();
      else queueMicrotask(() => f.controller.abort());
      return f.completed;
    });
    const result = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(result).toMatchObject({ status: 'quarantined', reason: 'cancelled', stopConfirmed: true });
    expect(result).not.toHaveProperty('session');
    expect(f.sandbox.runCommand).toHaveBeenCalledTimes(2);
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });
});
