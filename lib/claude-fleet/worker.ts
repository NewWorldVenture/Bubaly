import { isOrganizationId, isWorkspaceId, type AnthropicIdentityResult } from './anthropic-identity';

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const CLAUDE_WORKER_TIMEOUT_MS = 20_000;
export const CLAUDE_WORKER_MAX_OUTPUT_BYTES = 65_536;
export const CLAUDE_WORKER_MODEL = 'claude-haiku-4-5-20251001';
const CLEANUP_TIMEOUT_MS = 5_000;
const PREFLIGHT_MAX_AGE_MS = 60_000;

export type ClaudeWorkerBinding = {
  alias: string;
  expectedOrganizationId: string;
  workspaceId: string;
  branch: string;
  revision: string;
  /** Non-secret identifier for the particular execution credential. */
  credentialBindingId: string;
};

export type ClaudeWorkerPaths = { configDirectory: string; worktreePath: string };

export type ConfirmedClaudeWorkerSession = ClaudeWorkerBinding & ClaudeWorkerPaths & {
  confirmed: true;
  sessionId: string;
  sandboxId: string;
  snapshotId: string;
};

export type ClaudeWorkerCommand = {
  cmd: 'claude';
  args: string[];
  cwd: string;
  /** Contains isolation settings only. Execution credentials belong to the adapter. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ClaudeWorkerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputExceeded?: boolean;
};

/**
 * Trusted server adapter. It must bind the actual execution API key to the
 * verified organization, expose no secret values, enforce a read-only worktree,
 * cap streaming output, and kill/stop commands on abort. A successful admin
 * preflight alone does not establish the execution key's organization.
 */
export type ClaudeWorkerSandbox = {
  sandboxId: string;
  binding: ClaudeWorkerBinding;
  paths: ClaudeWorkerPaths;
  executionAuth: { kind: 'api_key'; organizationId: string; workspaceId: string; credentialBindingId: string };
  runCommand(command: ClaudeWorkerCommand, signal: AbortSignal): Promise<ClaudeWorkerCommandResult>;
  snapshot(signal: AbortSignal): Promise<{ snapshotId: string }>;
  stop(signal: AbortSignal): Promise<void>;
};

export type ClaudeWorkerAdapter = {
  /** Never restore a snapshot owned by another binding or fall back to a login. */
  open(input: {
    jobId: string;
    binding: ClaudeWorkerBinding;
    paths: ClaudeWorkerPaths;
    previousSession?: ConfirmedClaudeWorkerSession;
  }, signal: AbortSignal): Promise<ClaudeWorkerSandbox>;
};

export type ClaudeWorkerFailure =
  | 'invalid_request' | 'identity_preflight_required' | 'continuation_mismatch'
  | 'execution_identity_mismatch' | 'execution_identity_unverified' | 'auth_rejected' | 'usage_limited'
  | 'provider_error' | 'invalid_result' | 'session_mismatch' | 'output_limit'
  | 'timeout' | 'cancelled' | 'worker_crash' | 'snapshot_failed' | 'cleanup_failed';

export type ClaudeWorkerOutcome =
  | { status: 'succeeded'; result: string; session: ConfirmedClaudeWorkerSession; checkedAt: string; permissions: 'no_tools'; sandboxId: string; stoppedSandboxId: string; stopConfirmed: true }
  | { status: 'blocked' | 'failed' | 'quarantined' | 'cancelled'; reason: ClaudeWorkerFailure; checkedAt: string; permissions: 'no_tools'; sandboxId?: string; stoppedSandboxId?: string; stopConfirmed: boolean };

export type RunClaudeWorkerInput = {
  jobId: string;
  binding: ClaudeWorkerBinding;
  preflight: AnthropicIdentityResult;
  /** Fingerprint of the exact execution key used for the preflight. */
  preflightCredentialBindingId: string;
  previousSession?: ConfirmedClaudeWorkerSession;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  now?: () => Date;
};

export function claudeWorkerPaths(alias: string): ClaudeWorkerPaths {
  if (!ALIAS_PATTERN.test(alias)) throw new Error('invalid_alias');
  const normalized = alias.toUpperCase().replaceAll('-', '_');
  const root = `/vercel/claude-fleet/${normalized}`;
  return { configDirectory: `${root}/config`, worktreePath: `${root}/worktree` };
}

function sameBinding(a: ClaudeWorkerBinding, b: ClaudeWorkerBinding): boolean {
  return a.alias === b.alias && a.expectedOrganizationId === b.expectedOrganizationId
    && a.workspaceId === b.workspaceId
    && a.branch === b.branch && a.revision === b.revision
    && a.credentialBindingId === b.credentialBindingId;
}

function validBinding(binding: ClaudeWorkerBinding): boolean {
  return !!binding && ALIAS_PATTERN.test(binding.alias)
    && isOrganizationId(binding.expectedOrganizationId)
    && isWorkspaceId(binding.workspaceId)
    && binding.expectedOrganizationId === binding.expectedOrganizationId.toLowerCase()
    && /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(binding.branch)
    && !binding.branch.includes('..') && !binding.branch.endsWith('/')
    && /^[a-f0-9]{40}$/.test(binding.revision)
    && IDENTIFIER_PATTERN.test(binding.credentialBindingId);
}

function validSession(session: ConfirmedClaudeWorkerSession, binding: ClaudeWorkerBinding, paths: ClaudeWorkerPaths): boolean {
  return session.confirmed === true && sameBinding(session, binding)
    && session.configDirectory === paths.configDirectory && session.worktreePath === paths.worktreePath
    && isOrganizationId(session.sessionId) && IDENTIFIER_PATTERN.test(session.sandboxId)
    && IDENTIFIER_PATTERN.test(session.snapshotId);
}

class WorkerTimeout extends Error {}
class WorkerCancelled extends Error {}

/** Race locally as well as aborting the SDK, so an unresponsive adapter cannot hang the caller. */
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) throw new WorkerCancelled();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: (reason: Error) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
    timeout = setTimeout(() => {
      controller.abort();
      reject(new WorkerTimeout());
    }, timeoutMs);
  });
  const cancel = () => {
    controller.abort();
    rejectCancellation(new WorkerCancelled());
  };
  externalSignal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await Promise.race([operation(controller.signal), interrupted]);
    // Both promises can already be settled before race attaches its handlers.
    // Cancellation/timeout still wins before accepting the operation's value.
    if (externalSignal?.aborted) throw new WorkerCancelled();
    if (controller.signal.aborted) throw new WorkerTimeout();
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', cancel);
  }
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function exceedsOutput(result: ClaudeWorkerCommandResult): boolean {
  return result.outputExceeded === true
    || new TextEncoder().encode(result.stdout).length + new TextEncoder().encode(result.stderr).length > CLAUDE_WORKER_MAX_OUTPUT_BYTES;
}

