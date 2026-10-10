import 'server-only';
import { createHash } from 'node:crypto';
import { parseClaudeFleetBindings } from './config';
import { isWorkspaceId } from './anthropic-identity';

export class FleetConfigurationError extends Error {
  constructor(public readonly code: string) { super(code); }
}

type FleetEnvironment = Readonly<Record<string, string | undefined>>;

export type FleetWorkerRegistration = {
  alias: string;
  expectedOrganizationId: string;
  workspaceId: string;
  branch: string;
  revision: string;
  baseSnapshotId: string;
  credentialBindingId: string;
  /** Transient server secret: never serialize a registration. */
  executionKey: string;
};

export function fleetDatabaseConfig(env: FleetEnvironment = process.env) {
  const raw = env.CLAUDE_FLEET_DATABASE_URL;
  const authToken = env.CLAUDE_FLEET_DATABASE_AUTH_TOKEN;
  if (!raw || !authToken?.trim()) throw new FleetConfigurationError('database_unconfigured');
  let url: URL;
  try { url = new URL(raw); } catch { throw new FleetConfigurationError('invalid_database_url'); }
  if (!['libsql:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.hash || url.search || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new FleetConfigurationError('remote_database_required');
  }
  return { url: url.href, authToken };
}

export function fleetMaxConcurrency(env: FleetEnvironment = process.env): number {
  const raw = env.CLAUDE_FLEET_MAX_CONCURRENCY ?? '2';
  if (!/^[1-8]$/.test(raw)) throw new FleetConfigurationError('invalid_concurrency');
  return Number(raw);
}

export function fleetDailyBudget(env: FleetEnvironment = process.env): number {
  const raw = env.CLAUDE_FLEET_DAILY_BUDGET_USD ?? '0.25';
  if (!/^0?\.[0-9]{1,2}$|^1(?:\.0{1,2})?$/.test(raw)) throw new FleetConfigurationError('invalid_daily_budget');
  const amount = Number(raw);
  if (amount < 0.05 || amount > 1) throw new FleetConfigurationError('invalid_daily_budget');
  return amount;
}

export function fleetWorkerRegistrations(env: FleetEnvironment = process.env): FleetWorkerRegistration[] {
  const accounts = parseClaudeFleetBindings(env.CLAUDE_FLEET_ACCOUNT_BINDINGS);
  if (!accounts.ok) throw new FleetConfigurationError('accounts_unconfigured');
  let parsed: unknown;
  try { parsed = JSON.parse(env.CLAUDE_FLEET_WORKER_BINDINGS ?? ''); }
  catch { throw new FleetConfigurationError('workers_unconfigured'); }
  if (!Array.isArray(parsed) || parsed.length !== accounts.bindings.length) {
    throw new FleetConfigurationError('invalid_worker_bindings');
  }
  const seen = new Set<string>();
  const snapshots = new Set<string>();
  const credentials = new Set<string>();
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new FleetConfigurationError('invalid_worker_bindings');
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'alias,branch,revision,snapshotId,workspaceId') {
      throw new FleetConfigurationError('invalid_worker_bindings');
    }
    const account = accounts.bindings.find((binding) => binding.alias === record.alias);
    if (!account || seen.has(account.alias)) throw new FleetConfigurationError('invalid_worker_alias');
    seen.add(account.alias);
    if (!isWorkspaceId(record.workspaceId)) throw new FleetConfigurationError('invalid_worker_workspace');
    if (typeof record.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(record.branch)
      || record.branch.includes('..') || record.branch.includes('//') || /[/.]$|\.lock$/.test(record.branch)) {
      throw new FleetConfigurationError('invalid_worker_branch');
    }
    if (typeof record.revision !== 'string' || !/^[0-9a-f]{40}$/i.test(record.revision)) {
      throw new FleetConfigurationError('invalid_worker_revision');
    }
    if (typeof record.snapshotId !== 'string' || !/^snap_[A-Za-z0-9_-]{1,100}$/.test(record.snapshotId)
      || snapshots.has(record.snapshotId)) throw new FleetConfigurationError('isolated_snapshot_required');
    snapshots.add(record.snapshotId);
    const normalizedAlias = account.alias.toUpperCase().replaceAll('-', '_');
    const executionKey = env[`ANTHROPIC_API_KEY__${normalizedAlias}`]?.trim();
    if (!executionKey || /[\r\n]/.test(executionKey)) throw new FleetConfigurationError('execution_key_unconfigured');
    const credentialBindingId = createHash('sha256').update(executionKey).digest('hex');
    if (credentials.has(credentialBindingId)) throw new FleetConfigurationError('isolated_credential_required');
    credentials.add(credentialBindingId);
    return {
      alias: normalizedAlias, expectedOrganizationId: account.expectedOrganizationId, workspaceId: record.workspaceId,
      branch: record.branch, revision: record.revision.toLowerCase(), baseSnapshotId: record.snapshotId,
      credentialBindingId, executionKey,
    };
  });
}

export function fleetExecutionEnabled(env: FleetEnvironment = process.env): boolean {
  return env.CLAUDE_FLEET_WORKERS_ENABLED === 'true' && env.CLAUDE_FLEET_PAID_PROBES_APPROVED === 'true';
}
