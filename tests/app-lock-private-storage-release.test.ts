import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  PROJECT, VERSION, NAME, MIGRATION_SHA256, readAppLockMigration,
  buildAppLockReleaseSql, runAppLockRelease, releaseModeFromArgs, VERIFICATION_SQL,
} from '../scripts/apply-app-lock-private-storage.mjs';

const revision = '1'.repeat(40);
const anotherRevision = '2'.repeat(40);
const otherLedgerHash = 'a'.repeat(64);
const databaseUrl = 'https://api.supabase.com/v1/projects/ltcxlbipiihclxwioyqj/database/query';
const mainUrl = 'https://api.github.com/repos/NewWorldVenture/Bubaly/git/ref/heads/main';
const liveUrl = 'https://www.bubaly.com/api/build-info';
const migrationPath = 'supabase/reserved/20261025234230_app_lock_credentials_are_server_private.sql';
const file = readAppLockMigration();
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const snapshot = () => ({
  schemaReady: true,
  otherLedgerHash,
  historyConflict: false,
  privateTable: false,
  rejectFunction: false,
  rejectTrigger: false,
  migration: null as null | { name: string; statementCount: number; sha256: string },
  legacy: { keys: 5, records: 5, enabled: 2, malformed: 0 },
});
const applied = () => ({
  ...snapshot(), privateTable: true, rejectFunction: true, rejectTrigger: true,
  migration: { name: NAME, statementCount: 1, sha256: MIGRATION_SHA256 },
  legacy: { keys: 0, records: 0, enabled: 0, malformed: 0 },
});
const verification = () => ({
  privateRls: true, privateForceRls: true, policyCount: 0,
  browserPrivileges: false, servicePrivileges: true,
  triggerProtected: true, functionProtected: true,
  publicKeys: 0, privateRecords: 5, enabledPrivate: 2,
});
const options = {
  projectRef: PROJECT, token: 'synthetic-management-secret', githubToken: 'synthetic-github-secret',
  expectedRevision: revision, githubSha: revision, githubRef: 'refs/heads/main', file,
};
const parsedBody = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
const writes = (calls: unknown[][]) => calls.filter(call => call[0] === databaseUrl && parsedBody(call).read_only === false);
const successfulApplyFetch = () => vi.fn()
  .mockResolvedValueOnce(reply([{ snapshot: snapshot() }]))
  .mockResolvedValueOnce(reply({ object: { sha: revision } }))
  .mockResolvedValueOnce(reply({ revision }))
  .mockResolvedValueOnce(reply({ object: { sha: revision } }))
  .mockResolvedValueOnce(reply([]))
  .mockResolvedValueOnce(reply([{ snapshot: applied() }]))
  .mockResolvedValueOnce(reply([{ verification: verification() }]));

