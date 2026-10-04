import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { Sandbox, type NetworkPolicy } from '@vercel/sandbox';
import { isOrganizationId, isWorkspaceId } from './anthropic-identity';
import {
  claudeWorkerPaths,
  type ClaudeWorkerAdapter,
  type ClaudeWorkerBinding,
  type ClaudeWorkerCommandResult,
} from './worker';

const REPOSITORY_PATH = '/vercel/sandbox/repository';
const PROXY_CA_PATH = '/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem';
const FLEET_TAG = 'bubaly-claude-fleet';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 65_536;
const ASSOCIATION_LIMIT_BYTES = 2_048;
export const MINIMUM_CLAUDE_CODE_VERSION = '2.1.268';

type CommandLogs = AsyncIterable<{ stream: string; data: unknown }> & { close?: () => void };
type AdapterCommand = {
  logs(options?: { signal?: AbortSignal }): CommandLogs;
  wait(options?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
  kill(signal?: 'SIGKILL'): Promise<void>;
};
type SandboxCreateOptions = NonNullable<Parameters<typeof Sandbox.create>[0]>;
type SandboxGetOptions = Parameters<typeof Sandbox.get>[0];
type SandboxCommandOptions = {
  cmd: string; args: string[]; cwd?: string; env?: Record<string, string>;
  detached: true; signal: AbortSignal; timeoutMs: number;
};
export type ClaudeFleetSdkSession = {
  status: string;
  networkPolicy?: NetworkPolicy;
  runCommand(options: SandboxCommandOptions): Promise<AdapterCommand>;
  mkDir(path: string, options?: { signal?: AbortSignal }): Promise<void>;
  readFile(file: { path: string }, options?: { signal?: AbortSignal }): Promise<NodeJS.ReadableStream | null>;
  writeFiles(files: Array<{ path: string; content: Buffer }>, options?: { signal?: AbortSignal }): Promise<void>;
  update(params: { networkPolicy?: NetworkPolicy }, options?: { signal?: AbortSignal }): Promise<void>;
  snapshot(options?: { signal?: AbortSignal }): Promise<{ snapshotId: string; status?: string }>;
  stop(options?: { signal?: AbortSignal }): Promise<{ session: { status: string } }>;
};
export type ClaudeFleetSdkSandbox = {
  name: string;
  tags?: Record<string, string>;
  networkPolicy?: NetworkPolicy;
  /** Capture one immutable VM session; Sandbox facade methods can auto-resume. */
  currentSession(): ClaudeFleetSdkSession;
};
export type ClaudeFleetSandboxSdk = {
  create(options: SandboxCreateOptions): Promise<ClaudeFleetSdkSandbox>;
  get(options: SandboxGetOptions): Promise<ClaudeFleetSdkSandbox>;
};

type AdapterOptions = {
  /** Transient credential, already checked directly by the server against this org. */
  apiKey: string;
  verifiedOrganizationId: string;
  /** Workspace approved by the server's direct execution-key preflight. */
  workspaceId: string;
  /** Immutable, reviewed snapshot with git, timeout, Claude Code and the repository installed. */
  baseSnapshotId: string;
  /** Persist the identifier under the current claim before any command can run. */
  onSandboxCreated: (sandboxId: string) => Promise<boolean>;
  /** Recheck the queue lease/fence before opening or executing more work. */
  isClaimActive: () => Promise<boolean>;
  sdk?: ClaudeFleetSandboxSdk;
};

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('sandbox_cancelled');
}

function sameBinding(a: ClaudeWorkerBinding, b: ClaudeWorkerBinding): boolean {
  return a.alias === b.alias && a.expectedOrganizationId === b.expectedOrganizationId
    && a.workspaceId === b.workspaceId
    && a.branch === b.branch && a.revision === b.revision && a.credentialBindingId === b.credentialBindingId;
}

function validBinding(binding: ClaudeWorkerBinding): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(binding.alias)
    && isOrganizationId(binding.expectedOrganizationId)
    && isWorkspaceId(binding.workspaceId)
    && /^[a-f0-9]{40}$/.test(binding.revision)
    && /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(binding.branch)
    && !binding.branch.includes('..') && !binding.branch.endsWith('/');
}

