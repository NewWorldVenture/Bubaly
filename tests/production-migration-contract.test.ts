import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const cases = [
  ['0174_workload_snapshots.sql', 'workload_snapshots'],
  ['0175_independence_milestones.sql', 'independence_milestones'],
  ['0176_marketplace_circles.sql', 'marketplace_circles'],
  ['0180_resend_webhook_dedup.sql', 'resend_webhook_events'],
  ['0181_guardian_callback_replay.sql', 'guardian_callback_events'],
] as const;

describe('forward-only production migration reconciliation', () => {
  it.each(cases)('%s creates and protects %s', (file, table) => {
    const sql = readFileSync(resolve(root, 'supabase', 'migrations', file), 'utf8');
    expect(sql).toMatch(new RegExp(`create table if not exists public\\.${table}`));
    expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security`));
  });

  it.each([
    '0166_workload_snapshots.sql',
    '0167_independence_milestones.sql',
    '0173_marketplace_circles.sql',
  ])('removes the skipped historical version %s', (file) => {
    expect(existsSync(resolve(root, 'supabase', 'migrations', file))).toBe(false);
  });

  it('keeps the production audit aligned with the reconciled tables', () => {
    const audit = readFileSync(resolve(root, 'scripts', 'audit-supabase-schema.mjs'), 'utf8');
    for (const [file, table] of cases) {
      expect(audit).toContain(file);
      expect(audit).toContain(table);
    }
  });

  it('adds a processing claim timestamp to the Stripe replay ledger', () => {
    const sql = readFileSync(resolve(root, 'supabase', 'migrations', '0182_stripe_webhook_claims.sql'), 'utf8');
    expect(sql).toContain('alter table public.stripe_webhook_events');
    expect(sql).toContain('add column if not exists processing_started_at timestamptz');
    expect(sql).toContain('add column if not exists claim_token text');
  });

  it('reconciles Stripe claim columns for partially applied environments', () => {
    const sql = readFileSync(resolve(root, 'supabase', 'migrations', '0189_reconcile_stripe_webhook_claims.sql'), 'utf8');
    expect(sql).toContain('alter table public.stripe_webhook_events');
    expect(sql).toContain('add column if not exists processing_started_at timestamptz');
    expect(sql).toContain('add column if not exists claim_token text');
    expect(sql).toContain('create index if not exists idx_stripe_webhook_events_processing');
    expect(sql).toContain('begin;');
    expect(sql).toContain('commit;');
  });
});

// Run the real metadata entrypoint locally. Only fetch is replaced, inside an
// isolated child with synthetic credentials; no CLI/provider request is made.
import { spawnSync as spawnMetadataAudit } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

function runMetadataHistoryControl(version: '0003' | '0004') {
  const tempRoot = realpathSync(tmpdir());
  const sandbox = mkdtempSync(join(tempRoot, 'bubaly-readonly-metadata-'));
  const home = join(sandbox, 'home'), temp = join(sandbox, 'temp');
  mkdirSync(home); mkdirSync(temp);
  const preload = join(sandbox, 'synthetic-fetch.mjs');
  writeFileSync(preload, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const requests = [];
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query');
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert(options.signal instanceof AbortSignal);
  const body = JSON.parse(options.body); assert.equal(body.read_only, true);
  assert.match(body.query.trim(), /^select\\b/i);
  requests.push({ url: String(url), method: options.method, readOnly: body.read_only, redirect: options.redirect, hasDeadline: !!options.signal });
  writeFileSync('metadata-requests.json', JSON.stringify(requests));
  if (requests.length === 1) return Response.json([{ snapshot: { hasMigrationLedger: true, tables: [], policies: [{ table: 'profiles', name: 'profiles_insert_self' }], functions: [], moneyWritePolicies: [] } }]);
  assert.equal(requests.length, 2);
  return Response.json([{ version: ${JSON.stringify(version)}, name: 'synthetic_recorded_history' }]);
};
`);
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TEMP: temp, TMP: temp, TMPDIR: temp, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
    SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', SUPABASE_ACCESS_TOKEN: 'synthetic-management-token',
    SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NODE_ENV: 'test',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
  };
  const result = spawnMetadataAudit(process.execPath, ['--import', pathToFileURL(preload).href, resolve(root, 'scripts/audit-production-migration-state.mjs'), '--enforce-history'], {
    cwd: sandbox, env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  writeFileSync(join(sandbox, 'stdout.txt'), result.stdout ?? ''); writeFileSync(join(sandbox, 'stderr.txt'), result.stderr ?? '');
  expect(result.error, `Metadata control setup failed: ${sandbox}`).toBeUndefined();
  const artifact = JSON.parse(readFileSync(join(sandbox, '.next/production-schema-audit.json'), 'utf8'));
  const requests = JSON.parse(readFileSync(join(sandbox, 'metadata-requests.json'), 'utf8'));
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(request).toMatchObject({ method: 'POST', readOnly: true, redirect: 'error', hasDeadline: true });
  expect(artifact.migrations).toEqual([{ version, name: 'synthetic_recorded_history' }]);
  expect(artifact.policies).toContainEqual({ table: 'profiles', name: 'profiles_insert_self' });
  return { result, artifact, requests, cleanup: () => {
    if (dirname(realpathSync(sandbox)) !== tempRoot) throw new Error('Unsafe metadata selftest cleanup target');
    rmSync(sandbox, { recursive: true, force: true });
  } };
}

describe('the actual read-only production metadata entrypoint retains its history boundary', () => {
  it('writes its metadata artifact and fails when baseline history is unrecorded', () => {
    const control = runMetadataHistoryControl('0003');
    expect(control.result.status).toBe(1);
    expect(control.result.stderr).toContain('Existing production policies have no recorded baseline migration 0004.');
    expect(control.result.stdout).toContain('"requiresBaselineReview":true');
    expect(control.result.stderr).not.toContain('synthetic-management-token');
    control.cleanup();
  });
  it('retains metadata and succeeds when the synthetic baseline is recorded', () => {
    const control = runMetadataHistoryControl('0004');
    expect(control.result.status).toBe(0);
    expect(control.result.stdout).toContain('"requiresBaselineReview":false');
    expect(control.result.stderr).toBe('');
    control.cleanup();
  });
});
