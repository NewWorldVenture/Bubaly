import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_WORKER_MAX_OUTPUT_BYTES,
  CLAUDE_WORKER_MODEL,
  claudeWorkerPaths,
  claudeWorkerProbeResult,
  runClaudeReadOnlyWorker,
  type ClaudeWorkerAdapter,
  type ClaudeWorkerBinding,
  type ClaudeWorkerCommandResult,
  type ClaudeWorkerSandbox,
  type ConfirmedClaudeWorkerSession,
  type RunClaudeWorkerInput,
} from '@/lib/claude-fleet/worker';

const ORG = '00000000-0000-4000-8000-000000000000';
const OTHER_ORG = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'wrkspc_SyntheticA';
const OTHER_WORKSPACE = 'wrkspc_SyntheticB';
const SESSION = '22222222-2222-4222-8222-222222222222';
const CHECKED = '2026-10-04T20:00:00.000Z';
const BINDING: ClaudeWorkerBinding = {
  alias: 'Synthetic-A', expectedOrganizationId: ORG,
  workspaceId: WORKSPACE,
  branch: 'synthetic/readonly', revision: 'a'.repeat(40), credentialBindingId: 'sha256-synthetic-key-a',
};
const PATHS = claudeWorkerPaths(BINDING.alias);

function fixture() {
  const input: RunClaudeWorkerInput = {
    jobId: 'synthetic-job-1', binding: BINDING,
    preflight: { status: 'organization_verified', organizationId: ORG, workspaceId: WORKSPACE, checkedAt: CHECKED },
    preflightCredentialBindingId: BINDING.credentialBindingId,
    now: () => new Date(CHECKED),
  };
  const auth: ClaudeWorkerCommandResult = {
    exitCode: 0, stderr: '',
    stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', configDirectory: PATHS.configDirectory }),
  };
  const completed: ClaudeWorkerCommandResult = {
    exitCode: 0, stderr: '',
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, num_turns: 1, result: claudeWorkerProbeResult(input.jobId) }),
  };
  const sandbox: ClaudeWorkerSandbox = {
    sandboxId: 'sbx_synthetic_a', binding: BINDING, paths: PATHS,
    executionAuth: { kind: 'api_key', organizationId: ORG, workspaceId: WORKSPACE, credentialBindingId: BINDING.credentialBindingId },
    runCommand: vi.fn().mockResolvedValueOnce(auth).mockResolvedValueOnce(completed),
    snapshot: vi.fn().mockResolvedValue({ snapshotId: 'snap_synthetic_a' }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const adapter: ClaudeWorkerAdapter = { open: vi.fn().mockResolvedValue(sandbox) };
  const previous: ConfirmedClaudeWorkerSession = {
    ...BINDING, ...PATHS, confirmed: true, sessionId: SESSION,
    sandboxId: 'sbx_previous_a', snapshotId: 'snap_previous_a',
  };
  return { input, auth, completed, sandbox, adapter, previous };
}

afterEach(() => { vi.useRealTimers(); });

describe('Claude fleet isolated read-only worker', () => {
  it('binds API organization, config, worktree and saved session after a confirmed probe and stop', async () => {
    const f = fixture();
    const outcome = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(outcome).toMatchObject({
      status: 'succeeded', permissions: 'no_tools', result: claudeWorkerProbeResult(f.input.jobId),
      sandboxId: f.sandbox.sandboxId, stoppedSandboxId: f.sandbox.sandboxId, stopConfirmed: true,
      session: { ...BINDING, ...PATHS, confirmed: true, sessionId: SESSION, snapshotId: 'snap_synthetic_a' },
    });
    expect(f.adapter.open).toHaveBeenCalledWith({ jobId: f.input.jobId, binding: BINDING, paths: PATHS, previousSession: undefined }, expect.any(AbortSignal));
    expect(f.sandbox.runCommand).toHaveBeenCalledTimes(2);
    expect(f.sandbox.snapshot).toHaveBeenCalledOnce();
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it('uses direct argv, removes tools/customizations/MCP, disables subscription auth and applies limits', async () => {
    const f = fixture();
    f.input.maxBudgetUsd = 0.02;
    await runClaudeReadOnlyWorker(f.input, f.adapter);
    const [command] = vi.mocked(f.sandbox.runCommand).mock.calls[1];
    expect(command).toMatchObject({ cmd: 'claude', cwd: PATHS.worktreePath, maxOutputBytes: CLAUDE_WORKER_MAX_OUTPUT_BYTES });
    expect(command.timeoutMs).toBeLessThanOrEqual(20_000);
    expect(command.args).toEqual([
      '--bare', '--print', '--output-format', 'json', '--model', CLAUDE_WORKER_MODEL, '--tools', '',
      '--system-prompt', 'You are a read-only synthetic connection probe. Return only the exact requested nonce.',
      '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', '',
      '--max-turns', '1', '--max-budget-usd', '0.02', '--',
      `Reply with exactly this text, with no tools or other content: ${claudeWorkerProbeResult(f.input.jobId)}`,
    ]);
    expect(command.env).toMatchObject({
      CLAUDE_CONFIG_DIR: PATHS.configDirectory, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128', CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_RETRY_WATCHDOG: '', MAX_THINKING_TOKENS: '0', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    });
    expect(command.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(command.args).not.toContain('--dangerously-skip-permissions');
    expect(command.args).not.toContain('--continue');
  });

  it.each([
    { alias: '../shared' }, { revision: 'main' }, { branch: '../main' }, { credentialBindingId: 'secret with spaces' },
    { workspaceId: 'unbound' }, { workspaceId: undefined as never },
  ])('rejects invalid bindings before creating a sandbox: %j', async (change) => {
    const f = fixture();
    f.input.binding = { ...BINDING, ...change };
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'blocked', reason: 'invalid_request' });
    expect(f.adapter.open).not.toHaveBeenCalled();
  });

  it('canonicalizes structural job payloads before associating snapshots or returning sessions', async () => {
    const f = fixture();
    const bindingWithJobFields = { ...BINDING, prompt: 'synthetic extra', previousJobId: 'other-job', injected: 'private-extra' };
    const result = await runClaudeReadOnlyWorker({ ...f.input, binding: bindingWithJobFields }, f.adapter);
    expect(vi.mocked(f.adapter.open).mock.calls[0][0].binding).toEqual(BINDING);
    expect(result.status).toBe('succeeded');
    expect(JSON.stringify(result)).not.toContain('synthetic extra');
    expect(JSON.stringify(result)).not.toContain('private-extra');
    expect(JSON.stringify(result)).not.toContain('other-job');
  });

  it.each([0, 0.001, 0.051, 1, NaN])('rejects unapproved or fractional-cent budget %s', async (maxBudgetUsd) => {
    const f = fixture();
    expect(await runClaudeReadOnlyWorker({ ...f.input, maxBudgetUsd }, f.adapter)).toMatchObject({ reason: 'invalid_request' });
    expect(f.adapter.open).not.toHaveBeenCalled();
  });

  it.each([0, 20_001, Infinity])('rejects invalid total timeout %s', async (timeoutMs) => {
    const f = fixture();
    expect(await runClaudeReadOnlyWorker({ ...f.input, timeoutMs }, f.adapter)).toMatchObject({ reason: 'invalid_request' });
    expect(f.adapter.open).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'organization_mismatch' as const },
    { organizationId: OTHER_ORG },
    { workspaceId: OTHER_WORKSPACE },
    { workspaceId: undefined },
    { checkedAt: '2026-10-04T19:58:59.999Z' },
    { checkedAt: '2026-10-04T20:00:00.001Z' },
    { checkedAt: 'not a date' },
  ])('requires a fresh exact execution org preflight: %j', async (change) => {
    const f = fixture();
    f.input.preflight = { ...f.input.preflight, ...change };
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'blocked', reason: 'identity_preflight_required' });
    expect(f.adapter.open).not.toHaveBeenCalled();
  });

  it('rejects a preflight made with a different execution credential', async () => {
    const f = fixture();
    f.input.preflightCredentialBindingId = 'sha256-admin-key';
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ reason: 'identity_preflight_required' });
    expect(f.adapter.open).not.toHaveBeenCalled();
  });

  it.each([
    { alias: 'Synthetic-B' }, { expectedOrganizationId: OTHER_ORG }, { branch: 'synthetic/other' },
    { workspaceId: OTHER_WORKSPACE }, { workspaceId: undefined as never },
    { revision: 'b'.repeat(40) }, { credentialBindingId: 'sha256-synthetic-key-b' },
    { worktreePath: '/vercel/claude-fleet/SYNTHETIC_B/worktree' },
    { configDirectory: '/shared/config' }, { confirmed: false as never }, { sessionId: 'latest' },
  ])('blocks cross-binding or unconfirmed continuation: %j', async (change) => {
    const f = fixture();
    f.input.previousSession = { ...f.previous, ...change };
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'blocked', reason: 'continuation_mismatch' });
    expect(f.adapter.open).not.toHaveBeenCalled();
  });

  it('resumes only the exact confirmed session and passes only its snapshot association', async () => {
    const f = fixture();
    f.input.previousSession = f.previous;
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'succeeded' });
    expect(vi.mocked(f.adapter.open).mock.calls[0][0].previousSession).toEqual(f.previous);
    const args = vi.mocked(f.sandbox.runCommand).mock.calls[1][0].args;
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', SESSION]);
  });

  it('quarantines a changed session returned while resuming', async () => {
    const f = fixture();
    f.input.previousSession = f.previous;
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValueOnce(f.auth).mockResolvedValueOnce({ ...f.completed, stdout: f.completed.stdout.replace(SESSION, OTHER_ORG) });
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'quarantined', reason: 'session_mismatch', stopConfirmed: true });
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
  });

  it.each(['org', 'credential', 'worktree', 'workspace'])('quarantines mismatching adapter attestation before invoking Claude: %s', async (kind) => {
    const f = fixture();
    if (kind === 'org') f.sandbox.executionAuth.organizationId = OTHER_ORG;
    if (kind === 'workspace') f.sandbox.executionAuth.workspaceId = OTHER_WORKSPACE;
    if (kind === 'credential') f.sandbox.executionAuth.credentialBindingId = 'different-fingerprint';
    if (kind === 'worktree') f.sandbox.paths = { ...PATHS, worktreePath: '/shared/worktree' };
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'quarantined', reason: 'execution_identity_mismatch', stopConfirmed: true });
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each(['claude.ai', 'oauth_token', 'third_party', 'api_key_helper', 'none'])('rejects unapproved CLI auth method %s without returning account diagnostics', async (authMethod) => {
    const f = fixture();
    const secret = 'sk-ant-synthetic-account-secret';
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValue({ exitCode: 0, stderr: secret, stdout: JSON.stringify({ loggedIn: true, authMethod, email: `${secret}@example.test`, configDirectory: PATHS.configDirectory }) });
    const outcome = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'auth_rejected', stopConfirmed: true });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(f.sandbox.runCommand).toHaveBeenCalledOnce();
  });

  it('rejects a CLI configuration directory shared with another account', async () => {
    const f = fixture();
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValue({ ...f.auth, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', configDirectory: '/home/user/.claude' }) });
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'quarantined', reason: 'execution_identity_mismatch' });
  });

  it.each([
    ['authentication_failed', 'auth_rejected'], ['account_on_hold', 'auth_rejected'],
    ['rate_limit', 'usage_limited'], ['billing_error', 'usage_limited'], ['server_error', 'provider_error'],
  ])('maps provider error %s to fixed %s and discards raw output', async (error, reason) => {
    const f = fixture();
    const secret = 'sk-ant-synthetic-private-key';
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValueOnce(f.auth).mockResolvedValueOnce({ exitCode: 1, stdout: JSON.stringify({ is_error: true, error, result: secret }), stderr: secret });
    const outcome = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(outcome).toMatchObject({ status: 'failed', reason, stopConfirmed: true });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
  });

  it.each(['not JSON sk-ant-private', '{}', '[]', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'wrong nonce', num_turns: 1, session_id: SESSION })])('quarantines invalid success output without persisting it', async (stdout) => {
    const f = fixture();
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValueOnce(f.auth).mockResolvedValueOnce({ ...f.completed, stdout });
    const outcome = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(outcome).toMatchObject({ status: 'quarantined', reason: 'invalid_result' });
    expect(JSON.stringify(outcome)).not.toContain(stdout);
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
  });

  it('quarantines output overflow and retains only bounded evidence', async () => {
    const f = fixture();
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValueOnce(f.auth).mockResolvedValueOnce({ ...f.completed, stderr: 'x'.repeat(CLAUDE_WORKER_MAX_OUTPUT_BYTES) });
    expect(await runClaudeReadOnlyWorker(f.input, f.adapter)).toMatchObject({ status: 'quarantined', reason: 'output_limit' });
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
  });

  it('does not confirm continuation when filesystem snapshot fails', async () => {
    const f = fixture();
    vi.mocked(f.sandbox.snapshot).mockRejectedValue(new Error('private sandbox error sk-ant-secret'));
    const outcome = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(outcome).toMatchObject({ status: 'quarantined', reason: 'snapshot_failed', stopConfirmed: true });
    expect(outcome).not.toHaveProperty('session');
    expect(JSON.stringify(outcome)).not.toContain('sk-ant-secret');
  });

  it('quarantines a process crash and never automatically replays it', async () => {
    const f = fixture();
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValueOnce(f.auth).mockRejectedValueOnce(new Error('crashed sk-ant-secret'));
    const outcome = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(outcome).toMatchObject({ status: 'quarantined', reason: 'worker_crash', stopConfirmed: true });
    expect(f.sandbox.runCommand).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(outcome)).not.toContain('sk-ant-secret');
  });

  it('cannot report a connected session until the sandbox stop is confirmed', async () => {
    const f = fixture();
    vi.mocked(f.sandbox.stop).mockRejectedValue(new Error('stop failed'));
    const outcome = await runClaudeReadOnlyWorker(f.input, f.adapter);
    expect(outcome).toMatchObject({ status: 'quarantined', reason: 'cleanup_failed', sandboxId: f.sandbox.sandboxId, stopConfirmed: false });
    expect(outcome).not.toHaveProperty('session');
    expect(outcome).not.toHaveProperty('stoppedSandboxId');
  });

  it('bounds an unresponsive probe, aborts it and stops the sandbox', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let runSignal: AbortSignal | undefined;
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValueOnce(f.auth).mockImplementationOnce(async (_, signal) => {
      runSignal = signal;
      return new Promise(() => {});
    });
    const pending = runClaudeReadOnlyWorker({ ...f.input, timeoutMs: 100 }, f.adapter);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: 'quarantined', reason: 'timeout', stopConfirmed: true });
    expect(runSignal?.aborted).toBe(true);
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });

  it('uses one deadline across startup, authentication, probe and snapshot', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.adapter.open).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return f.sandbox;
    });
    vi.mocked(f.sandbox.runCommand).mockReset().mockImplementation(async (command) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return command.args[0] === 'auth' ? f.auth : f.completed;
    });
    const pending = runClaudeReadOnlyWorker({ ...f.input, timeoutMs: 100 }, f.adapter);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: 'quarantined', reason: 'timeout', stopConfirmed: true });
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
  });

  it('terminates a sandbox that finishes creation after its deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.adapter.open).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return f.sandbox;
    });
    const pending = runClaudeReadOnlyWorker({ ...f.input, timeoutMs: 100 }, f.adapter);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: 'quarantined', reason: 'timeout', stopConfirmed: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('cancels before startup without allocating a sandbox', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await runClaudeReadOnlyWorker({ ...f.input, signal: controller.signal }, f.adapter)).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    expect(f.adapter.open).not.toHaveBeenCalled();
  });

  it('quarantines cancellation during a dispatched probe and confirms its stop', async () => {
    const f = fixture();
    const controller = new AbortController();
    vi.mocked(f.sandbox.runCommand).mockReset().mockResolvedValueOnce(f.auth).mockImplementationOnce(async () => {
      controller.abort();
      return new Promise(() => {});
    });
    expect(await runClaudeReadOnlyWorker({ ...f.input, signal: controller.signal }, f.adapter)).toMatchObject({ status: 'quarantined', reason: 'cancelled', stopConfirmed: true });
  });
});