function brokerPolicy(apiKey: string, workspaceId: string): NetworkPolicy {
  return {
    allow: {
      'api.anthropic.com': [{ transform: [{ headers: { Host: 'api.anthropic.com', 'x-api-key': apiKey, 'anthropic-workspace-id': workspaceId } }] }],
    },
    // A domain-only allowlist denies unnamed destinations and raw TCP access.
    // Do not deny 0/0: denied subnets override the allowed Anthropic domain too.
    subnets: { allow: [], deny: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'] },
  };
}

async function confirmedStop(session: ClaudeFleetSdkSession, signal?: AbortSignal): Promise<void> {
  if (['stopped', 'failed', 'aborted'].includes(session.status)) return;
  const stopped = await session.stop({ signal });
  if (!['stopped', 'failed', 'aborted'].includes(stopped.session.status)) throw new Error('sandbox_cleanup_failed');
}

/** Identifier is the SDK's immutable sandbox name, not its short-lived VM session ID. */
export async function stopVercelSandboxById(
  sandboxId: string,
  options: { sdk?: ClaudeFleetSandboxSdk; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (!IDENTIFIER.test(sandboxId)) return false;
  try {
    const sandbox = await (options.sdk ?? Sandbox).get({ name: sandboxId, resume: false, signal: options.signal });
    if (sandbox.name !== sandboxId || sandbox.tags?.fleet !== FLEET_TAG) return false;
    await confirmedStop(sandbox.currentSession(), options.signal);
    return true;
  } catch {
    return false;
  }
}

/** Detached log streaming avoids the SDK's unbounded non-detached output cache. */
async function runBounded(
  sandbox: ClaudeFleetSdkSession,
  options: Omit<SandboxCommandOptions, 'detached' | 'signal'>,
  signal: AbortSignal,
  maxBytes: number,
  secret: string,
): Promise<ClaudeWorkerCommandResult> {
  requireActive(signal);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > COMMAND_TIMEOUT_MS
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > OUTPUT_LIMIT_BYTES) throw new Error('sandbox_invalid_command');
  const command = await sandbox.runCommand({
    ...options,
    // Enforce the wall deadline in the VM as well as in the SDK and caller.
    cmd: 'timeout',
    args: ['--signal=KILL', '--kill-after=1s', '--', `${options.timeoutMs / 1000}s`, options.cmd, ...options.args],
    detached: true, signal,
  });
  const logs = command.logs({ signal });
  let stdout = '';
  let stderr = '';
  let bytes = 0;
  let outputExceeded = false;
  try {
    for await (const log of logs) {
      requireActive(signal);
      if (log.stream !== 'stdout' && log.stream !== 'stderr') throw new Error('sandbox_command_stream_error');
      if (typeof log.data !== 'string') throw new Error('sandbox_command_stream_error');
      bytes += Buffer.byteLength(log.data);
      if (bytes > maxBytes) {
        outputExceeded = true;
        await command.kill('SIGKILL');
        await confirmedStop(sandbox);
        break;
      }
      if (log.stream === 'stdout') stdout += log.data;
      else stderr += log.data;
    }
    const result = outputExceeded ? { exitCode: 137 } : await command.wait({ signal });
    // Provider output must never reflect the actual broker credential.
    return {
      exitCode: result.exitCode,
      stdout: stdout.replaceAll(secret, '[REDACTED]'),
      stderr: stderr.replaceAll(secret, '[REDACTED]'),
      ...(outputExceeded ? { outputExceeded: true } : {}),
    };
  } catch {
    try { await command.kill('SIGKILL'); } finally { await confirmedStop(sandbox); }
    throw new Error('sandbox_command_failed');
  } finally {
    logs.close?.();
  }
}

async function readAssociation(sandbox: ClaudeFleetSdkSession, path: string, signal: AbortSignal): Promise<string> {
  const stream = await sandbox.readFile({ path }, { signal });
  if (!stream) throw new Error('sandbox_snapshot_association_missing');
  let text = '';
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    requireActive(signal);
    bytes += Buffer.byteLength(chunk);
    if (bytes > ASSOCIATION_LIMIT_BYTES) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw new Error('sandbox_snapshot_association_invalid');
    }
    text += chunk.toString();
  }
  return text;
}

