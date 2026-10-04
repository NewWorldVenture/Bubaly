import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Sandbox } from '@vercel/sandbox';
import {
  createVercelClaudeWorkerAdapter,
  stopVercelSandboxById,
  type ClaudeFleetSandboxSdk,
  type ClaudeFleetSdkSandbox,
  type ClaudeFleetSdkSession,
} from '@/lib/claude-fleet/sandbox-adapter';
import { claudeWorkerPaths, type ClaudeWorkerCommand, type ConfirmedClaudeWorkerSession } from '@/lib/claude-fleet/worker';

const KEY = 'sk-ant-synthetic-execution-key';
const ORG = '12345678-1234-1234-1234-123456789abc';
const WORKSPACE = 'wrkspc_SyntheticA';
const BASE = 'snap_synthetic_base';
const BINDING = {
  alias: 'SyntheticAccount', expectedOrganizationId: ORG, workspaceId: WORKSPACE, branch: 'synthetic/task',
  revision: 'a'.repeat(40), credentialBindingId: createHash('sha256').update(KEY).digest('hex'),
};
const PATHS = claudeWorkerPaths(BINDING.alias);
const INPUT = { jobId: 'synthetic-job', binding: BINDING, paths: PATHS };
const SIGNAL = new AbortController().signal;
const DENIED_SUBNETS = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'];

/** Real SDK getters reconstruct injected headers from names with redacted values. */
function observedBrokerPolicy(
  overrides: Partial<Extract<NonNullable<ConstructorParameters<typeof Sandbox>[0]['sandbox']['networkPolicy']>, { mode: 'custom' }>> = {},
) {
  const networkPolicy = {
    mode: 'custom' as const, allowedDomains: ['api.anthropic.com'], allowedCIDRs: [], deniedCIDRs: DENIED_SUBNETS,
    injectionRules: [{ domain: 'api.anthropic.com', headerNames: ['Host', 'x-api-key', 'anthropic-workspace-id'] }],
    ...overrides,
  };
  // Construction/getters are local; no client or live SDK operation is supplied.
  const sdkSandbox = new Sandbox({
    routes: [],
    sandbox: {
      name: 'fleet-synthetic', persistent: false, currentSessionId: 'session-synthetic',
      status: 'running', createdAt: 0, updatedAt: 0, networkPolicy,
    },
    session: {
      id: 'session-synthetic', memory: 2048, vcpus: 1, region: 'iad1', timeout: 30_000,
      status: 'running', requestedAt: 0, createdAt: 0, updatedAt: 0, cwd: '/vercel/sandbox', networkPolicy,
    },
  });
  expect(sdkSandbox.currentSession().networkPolicy).toEqual(sdkSandbox.networkPolicy);
  return sdkSandbox.networkPolicy;
}
const COMMAND: ClaudeWorkerCommand = {
  cmd: 'claude', args: ['auth', 'status'], cwd: PATHS.worktreePath,
  env: { CLAUDE_CONFIG_DIR: PATHS.configDirectory }, timeoutMs: 1_000, maxOutputBytes: 65_536,
};

function commandResult(stdout = '', stderr = '', exitCode = 0) {
  const close = vi.fn();
  return {
    logs: vi.fn(() => Object.assign((async function* () {
      if (stdout) yield { stream: 'stdout', data: stdout };
      if (stderr) yield { stream: 'stderr', data: stderr };
    })(), { close })),
    wait: vi.fn(async () => ({ exitCode })),
    kill: vi.fn(async () => {}),
    close,
  };
}

