import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fleetDatabaseConfig, fleetDailyBudget, fleetExecutionEnabled, fleetMaxConcurrency,
  fleetWorkerRegistrations,
} from '@/lib/claude-fleet/runtime-config';

const org = '12345678-1234-1234-1234-123456789abc';
const revision = 'a'.repeat(40);
const workspaceId = 'wrkspc_synthetic';
function config(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CLAUDE_FLEET_ACCOUNT_BINDINGS: JSON.stringify([{ alias: 'synthetic-account', expectedOrganizationId: org }]),
    CLAUDE_FLEET_WORKER_BINDINGS: JSON.stringify([{ alias: 'synthetic-account', branch: 'fleet/probe', revision, snapshotId: 'snap_synthetic', workspaceId }]),
    ANTHROPIC_API_KEY__SYNTHETIC_ACCOUNT: 'synthetic-execution-key', ...overrides,
  };
}

describe('durable fleet configuration', () => {
  it('requires both explicit execution gates', () => {
    expect(fleetExecutionEnabled({})).toBe(false);
    expect(fleetExecutionEnabled({ CLAUDE_FLEET_WORKERS_ENABLED: 'true' })).toBe(false);
    expect(fleetExecutionEnabled({ CLAUDE_FLEET_PAID_PROBES_APPROVED: 'true' })).toBe(false);
    expect(fleetExecutionEnabled({ CLAUDE_FLEET_WORKERS_ENABLED: '1', CLAUDE_FLEET_PAID_PROBES_APPROVED: 'true' })).toBe(false);
    expect(fleetExecutionEnabled({ CLAUDE_FLEET_WORKERS_ENABLED: 'true', CLAUDE_FLEET_PAID_PROBES_APPROVED: 'true' })).toBe(true);
  });

  it('uses a remote authenticated database without credentials in its URL', () => {
    expect(fleetDatabaseConfig({ CLAUDE_FLEET_DATABASE_URL: 'libsql://synthetic.turso.io', CLAUDE_FLEET_DATABASE_AUTH_TOKEN: 'synthetic-token' }))
      .toEqual({ url: 'libsql://synthetic.turso.io', authToken: 'synthetic-token' });
    expect(() => fleetDatabaseConfig({})).toThrow('database_unconfigured');
    expect(() => fleetDatabaseConfig({ CLAUDE_FLEET_DATABASE_URL: 'https://synthetic.test', CLAUDE_FLEET_DATABASE_AUTH_TOKEN: '  ' }))
      .toThrow('database_unconfigured');
  });

  it.each(['file:queue.db', ':memory:', 'http://synthetic.test', 'https://localhost', 'https://127.0.0.1',
    'https://[::1]', 'https://user:secret@synthetic.test', 'https://synthetic.test?token=secret', 'https://synthetic.test#key'])
  ('rejects unsafe or ephemeral database target %s', (url) => {
    expect(() => fleetDatabaseConfig({ CLAUDE_FLEET_DATABASE_URL: url, CLAUDE_FLEET_DATABASE_AUTH_TOKEN: 'synthetic-token' })).toThrow();
  });

  it('bounds configurable account concurrency and daily reservation capacity', () => {
    expect(fleetMaxConcurrency({})).toBe(2);
    expect(fleetMaxConcurrency({ CLAUDE_FLEET_MAX_CONCURRENCY: '8' })).toBe(8);
    expect(fleetDailyBudget({})).toBe(0.25);
    expect(fleetDailyBudget({ CLAUDE_FLEET_DAILY_BUDGET_USD: '0.05' })).toBe(0.05);
    for (const value of ['0', '9', '2.5', '02', '-1', 'NaN', '']) {
      expect(() => fleetMaxConcurrency({ CLAUDE_FLEET_MAX_CONCURRENCY: value })).toThrow('invalid_concurrency');
    }
    for (const value of ['0', '0.04', '1.01', '0.251', '2', '-1', 'NaN', '']) {
      expect(() => fleetDailyBudget({ CLAUDE_FLEET_DAILY_BUDGET_USD: value })).toThrow('invalid_daily_budget');
    }
  });

  it('binds the fixed revision and exact execution-key fingerprint to a canonical alias', () => {
    const [registration] = fleetWorkerRegistrations(config());
    expect(registration).toEqual({ alias: 'SYNTHETIC_ACCOUNT', expectedOrganizationId: org, workspaceId,
      branch: 'fleet/probe', revision, baseSnapshotId: 'snap_synthetic', executionKey: 'synthetic-execution-key',
      credentialBindingId: createHash('sha256').update('synthetic-execution-key').digest('hex') });
    expect(fleetWorkerRegistrations(config({ ANTHROPIC_API_KEY__SYNTHETIC_ACCOUNT: 'rotated-synthetic-key' }))[0].credentialBindingId)
      .not.toBe(registration.credentialBindingId);
  });

  it('does not substitute the admin-only preflight credential for the worker execution key', () => {
    expect(() => fleetWorkerRegistrations(config({ ANTHROPIC_API_KEY__SYNTHETIC_ACCOUNT: undefined,
      ANTHROPIC_ADMIN_API_KEY__SYNTHETIC_ACCOUNT: 'synthetic-admin-key' }))).toThrow('execution_key_unconfigured');
  });

  it.each([
    { alias: 'synthetic-account', branch: '--unsafe', revision, snapshotId: 'snap_synthetic' },
    { alias: 'synthetic-account', branch: 'fleet/../probe', revision, snapshotId: 'snap_synthetic' },
    { alias: 'synthetic-account', branch: 'fleet/probe', revision: 'main', snapshotId: 'snap_synthetic' },
    { alias: 'synthetic-account', branch: 'fleet/probe', revision, snapshotId: 'https://snapshot.test' },
    { alias: 'other', branch: 'fleet/probe', revision, snapshotId: 'snap_synthetic' },
    { alias: 'synthetic-account', branch: 'fleet/probe', revision, snapshotId: 'snap_synthetic', apiKey: 'synthetic-key' },
  ])('rejects caller-supplied extra binding fields and unsafe worker associations', (binding) => {
    expect(() => fleetWorkerRegistrations(config({ CLAUDE_FLEET_WORKER_BINDINGS: JSON.stringify([{ ...binding, workspaceId }]) }))).toThrow();
  });

  it('requires one isolated snapshot and one distinct credential for each configured alias', () => {
    const env = config({
      CLAUDE_FLEET_ACCOUNT_BINDINGS: JSON.stringify([{ alias: 'synthetic-account', expectedOrganizationId: org }, { alias: 'second', expectedOrganizationId: org }]),
      CLAUDE_FLEET_WORKER_BINDINGS: JSON.stringify([
        { alias: 'synthetic-account', branch: 'fleet/one', revision, snapshotId: 'snap_one', workspaceId },
        { alias: 'second', branch: 'fleet/two', revision, snapshotId: 'snap_two', workspaceId },
      ]), ANTHROPIC_API_KEY__SECOND: 'second-synthetic-key',
    });
    expect(fleetWorkerRegistrations(env)).toHaveLength(2);
    expect(() => fleetWorkerRegistrations({ ...env, ANTHROPIC_API_KEY__SECOND: 'synthetic-execution-key' })).toThrow('isolated_credential_required');
    const bindings = JSON.parse(env.CLAUDE_FLEET_WORKER_BINDINGS!);
    bindings[1].snapshotId = 'snap_one';
    expect(() => fleetWorkerRegistrations({ ...env, CLAUDE_FLEET_WORKER_BINDINGS: JSON.stringify(bindings) })).toThrow('isolated_snapshot_required');
  });

  it('requires a valid explicit workspace before any worker registration is usable', () => {
    for (const workspaceId of [undefined, '', 'default', 'wrkspc_../outside']) {
      expect(() => fleetWorkerRegistrations(config({ CLAUDE_FLEET_WORKER_BINDINGS: JSON.stringify([
        { alias: 'synthetic-account', branch: 'fleet/probe', revision, snapshotId: 'snap_one', workspaceId },
      ]) }))).toThrow();
    }
  });
});