export function createVercelClaudeWorkerAdapter(options: AdapterOptions): ClaudeWorkerAdapter {
  const sdk = options.sdk ?? Sandbox;
  const credentialBindingId = createHash('sha256').update(options.apiKey).digest('hex');
  const requireClaim = async (signal: AbortSignal) => {
    requireActive(signal);
    if (!(await options.isClaimActive())) throw new Error('lost_claim');
    requireActive(signal);
  };
  return {
    async open(input, signal) {
      await requireClaim(signal);
      if (!options.apiKey?.trim() || /[\r\n]/.test(options.apiKey)
        || !IDENTIFIER.test(options.baseSnapshotId) || !isOrganizationId(options.verifiedOrganizationId)
        || !isWorkspaceId(options.workspaceId)
        || !validBinding(input.binding)
        || input.binding.credentialBindingId !== credentialBindingId
        || input.binding.expectedOrganizationId !== options.verifiedOrganizationId
        || input.binding.workspaceId !== options.workspaceId) throw new Error('sandbox_configuration_invalid');
      const paths = claudeWorkerPaths(input.binding.alias);
      if (input.paths.configDirectory !== paths.configDirectory || input.paths.worktreePath !== paths.worktreePath) throw new Error('sandbox_isolation_invalid');
      const previous = input.previousSession;
      if (previous && (!sameBinding(previous, input.binding) || previous.confirmed !== true
        || previous.configDirectory !== paths.configDirectory || previous.worktreePath !== paths.worktreePath
        || !IDENTIFIER.test(previous.snapshotId) || !IDENTIFIER.test(previous.sandboxId) || !isOrganizationId(previous.sessionId))) {
        throw new Error('sandbox_snapshot_association_invalid');
      }
      const associationPath = `${paths.configDirectory}/fleet-binding.json`;
      const association = JSON.stringify({ binding: input.binding, paths, baseSnapshotId: options.baseSnapshotId });
      const policy = brokerPolicy(options.apiKey, options.workspaceId);
      let sandbox: ClaudeFleetSdkSandbox | undefined;
      let session: ClaudeFleetSdkSession | undefined;
      try {
        sandbox = await sdk.create({
          name: `fleet-${randomUUID()}`,
          source: { type: 'snapshot', snapshotId: previous?.snapshotId ?? options.baseSnapshotId },
          persistent: false,
          timeout: COMMAND_TIMEOUT_MS,
          ports: [],
          networkPolicy: policy,
          tags: { fleet: FLEET_TAG },
          signal,
        });
        // Record the handle even if the claim expired while creation was pending.
        if (!IDENTIFIER.test(sandbox.name) || !(await options.onSandboxCreated(sandbox.name))) throw new Error('sandbox_claim_lost');
        session = sandbox.currentSession();
        await requireClaim(signal);
        // Missing/downgraded broker policy is never replaced with in-VM credentials.
        if (session.status !== 'running' || JSON.stringify(sandbox.networkPolicy) !== JSON.stringify(policy)
          || JSON.stringify(session.networkPolicy) !== JSON.stringify(policy)) throw new Error('sandbox_broker_unavailable');
        const setup = async (cmd: string, args: string[], cwd?: string) => {
          await requireClaim(signal);
          return runBounded(session!, { cmd, args, cwd, timeoutMs: 5_000 }, signal, ASSOCIATION_LIMIT_BYTES, options.apiKey);
        };
        if (previous) {
          if (await readAssociation(session, associationPath, signal) !== association) throw new Error('sandbox_snapshot_association_invalid');
        } else {
          await session.mkDir(paths.configDirectory, { signal });
          const worktree = await setup('git', ['-C', REPOSITORY_PATH, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--', paths.worktreePath, input.binding.revision]);
          if (worktree.exitCode !== 0 || worktree.outputExceeded) throw new Error('sandbox_worktree_failed');
          await session.writeFiles([{ path: associationPath, content: Buffer.from(association) }], { signal });
        }
        const head = await setup('git', ['-C', paths.worktreePath, 'rev-parse', '--verify', 'HEAD']);
        if (head.exitCode !== 0 || head.stdout.trim() !== input.binding.revision || head.outputExceeded) throw new Error('sandbox_revision_mismatch');
        const readonly = await setup('chmod', ['-R', 'a-w', '--', paths.worktreePath]);
        if (readonly.exitCode !== 0 || readonly.outputExceeded) throw new Error('sandbox_worktree_failed');
        const version = await setup('claude', ['--version']);
        const parts = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version.stdout.trim())?.slice(1).map(Number);
        if (version.exitCode !== 0 || version.outputExceeded || !parts
          || parts[0] < 2 || (parts[0] === 2 && parts[1] < 1)
          || (parts[0] === 2 && parts[1] === 1 && parts[2] < 268)) throw new Error('sandbox_cli_unsupported');
        const opened = sandbox;
        const openedSession = session;
        return {
          sandboxId: opened.name,
          binding: { ...input.binding }, paths,
          executionAuth: { kind: 'api_key', organizationId: options.verifiedOrganizationId, workspaceId: options.workspaceId, credentialBindingId },
          async runCommand(command, commandSignal) {
            await requireClaim(commandSignal);
            if (openedSession.status !== 'running') throw new Error('sandbox_stopped');
            if (command.cmd !== 'claude' || command.cwd !== paths.worktreePath
              || command.env.CLAUDE_CONFIG_DIR !== paths.configDirectory
              || JSON.stringify(command).includes(options.apiKey)) throw new Error('sandbox_isolation_invalid');
            return runBounded(openedSession, {
              cmd: command.cmd, args: command.args, cwd: command.cwd,
              env: {
                ...command.env,
                // Marker selects official API-key auth; the firewall replaces it.
                ANTHROPIC_API_KEY: 'vercel-credential-broker',
                ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
                ANTHROPIC_CUSTOM_HEADERS: '',
                ANTHROPIC_MODEL: '',
                ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
                ANTHROPIC_DEFAULT_SONNET_MODEL: '',
                ANTHROPIC_DEFAULT_OPUS_MODEL: '',
                CLAUDE_CODE_SUBAGENT_MODEL: '',
                CLAUDE_CODE_OAUTH_TOKEN: '',
                ANTHROPIC_AUTH_TOKEN: '',
                CLAUDE_CODE_USE_BEDROCK: '',
                CLAUDE_CODE_USE_VERTEX: '',
                CLAUDE_CODE_USE_FOUNDRY: '',
                NODE_EXTRA_CA_CERTS: PROXY_CA_PATH,
                SSL_CERT_FILE: PROXY_CA_PATH,
              },
              timeoutMs: command.timeoutMs,
            }, commandSignal, command.maxOutputBytes, options.apiKey);
          },
          async snapshot(snapshotSignal) {
            await requireClaim(snapshotSignal);
            if (openedSession.status !== 'running') throw new Error('sandbox_stopped');
            // Remove the transient broker credential before retaining any state.
            await openedSession.update({ networkPolicy: 'deny-all' }, { signal: snapshotSignal });
            const snapshot = await openedSession.snapshot({ signal: snapshotSignal });
            if (!IDENTIFIER.test(snapshot.snapshotId) || (snapshot.status && snapshot.status !== 'created')) throw new Error('sandbox_snapshot_failed');
            return { snapshotId: snapshot.snapshotId };
          },
          async stop(stopSignal) { await confirmedStop(openedSession, stopSignal); },
        };
      } catch {
        if (sandbox) await confirmedStop(session ?? sandbox.currentSession());
        throw new Error('sandbox_open_failed');
      }
    },
  };
}