function fixture() {
  const events: string[] = [];
  const sandbox = {
    name: 'fleet-synthetic', status: 'running', tags: { fleet: 'bubaly-claude-fleet' },
    networkPolicy: undefined as ClaudeFleetSdkSandbox['networkPolicy'],
    runCommand: vi.fn<ClaudeFleetSdkSession['runCommand']>(async (options) => {
      events.push(`command:${options.args[4]}`);
      if (options.args.includes('rev-parse')) return commandResult(`${BINDING.revision}\n`);
      if (options.args.includes('--version')) return commandResult('2.1.268 (Claude Code)\n');
      return commandResult();
    }),
    mkDir: vi.fn(async () => {}),
    readFile: vi.fn<ClaudeFleetSdkSession['readFile']>(async () => Readable.from([
      JSON.stringify({ binding: BINDING, paths: PATHS, baseSnapshotId: BASE }),
    ])),
    writeFiles: vi.fn(async () => {}),
    update: vi.fn<ClaudeFleetSdkSession['update']>(async ({ networkPolicy }) => {
      sandbox.networkPolicy = networkPolicy; events.push('policy');
    }),
    snapshot: vi.fn(async () => { sandbox.status = 'stopped'; events.push('snapshot'); return { snapshotId: 'snap_synthetic_saved', status: 'created' }; }),
    stop: vi.fn(async () => { sandbox.status = 'stopped'; events.push('stop'); return { session: { status: 'stopped' } }; }),
    currentSession: () => sandbox,
  };
  const sdk = {
    create: vi.fn<ClaudeFleetSandboxSdk['create']>(async () => {
      sandbox.networkPolicy = observedBrokerPolicy(); events.push('create'); return sandbox;
    }),
    get: vi.fn<ClaudeFleetSandboxSdk['get']>(async () => sandbox),
  };
  const onSandboxCreated = vi.fn(async () => { events.push('fenced'); return true; });
  const isClaimActive = vi.fn(async () => true);
  const options = { apiKey: KEY, verifiedOrganizationId: ORG, workspaceId: WORKSPACE, baseSnapshotId: BASE, onSandboxCreated, isClaimActive, sdk };
  return { events, sandbox, sdk, options, onSandboxCreated, isClaimActive };
}

function previousSession(): ConfirmedClaudeWorkerSession {
  return {
    ...BINDING, ...PATHS, confirmed: true,
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sandboxId: 'fleet-previous', snapshotId: 'snap_synthetic_previous',
  };
}