describe('App Lock private-storage release', () => {
  it('pins one production project and one timestamped migration, checking its complete source hash', () => {
    expect(PROJECT).toBe('ltcxlbipiihclxwioyqj');
    expect(VERSION).toBe('20261025234230');
    expect(NAME).toBe('app_lock_credentials_are_server_private');
    expect(MIGRATION_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const read = vi.fn((path: string) => readFileSync(path, 'utf8'));
    expect(readAppLockMigration(read)).toEqual(file);
    expect(read).toHaveBeenCalledTimes(1);
    expect(String(read.mock.calls[0][0])).toContain(migrationPath);
    expect(file.version).toBe(VERSION);
    expect(file.name).toBe(NAME);
    expect(createHash('sha256').update(file.sql).digest('hex')).toBe(MIGRATION_SHA256);
    expect(() => readAppLockMigration(() => file.sql + '\n-- unreviewed change\n')).toThrow();
  });

  it('defaults to preview and accepts no alternate migration or SQL path', () => {
    expect(releaseModeFromArgs([])).toEqual({ apply: false });
    expect(releaseModeFromArgs(['--apply'])).toEqual({ apply: true });
    for (const args of [['--apply=true'], ['--file', '/tmp/other.sql'], ['--include-all'], ['--require-applied']]) {
      expect(() => releaseModeFromArgs(args)).toThrow();
    }
  });

  it.each([
    { projectRef: 'wrong-project' }, { token: '' }, { expectedRevision: '' },
    { expectedRevision: revision.slice(0, 7) }, { expectedRevision: anotherRevision },
    { githubSha: anotherRevision }, { githubRef: 'refs/heads/a-preview-branch' },
    { githubRef: 'refs/tags/main' },
  ])('rejects an unreviewed local release context before any network access: %j', async override => {
    const fetchImpl = vi.fn();
    await expect(runAppLockRelease({ ...options, ...override, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not accept an injected migration with a forged digest or different source', async () => {
    for (const changed of [
      { ...file, sql: file.sql + '\nselect 1;' },
      { ...file, version: '0487' },
      { ...file, name: 'unreviewed_migration' },
      { ...file, sha256: '0'.repeat(64) },
    ]) {
      const fetchImpl = vi.fn();
      await expect(runAppLockRelease({ ...options, file: changed, fetchImpl })).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('previews using one aggregate-only read and sends no database write', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: snapshot() }]));
    const result = await runAppLockRelease({ ...options, githubToken: undefined, fetchImpl });
    expect(result.status).toBe('preview');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(databaseUrl);
    expect(parsedBody(fetchImpl.mock.calls[0]).read_only).toBe(true);
    expect(writes(fetchImpl.mock.calls)).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(options.token);
    expect(JSON.stringify(result)).not.toContain(file.sql);
  });

  it.each([
    ['missing schema', { schemaReady: false }],
    ['conflicting historical version', { historyConflict: true }],
    ['invalid historical fingerprint', { otherLedgerHash: 'not-a-digest' }],
    ['unrecorded table', { privateTable: true }],
    ['unrecorded trigger function', { rejectFunction: true }],
    ['unrecorded trigger', { rejectTrigger: true }],
    ['malformed legacy PIN', { legacy: { keys: 5, records: 5, enabled: 2, malformed: 1 } }],
    ['invalid aggregate', { legacy: { keys: -1, records: 5, enabled: 2, malformed: 0 } }],
  ])('refuses %s before checking production or sending a write', async (_label, override) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: { ...snapshot(), ...override } }]));
    await expect(runAppLockRelease({ ...options, apply: true, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes(fetchImpl.mock.calls)).toHaveLength(0);
  });

  it.each([null, [], [{}], [{ snapshot: null }], [{ snapshot: { schemaReady: true } }]])(
    'rejects malformed preflight metadata rather than treating it as an empty installation', async metadata => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(reply(metadata));
      await expect(runAppLockRelease({ ...options, apply: true, fetchImpl })).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(writes(fetchImpl.mock.calls)).toHaveLength(0);
    },
  );

  it.each([
    { name: 'another_migration' }, { statementCount: 0 }, { statementCount: 2 }, { sha256: '0'.repeat(64) },
  ])('refuses an existing version with different recorded migration material: %j', async override => {
    const state = applied();
    state.migration = { ...state.migration, ...override };
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: state }]));
    await expect(runAppLockRelease({ ...options, apply: true, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes(fetchImpl.mock.calls)).toHaveLength(0);
  });

  it('proves an already applied exact migration without replay or production revision requests', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply([{ snapshot: applied() }]))
      .mockResolvedValueOnce(reply([{ verification: verification() }]));
    const result = await runAppLockRelease({ ...options, apply: true, fetchImpl });
    expect(result.status).toBe('already_applied');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      expect(call[0]).toBe(databaseUrl);
      expect(parsedBody(call).read_only).toBe(true);
    }
  });

  it.each([
    { privateRls: false }, { privateForceRls: false }, { policyCount: 1 },
    { browserPrivileges: true }, { servicePrivileges: false },
    { triggerProtected: false }, { functionProtected: false }, { publicKeys: 1 },
  ])('refuses applied proof when a privacy postcondition is absent: %j', async override => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply([{ snapshot: applied() }]))
      .mockResolvedValueOnce(reply([{ verification: { ...verification(), ...override } }]));
    await expect(runAppLockRelease({ ...options, apply: true, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(writes(fetchImpl.mock.calls)).toHaveLength(0);
  });

  it('checks current main and the live build, then rechecks main before exactly one atomic write', async () => {
    const fetchImpl = successfulApplyFetch();
    const result = await runAppLockRelease({ ...options, apply: true, fetchImpl });
    expect(result.status).toBe('applied');
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      databaseUrl, mainUrl, liveUrl, mainUrl, databaseUrl, databaseUrl, databaseUrl,
    ]);
    const mutations = writes(fetchImpl.mock.calls);
    expect(mutations).toHaveLength(1);
    expect(parsedBody(mutations[0]).query).toBe(buildAppLockReleaseSql(file, otherLedgerHash));
    for (const [url, init] of fetchImpl.mock.calls as [string, RequestInit][]) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init.headers);
      if (url === databaseUrl) expect(headers.get('authorization')).toBe(`Bearer ${options.token}`);
      if (url === mainUrl) expect(headers.get('authorization')).toBe(`Bearer ${options.githubToken}`);
      if (url === liveUrl) expect(headers.get('authorization')).toBeNull();
    }
  });

  it.each(['main', 'live', 'main-moved'] as const)(
    'does not write when the %s revision differs from the reviewed checkout', async mismatch => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: snapshot() }]));
      fetchImpl.mockResolvedValueOnce(reply({ object: { sha: mismatch === 'main' ? anotherRevision : revision } }));
      if (mismatch !== 'main') fetchImpl.mockResolvedValueOnce(reply({ revision: mismatch === 'live' ? anotherRevision : revision }));
      if (mismatch === 'main-moved') fetchImpl.mockResolvedValueOnce(reply({ object: { sha: anotherRevision } }));
      await expect(runAppLockRelease({ ...options, apply: true, fetchImpl })).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(mismatch === 'main' ? 2 : mismatch === 'live' ? 3 : 4);
      expect(writes(fetchImpl.mock.calls)).toHaveLength(0);
    },
  );

  it.each([null, {}, { revision: null }, { revision: revision.slice(0, 7) }])(
    'refuses missing or malformed live-build identity before the mutation', async build => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(reply([{ snapshot: snapshot() }]))
        .mockResolvedValueOnce(reply({ object: { sha: revision } }))
        .mockResolvedValueOnce(reply(build));
      await expect(runAppLockRelease({ ...options, apply: true, fetchImpl })).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(writes(fetchImpl.mock.calls)).toHaveLength(0);
    },
  );

  it.each(['network', 'http'] as const)('never retries an ambiguous %s write or leaks raw errors', async failure => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply([{ snapshot: snapshot() }]))
      .mockResolvedValueOnce(reply({ object: { sha: revision } }))
      .mockResolvedValueOnce(reply({ revision }))
      .mockResolvedValueOnce(reply({ object: { sha: revision } }));
    const detail = `customer-secret ${options.token} ${options.githubToken}`;
    if (failure === 'network') fetchImpl.mockRejectedValueOnce(new Error(detail));
    else fetchImpl.mockResolvedValueOnce(new Response(`ERROR: 23514: ${detail}`, { status: 400 }));
    const error = await runAppLockRelease({ ...options, apply: true, fetchImpl }).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/customer-secret|synthetic-management-secret|synthetic-github-secret/);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(writes(fetchImpl.mock.calls)).toHaveLength(1);
  });

  it('fails instead of reporting applied when the committed state cannot be independently verified', async () => {
    const fetchImpl = successfulApplyFetch();
    fetchImpl.mockReset()
      .mockResolvedValueOnce(reply([{ snapshot: snapshot() }]))
      .mockResolvedValueOnce(reply({ object: { sha: revision } }))
      .mockResolvedValueOnce(reply({ revision }))
      .mockResolvedValueOnce(reply({ object: { sha: revision } }))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([{ snapshot: snapshot() }]));
    await expect(runAppLockRelease({ ...options, apply: true, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(writes(fetchImpl.mock.calls)).toHaveLength(1);
  });

  it('keeps the migration and its exact ledger record inside one transaction without replaying the held chain', () => {
    const sql = buildAppLockReleaseSql(file, otherLedgerHash);
    expect(sql.trim()).toMatch(/^begin;/i);
    expect(sql.trim()).toMatch(/commit;$/i);
    expect(sql).toContain('public.app_lock_credentials');
    expect(sql).toContain('supabase_migrations.schema_migrations');
    expect(sql).toContain(VERSION);
    expect(sql).toContain(NAME);
    // The ledger stores the exact checked source, including its original
    // envelope. Its checksum is verified by the reader on the next run.
    expect(sql).toContain(file.sql.replaceAll("'", "''"));
    expect(sql).toContain(otherLedgerHash);
    const beforeLedger = sql.slice(0, sql.lastIndexOf('insert into supabase_migrations.schema_migrations'));
    expect(beforeLedger.match(/^begin;\s*$/gim)).toHaveLength(1);
    expect(beforeLedger).not.toMatch(/^commit;\s*$/im);
    expect(sql).not.toMatch(/production-forward-release|0240_closet|0254_|0487_|drop schema|truncate table|migration repair/i);
  });

  it('checks the rejection function body as well as its name and grants when proving an existing release', () => {
    const body = /create function public\.reject_app_lock_preferences\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/.exec(file.sql)?.[1];
    expect(body).toBeDefined();
    const sourceHash = createHash('sha256').update(body!).digest('hex');
    expect(VERIFICATION_SQL).toContain(sourceHash);
    expect(VERIFICATION_SQL).toMatch(/sha256\(convert_to\(prosrc,'UTF8'\)\)/);
    expect(VERIFICATION_SQL).toContain('plpgsql');
  });

  it('does not claim success if unrelated migration history changes during the release', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply([{ snapshot: snapshot() }]))
      .mockResolvedValueOnce(reply({ object: { sha: revision } }))
      .mockResolvedValueOnce(reply({ revision }))
      .mockResolvedValueOnce(reply({ object: { sha: revision } }))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([{ snapshot: { ...applied(), otherLedgerHash: 'b'.repeat(64) } }]));
    await expect(runAppLockRelease({ ...options, apply: true, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(writes(fetchImpl.mock.calls)).toHaveLength(1);
  });

  it.each(['redirect', 'oversized', 'invalid-json', 'http-error', 'transport-error'] as const)(
    'refuses a %s database metadata response without exposing its contents or writing', async failure => {
      const secret = `customer-private ${options.token}`;
      const fetchImpl = vi.fn();
      if (failure === 'transport-error') fetchImpl.mockRejectedValueOnce(new Error(secret));
      else {
        const response = failure === 'oversized' ? new Response(JSON.stringify(secret.repeat(5_000)))
          : failure === 'invalid-json' ? new Response(secret)
            : failure === 'http-error' ? new Response(secret, { status: 500 })
              : reply([{ snapshot: snapshot() }]);
        if (failure === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
        fetchImpl.mockResolvedValueOnce(response);
      }
      const error = await runAppLockRelease({ ...options, apply: true, fetchImpl }).catch((cause: Error) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(/customer-private|synthetic-management-secret/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(writes(fetchImpl.mock.calls)).toHaveLength(0);
    },
  );

  it('keeps the workflow manual, default read-only, serialized, and bound to a checked-out main revision', () => {
    const workflow = readFileSync('.github/workflows/app-lock-private-storage-release.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s+(?:push|pull_request|schedule):/m);
    expect(workflow).toMatch(/apply:\s+description: [^\n]+\s+type: boolean\s+default: false/);
    expect(workflow).toMatch(/expected_revision:\s+description: [^\n]+\s+type: string\s+required: true/);
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('group: supabase-production-migrations');
    expect(workflow).toContain('cancel-in-progress: false');
    const actions = [...workflow.matchAll(/uses: (actions\/[^\s]+)@([^\s]+)/g)];
    expect(actions).toHaveLength(3);
    for (const action of actions) expect(action[2]).toMatch(/^[a-f0-9]{40}$/);
    expect(workflow).toMatch(/uses: actions\/checkout@[a-f0-9]{40}[^\n]*\n\s+with:\n\s+persist-credentials: false/);
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).toContain('[[ "$GITHUB_SHA" == "$EXPECTED_REVISION" ]]');
    expect(workflow).toContain('[[ "$(git rev-parse HEAD)" == "$EXPECTED_REVISION" ]]');
    expect(workflow).toContain('if [[ "$APPLY_APP_LOCK" == true ]]; then');
    expect(workflow).not.toMatch(/db push|--include-all|migration repair|apply-production-forward-release|SUPABASE_SERVICE_ROLE_KEY/);
  });
});