/** No provider diagnostics are persisted. Map documented categories to fixed codes. */
function providerFailure(body: Record<string, unknown> | null, stderr: string): ClaudeWorkerFailure {
  const category = typeof body?.error === 'string' ? body.error : '';
  if (['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'cloud_credential_error'].includes(category)) return 'auth_rejected';
  if (['rate_limit', 'billing_error'].includes(category) || body?.subtype === 'error_max_budget_usd') return 'usage_limited';
  // Older CLI releases may emit plain diagnostics. Never return that diagnostic.
  if (/invalid api key|authentication failed|not logged in|unauthorized|login required/i.test(stderr)) return 'auth_rejected';
  if (/rate.?limit|usage limit|insufficient credits|credit balance|budget limit/i.test(stderr)) return 'usage_limited';
  return 'provider_error';
}

export function claudeWorkerProbeResult(jobId: string): string {
  if (!IDENTIFIER_PATTERN.test(jobId)) throw new Error('invalid_job_id');
  return `BUBALY_FLEET_PROBE_OK ${jobId}`;
}

/**
 * API-authenticated, no-tools Claude Code execution. This intentionally has no
 * edit/deploy mode and performs no retries; the durable queue owns retries and
 * quarantine. Session evidence exists only after valid JSON and a saved snapshot.
 */
export async function runClaudeReadOnlyWorker(input: RunClaudeWorkerInput, adapter: ClaudeWorkerAdapter): Promise<ClaudeWorkerOutcome> {
  const now = input.now ?? (() => new Date());
  let sandbox: ClaudeWorkerSandbox | undefined;
  const fail = (status: 'blocked' | 'failed' | 'quarantined' | 'cancelled', reason: ClaudeWorkerFailure): ClaudeWorkerOutcome => ({
    status, reason, checkedAt: now().toISOString(), permissions: 'no_tools',
    ...(sandbox && IDENTIFIER_PATTERN.test(sandbox.sandboxId) ? { sandboxId: sandbox.sandboxId } : {}),
    stopConfirmed: false,
  });
  const timeoutMs = input.timeoutMs ?? CLAUDE_WORKER_TIMEOUT_MS;
  const maxBudgetUsd = input.maxBudgetUsd ?? 0.05;
  if (!IDENTIFIER_PATTERN.test(input.jobId) || !validBinding(input.binding)
    || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd < 0.01 || maxBudgetUsd > 0.05
    || Math.abs(maxBudgetUsd * 100 - Math.round(maxBudgetUsd * 100)) > 0.00001
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLAUDE_WORKER_TIMEOUT_MS) {
    return fail('blocked', 'invalid_request');
  }
  // Job payloads are structural supersets of this type. Never carry prompt,
  // continuation or unknown fields into a snapshot's account association.
  const binding: ClaudeWorkerBinding = {
    alias: input.binding.alias, expectedOrganizationId: input.binding.expectedOrganizationId,
    workspaceId: input.binding.workspaceId,
    branch: input.binding.branch, revision: input.binding.revision,
    credentialBindingId: input.binding.credentialBindingId,
  };
  const preflightAge = now().getTime() - Date.parse(input.preflight.checkedAt);
  if (input.preflight.status !== 'organization_verified'
    || input.preflight.organizationId !== binding.expectedOrganizationId
    || input.preflight.workspaceId !== binding.workspaceId
    || input.preflightCredentialBindingId !== binding.credentialBindingId
    || !Number.isFinite(preflightAge) || preflightAge < 0 || preflightAge > PREFLIGHT_MAX_AGE_MS) {
    return fail('blocked', 'identity_preflight_required');
  }
  const paths = claudeWorkerPaths(binding.alias);
  if (input.previousSession && !validSession(input.previousSession, binding, paths)) {
    return fail('blocked', 'continuation_mismatch');
  }
  const previousSession: ConfirmedClaudeWorkerSession | undefined = input.previousSession ? {
    ...binding, ...paths, confirmed: true, sessionId: input.previousSession.sessionId,
    sandboxId: input.previousSession.sandboxId, snapshotId: input.previousSession.snapshotId,
  } : undefined;
  if (input.signal?.aborted) return fail('cancelled', 'cancelled');

  let outcome: ClaudeWorkerOutcome;
  let executionStarted = false;
  let phase: 'open' | 'auth' | 'execute' | 'snapshot' = 'open';
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const duration = deadline - Date.now();
    if (duration <= 0) throw new WorkerTimeout();
    return duration;
  };
  const env = {
    CLAUDE_CONFIG_DIR: paths.configDirectory,
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    CLAUDE_CODE_USE_FOUNDRY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128',
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_RETRY_WATCHDOG: '',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    MAX_THINKING_TOKENS: '0',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
  const command = (args: string[]): ClaudeWorkerCommand => ({
    cmd: 'claude', args, cwd: paths.worktreePath, env, timeoutMs: remaining(), maxOutputBytes: CLAUDE_WORKER_MAX_OUTPUT_BYTES,
  });
  let stopAttempt: Promise<void> | undefined;
  const stopOwnedSandbox = (opened: ClaudeWorkerSandbox) => stopAttempt ??=
    bounded((cleanupSignal) => opened.stop(cleanupSignal), CLEANUP_TIMEOUT_MS);
  try {
    sandbox = await bounded(async (signal) => {
      const opened = await adapter.open({ jobId: input.jobId, binding, paths, previousSession }, signal);
      // Own the resource before bounded() or the outer await can reject it.
      sandbox = opened;
      if (signal.aborted) {
        // Creation may finish after timeout. Terminate that late sandbox too.
        try { await stopOwnedSandbox(opened); } catch { /* already quarantined */ }
        throw new WorkerCancelled();
      }
      return opened;
    }, remaining(), input.signal);
    if (!IDENTIFIER_PATTERN.test(sandbox.sandboxId) || !sameBinding(sandbox.binding, binding)
      || sandbox.paths.configDirectory !== paths.configDirectory || sandbox.paths.worktreePath !== paths.worktreePath
      || sandbox.executionAuth.kind !== 'api_key'
      || sandbox.executionAuth.organizationId !== binding.expectedOrganizationId
      || sandbox.executionAuth.workspaceId !== binding.workspaceId
      || sandbox.executionAuth.credentialBindingId !== binding.credentialBindingId) {
      outcome = fail('quarantined', 'execution_identity_mismatch');
    } else {
      phase = 'auth';
      const auth = await bounded((signal) => sandbox!.runCommand(command(['auth', 'status']), signal), remaining(), input.signal);
      if (input.signal?.aborted) throw new WorkerCancelled();
      const authBody = parseRecord(auth.stdout);
      if (exceedsOutput(auth)) outcome = fail('failed', 'output_limit');
      else if (auth.exitCode !== 0 || authBody?.loggedIn !== true || authBody.authMethod !== 'api_key') outcome = fail('blocked', 'auth_rejected');
      else if (authBody.configDirectory !== paths.configDirectory) outcome = fail('quarantined', 'execution_identity_mismatch');
      else {
        phase = 'execute';
        executionStarted = true;
        const args = [
          '--bare', '--print', '--output-format', 'json', '--model', CLAUDE_WORKER_MODEL, '--tools', '',
          '--system-prompt', 'You are a read-only synthetic connection probe. Return only the exact requested nonce.',
          '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', '',
          '--max-turns', '1', '--max-budget-usd', maxBudgetUsd.toFixed(2),
          ...(previousSession ? ['--resume', previousSession.sessionId] : []),
          '--', `Reply with exactly this text, with no tools or other content: ${claudeWorkerProbeResult(input.jobId)}`,
        ];
        const completed = await bounded((signal) => sandbox!.runCommand(command(args), signal), remaining(), input.signal);
        if (input.signal?.aborted) throw new WorkerCancelled();
        const body = parseRecord(completed.stdout);
        if (exceedsOutput(completed)) outcome = fail('quarantined', 'output_limit');
        else if (completed.exitCode !== 0 || body?.is_error === true) outcome = fail('failed', providerFailure(body, completed.stderr));
        else if (body?.type !== 'result' || body.subtype !== 'success' || body.is_error !== false
          || !isOrganizationId(body.session_id) || typeof body.result !== 'string'
          || body.result.trim() !== claudeWorkerProbeResult(input.jobId)
          || typeof body.num_turns !== 'number' || body.num_turns < 1 || body.num_turns > 1) {
          outcome = fail('quarantined', 'invalid_result');
        } else if (previousSession && body.session_id !== previousSession.sessionId) {
          outcome = fail('quarantined', 'session_mismatch');
        } else {
          phase = 'snapshot';
          const saved = await bounded((signal) => sandbox!.snapshot(signal), remaining(), input.signal);
          if (input.signal?.aborted) throw new WorkerCancelled();
          if (!IDENTIFIER_PATTERN.test(saved.snapshotId)) outcome = fail('quarantined', 'snapshot_failed');
          else outcome = {
            status: 'succeeded', result: claudeWorkerProbeResult(input.jobId),
            session: { ...binding, ...paths, confirmed: true, sessionId: body.session_id, sandboxId: sandbox.sandboxId, snapshotId: saved.snapshotId },
            checkedAt: now().toISOString(), permissions: 'no_tools',
            sandboxId: sandbox.sandboxId, stoppedSandboxId: sandbox.sandboxId, stopConfirmed: true,
          };
        }
      }
    }
  } catch (error) {
    const reason = error instanceof WorkerTimeout ? 'timeout'
      : error instanceof WorkerCancelled ? 'cancelled'
        : phase === 'snapshot' ? 'snapshot_failed' : 'worker_crash';
    outcome = fail(executionStarted || phase === 'open' ? 'quarantined' : reason === 'cancelled' ? 'cancelled' : 'failed', reason);
  } finally {
    if (sandbox) {
      try {
        await stopOwnedSandbox(sandbox);
        if (IDENTIFIER_PATTERN.test(sandbox.sandboxId)) {
          outcome = { ...outcome!, sandboxId: sandbox.sandboxId, stoppedSandboxId: sandbox.sandboxId, stopConfirmed: true };
        }
      } catch {
        outcome = fail('quarantined', 'cleanup_failed');
      }
    }
  }
  // Cancellation may arrive after an inner await or while required cleanup is
  // settling. The final synchronous acceptance boundary cannot publish a session.
  if (outcome!.status === 'succeeded' && input.signal?.aborted) {
    outcome = {
      status: 'quarantined', reason: 'cancelled', checkedAt: outcome.checkedAt,
      permissions: outcome.permissions, sandboxId: outcome.sandboxId,
      stoppedSandboxId: outcome.stoppedSandboxId, stopConfirmed: outcome.stopConfirmed,
    };
  }
  return outcome!;
}