describe('Vercel Claude worker Sandbox adapter', () => {
  it('accepts the actual SDK redacted broker observation without exposing request-side credentials', async () => {
    const f = fixture();
    const opened = await createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL);
    expect(f.sandbox.networkPolicy).toMatchObject({
      allow: { 'api.anthropic.com': [{ transform: [{ headers: { Host: '<redacted>', 'x-api-key': '<redacted>', 'anthropic-workspace-id': '<redacted>' } }] }] },
    });
    expect(JSON.stringify(f.sandbox.networkPolicy)).not.toContain(KEY);
    expect(opened.executionAuth.credentialBindingId).toBe(BINDING.credentialBindingId);
  });

  it('accepts equivalent DNS/header case, header/subnet order and omitted empty allowed CIDRs', async () => {
    const f = fixture();
    f.sdk.create.mockImplementation(async () => {
      f.sandbox.networkPolicy = observedBrokerPolicy({
        allowedDomains: ['API.ANTHROPIC.COM'], allowedCIDRs: undefined, deniedCIDRs: [...DENIED_SUBNETS].reverse(),
        injectionRules: [{ domain: 'API.ANTHROPIC.COM', headerNames: ['ANTHROPIC-WORKSPACE-ID', 'X-API-KEY', 'host'] }],
      });
      return f.sandbox;
    });
    await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL)).resolves.toMatchObject({ sandboxId: 'fleet-synthetic' });
  });

  it('rejects missing or widened broker metadata before any command', async () => {
    const altered: Array<[string, ClaudeFleetSdkSandbox['networkPolicy']]> = [
      ['missing', undefined],
      ['allow all', 'allow-all'],
      ['extra domain', observedBrokerPolicy({ allowedDomains: ['api.anthropic.com', 'example.com'] })],
      ['missing workspace header', observedBrokerPolicy({ injectionRules: [{ domain: 'api.anthropic.com', headerNames: ['Host', 'x-api-key'] }] })],
      ['extra header', observedBrokerPolicy({ injectionRules: [{ domain: 'api.anthropic.com', headerNames: ['Host', 'x-api-key', 'anthropic-workspace-id', 'authorization'] }] })],
      ['duplicate header case', observedBrokerPolicy({ injectionRules: [{ domain: 'api.anthropic.com', headerNames: ['Host', 'host', 'x-api-key', 'anthropic-workspace-id'] }] })],
      ['conditional injection', observedBrokerPolicy({ injectionRules: [{ domain: 'api.anthropic.com', headerNames: ['Host', 'x-api-key', 'anthropic-workspace-id'], match: { method: ['GET'] } }] })],
      ['forwarding', observedBrokerPolicy({ forwardRules: [{ domain: 'api.anthropic.com', forwardURL: 'https://example.com' }] })],
      ['extra injection rule', observedBrokerPolicy({ injectionRules: [
        { domain: 'api.anthropic.com', headerNames: ['Host', 'x-api-key', 'anthropic-workspace-id'] },
        { domain: 'api.anthropic.com', headerNames: ['x-api-key'] },
      ] })],
      ['allowed subnet', observedBrokerPolicy({ allowedCIDRs: ['0.0.0.0/0'] })],
      ['missing denied subnet', observedBrokerPolicy({ deniedCIDRs: DENIED_SUBNETS.slice(1) })],
      ['duplicate denied subnet', observedBrokerPolicy({ deniedCIDRs: [...DENIED_SUBNETS.slice(1), DENIED_SUBNETS[1]] })],
      ['unredacted values', {
        allow: { 'api.anthropic.com': [{ transform: [{ headers: { Host: 'api.anthropic.com', 'x-api-key': KEY, 'anthropic-workspace-id': WORKSPACE } }] }] },
        subnets: { allow: [], deny: DENIED_SUBNETS },
      }],
    ];
    for (const [description, policy] of altered) {
      const f = fixture();
      f.sdk.create.mockImplementation(async () => { f.sandbox.networkPolicy = policy; return f.sandbox; });
      await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL), description).rejects.toThrow('sandbox_open_failed');
      expect(f.sandbox.runCommand, description).not.toHaveBeenCalled();
      expect(f.sandbox.stop, description).toHaveBeenCalledOnce();
    }
  });

  it.each(['sandbox', 'session'])('independently rejects a downgraded %s policy despite a correct companion observation', async (target) => {
    const f = fixture();
    f.sdk.create.mockImplementation(async () => {
      f.sandbox.networkPolicy = target === 'session' ? 'allow-all' : observedBrokerPolicy();
      return {
        name: f.sandbox.name, tags: f.sandbox.tags,
        networkPolicy: target === 'sandbox' ? 'allow-all' : observedBrokerPolicy(),
        currentSession: () => f.sandbox,
      };
    });
    await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL)).rejects.toThrow('sandbox_open_failed');
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledOnce();
  });
  it('creates only from the reviewed snapshot, scopes egress, and fences before every command', async () => {
    const f = fixture();
    const opened = await createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL);
    const options = f.sdk.create.mock.calls[0][0];
    expect(options).toMatchObject({ source: { type: 'snapshot', snapshotId: BASE }, persistent: false, ports: [] });
    expect(options.networkPolicy).toEqual({
      allow: { 'api.anthropic.com': [{ transform: [{ headers: { Host: 'api.anthropic.com', 'x-api-key': KEY, 'anthropic-workspace-id': WORKSPACE } }] }] },
      subnets: { allow: [], deny: expect.arrayContaining(['127.0.0.0/8', '10.0.0.0/8', '169.254.0.0/16', '::1/128']) },
    });
    expect(f.events.slice(0, 2)).toEqual(['create', 'fenced']);
    expect(f.onSandboxCreated).toHaveBeenCalledWith('fleet-synthetic');
    expect(opened.executionAuth).toEqual({ kind: 'api_key', organizationId: ORG, workspaceId: WORKSPACE, credentialBindingId: BINDING.credentialBindingId });
    expect(JSON.stringify(opened)).not.toContain(KEY);
    expect(JSON.stringify(f.sandbox.writeFiles.mock.calls)).not.toContain(KEY);
    expect(f.sandbox.runCommand.mock.calls[0][0]).toMatchObject({
      cmd: 'timeout', detached: true, timeoutMs: 5_000,
      args: ['--signal=KILL', '--kill-after=1s', '--', '5s', 'git', '-C', '/vercel/sandbox/repository', '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--', PATHS.worktreePath, BINDING.revision],
    });
    expect(f.sandbox.runCommand.mock.calls.some(([command]) => command.args.includes('npm'))).toBe(false);
  });

  it('puts only a non-secret auth marker and proxy CA settings in command environment, with literal argv', async () => {
    const f = fixture();
    const opened = await createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL);
    const args = ['--print', '--', 'A prompt with $(touch /bad), `shell`, and ; delimiters'];
    await opened.runCommand({ ...COMMAND, args }, SIGNAL);
    const command = f.sandbox.runCommand.mock.calls.at(-1)![0];
    expect(command.args).toEqual(['--signal=KILL', '--kill-after=1s', '--', '1s', 'claude', ...args]);
    expect(command.env).toMatchObject({
      CLAUDE_CONFIG_DIR: PATHS.configDirectory, ANTHROPIC_API_KEY: 'vercel-credential-broker',
      CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '',
      NODE_EXTRA_CA_CERTS: '/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem',
      SSL_CERT_FILE: '/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem',
    });
    expect(JSON.stringify(command)).not.toContain(KEY);
  });

  it('fails closed for missing snapshot, key, organization or changed credential before creation', async () => {
    for (const overrides of [{ baseSnapshotId: '' }, { apiKey: '' }, { verifiedOrganizationId: 'bad' }, { apiKey: `${KEY}-other` }]) {
      const f = fixture();
      await expect(createVercelClaudeWorkerAdapter({ ...f.options, ...overrides }).open(INPUT, SIGNAL)).rejects.toThrow('sandbox_configuration_invalid');
      expect(f.sdk.create).not.toHaveBeenCalled();
    }
  });

  it.each(['', 'default', 'wrkspc_bad-id', 'wrkspc_SyntheticB', `${WORKSPACE}\r\nInjected: bad`])('rejects unapproved or malformed workspace before creating a Sandbox (%s)', async (workspaceId) => {
    const f = fixture();
    await expect(createVercelClaudeWorkerAdapter({ ...f.options, workspaceId }).open(INPUT, SIGNAL)).rejects.toThrow('sandbox_configuration_invalid');
    expect(f.sdk.create).not.toHaveBeenCalled();
    await expect(createVercelClaudeWorkerAdapter(f.options).open({ ...INPUT, binding: { ...BINDING, workspaceId } }, SIGNAL)).rejects.toThrow('sandbox_configuration_invalid');
    expect(f.sdk.create).not.toHaveBeenCalled();
  });

  it('stops a created sandbox after a lost claim before commands or setup', async () => {
    const f = fixture();
    f.onSandboxCreated.mockResolvedValue(false);
    await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL)).rejects.toThrow('sandbox_open_failed');
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
    expect(f.sandbox.mkDir).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('refuses creation without a live claim and stops if cancellation arrives after registration', async () => {
    const f = fixture();
    f.isClaimActive.mockResolvedValue(false);
    await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL)).rejects.toThrow('lost_claim');
    expect(f.sdk.create).not.toHaveBeenCalled();
    f.isClaimActive.mockResolvedValue(true);
    f.onSandboxCreated.mockImplementation(async () => { f.isClaimActive.mockResolvedValue(false); return true; });
    await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL)).rejects.toThrow();
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('refuses a second command and snapshot after cancellation, while still allowing cleanup', async () => {
    const f = fixture();
    const opened = await createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL);
    await opened.runCommand(COMMAND, SIGNAL);
    const calls = f.sandbox.runCommand.mock.calls.length;
    f.isClaimActive.mockResolvedValue(false);
    await expect(opened.runCommand(COMMAND, SIGNAL)).rejects.toThrow('lost_claim');
    await expect(opened.snapshot(SIGNAL)).rejects.toThrow('lost_claim');
    expect(f.sandbox.runCommand).toHaveBeenCalledTimes(calls);
    expect(f.sandbox.snapshot).not.toHaveBeenCalled();
    await opened.stop(SIGNAL);
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('uses the captured VM Session rather than Sandbox methods that implicitly resume stopped VMs', async () => {
    const f = fixture();
    const resumableRun = vi.fn(async () => { throw new Error('facade_would_resume'); });
    const currentSession = vi.fn(() => f.sandbox);
    f.sdk.create.mockImplementation(async () => {
      f.sandbox.networkPolicy = observedBrokerPolicy();
      return {
        name: f.sandbox.name, tags: f.sandbox.tags, networkPolicy: observedBrokerPolicy(),
        currentSession,
        runCommand: resumableRun,
      };
    });
    const opened = await createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL);
    await opened.runCommand(COMMAND, SIGNAL);
    await opened.stop(SIGNAL);
    await expect(opened.runCommand(COMMAND, SIGNAL)).rejects.toThrow('sandbox_stopped');
    await expect(opened.snapshot(SIGNAL)).rejects.toThrow('sandbox_stopped');
    expect(currentSession).toHaveBeenCalledTimes(1);
    expect(resumableRun).not.toHaveBeenCalled();
  });

  it('stops a late sandbox if creation finishes after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.sdk.create.mockImplementation(async () => {
      f.sandbox.networkPolicy = observedBrokerPolicy();
      controller.abort();
      return f.sandbox;
    });
    await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, controller.signal)).rejects.toThrow();
    expect(f.onSandboxCreated).toHaveBeenCalledTimes(1);
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects a dropped credential broker policy without falling back to an environment key', async () => {
    const f = fixture();
    f.sdk.create.mockImplementation(async () => { f.sandbox.networkPolicy = 'allow-all'; return f.sandbox; });
    await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL)).rejects.toThrow();
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('restores only an exactly associated prior snapshot and rechecks its immutable revision', async () => {
    const f = fixture();
    await createVercelClaudeWorkerAdapter(f.options).open({ ...INPUT, previousSession: previousSession() }, SIGNAL);
    expect(f.sdk.create.mock.calls[0][0].source).toEqual({ type: 'snapshot', snapshotId: 'snap_synthetic_previous' });
    expect(f.sandbox.mkDir).not.toHaveBeenCalled();
    expect(f.sandbox.writeFiles).not.toHaveBeenCalled();
    expect(f.sandbox.runCommand.mock.calls[0][0].args).toContain('rev-parse');
  });

  it('rejects cross-account continuation before creation and mismatched saved snapshot metadata after creation', async () => {
    const f = fixture();
    await expect(createVercelClaudeWorkerAdapter(f.options).open({ ...INPUT, previousSession: { ...previousSession(), alias: 'Other' } }, SIGNAL)).rejects.toThrow();
    expect(f.sdk.create).not.toHaveBeenCalled();
    f.sandbox.readFile.mockResolvedValue(Readable.from(['{"binding":"other"}']));
    await expect(createVercelClaudeWorkerAdapter(f.options).open({ ...INPUT, previousSession: previousSession() }, SIGNAL)).rejects.toThrow();
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('rejects a saved session or snapshot from another workspace while retaining exact binding checks', async () => {
    const f = fixture();
    await expect(createVercelClaudeWorkerAdapter(f.options).open({
      ...INPUT, previousSession: { ...previousSession(), workspaceId: 'wrkspc_SyntheticB' },
    }, SIGNAL)).rejects.toThrow('sandbox_snapshot_association_invalid');
    expect(f.sdk.create).not.toHaveBeenCalled();
    f.sandbox.readFile.mockResolvedValue(Readable.from([JSON.stringify({
      binding: { ...BINDING, workspaceId: 'wrkspc_SyntheticB' }, paths: PATHS, baseSnapshotId: BASE,
    })]));
    await expect(createVercelClaudeWorkerAdapter(f.options).open({ ...INPUT, previousSession: previousSession() }, SIGNAL)).rejects.toThrow('sandbox_open_failed');
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
    expect(f.sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('blocks an unsupported Claude Code version that cannot prove its config directory', async () => {
    const f = fixture();
    const original = f.sandbox.runCommand.getMockImplementation()!;
    f.sandbox.runCommand.mockImplementation(async (options) => options.args.includes('--version') ? commandResult('2.1.267 (Claude Code)') : original(options));
    await expect(createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL)).rejects.toThrow();
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('kills the command and stops the sandbox on a byte-bounded streaming output overflow', async () => {
    const f = fixture();
    const opened = await createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL);
    const result = commandResult('😀'.repeat(20));
    f.sandbox.runCommand.mockResolvedValue(result);
    const output = await opened.runCommand({ ...COMMAND, maxOutputBytes: 10 }, SIGNAL);
    expect(output).toEqual({ exitCode: 137, stdout: '', stderr: '', outputExceeded: true });
    expect(result.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result.wait).not.toHaveBeenCalled();
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('redacts any reflected execution key and strips broker policy before saving a snapshot', async () => {
    const f = fixture();
    const opened = await createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL);
    f.sandbox.runCommand.mockResolvedValue(commandResult(`reflected:${KEY}`, `error:${KEY}`));
    const result = await opened.runCommand(COMMAND, SIGNAL);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.stdout).toBe('reflected:[REDACTED]');
    const snapshot = await opened.snapshot(SIGNAL);
    expect(snapshot).toEqual({ snapshotId: 'snap_synthetic_saved' });
    expect(f.events.slice(-2)).toEqual(['policy', 'snapshot']);
    expect(f.sandbox.networkPolicy).toBe('deny-all');
    await opened.stop(SIGNAL);
    expect(f.sandbox.stop).not.toHaveBeenCalled();
  });

  it('propagates uncertain cleanup instead of returning a successful stop', async () => {
    const f = fixture();
    const opened = await createVercelClaudeWorkerAdapter(f.options).open(INPUT, SIGNAL);
    f.sandbox.stop.mockResolvedValue({ session: { status: 'stopping' } });
    await expect(opened.stop(SIGNAL)).rejects.toThrow('sandbox_cleanup_failed');
  });

  it('cancellation retrieves by immutable sandbox name without resuming and confirms stopped state', async () => {
    const f = fixture();
    expect(await stopVercelSandboxById('fleet-synthetic', { sdk: f.sdk })).toBe(true);
    expect(f.sdk.get).toHaveBeenCalledWith({ name: 'fleet-synthetic', resume: false, signal: undefined });
    expect(f.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('refuses cancellation of a different sandbox or an untagged unrelated workload', async () => {
    const f = fixture();
    expect(await stopVercelSandboxById('../invalid', { sdk: f.sdk })).toBe(false);
    expect(f.sdk.get).not.toHaveBeenCalled();
    expect(await stopVercelSandboxById('fleet-other', { sdk: f.sdk })).toBe(false);
    f.sandbox.tags.fleet = 'other-project';
    expect(await stopVercelSandboxById('fleet-synthetic', { sdk: f.sdk })).toBe(false);
    expect(f.sandbox.stop).not.toHaveBeenCalled();
  });
});
