import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertNoNewerMigrations, releaseRangeOf, releaseVersionsOf, assertPreflight, assertReleased, buildReleaseSql, readReleaseFiles, releaseLedger, releaseModeFromArgs, runForwardRelease } from '../scripts/apply-production-forward-release.mjs';

const manifest = JSON.parse(readFileSync('supabase/production-forward-release.json', 'utf8'));
const files = readReleaseFiles(manifest);
// Existing release-behavior tests model only the reviewed bundle, not newer repository work.
const listReviewedMigrationFiles = () => manifest.migrations.map(({ file }: { file: string }) => file);
const snapshot = () => ({
  hasMigrationLedger: true,
  migrations: structuredClone(manifest.baseline),
  tables: manifest.requiredTables.map((name: string) => ({ name, rls: true })),
  ...structuredClone(manifest.boundary),
});
const released = () => ({
  ...snapshot(),
  migrations: releaseLedger(manifest),
  tables: [...manifest.requiredTables, ...manifest.newTables].map((name: string) => ({ name, rls: true })),
  workerRpc: { exists: true, anonymousExecute: false, authenticatedExecute: false, serviceExecute: true },
  policies: [...[...manifest.policyTables, 'ai_requests'].map((table: string) => ({
    table, name: table + '_insert', command: 'INSERT', roles: ['authenticated'], checkHash: 'non-empty-reviewed-check',
  })), ...manifest.walletTables.flatMap((table: string) => ['INSERT', 'UPDATE', 'DELETE'].map((command) => ({
    table, name: table + '_manager_' + command.toLowerCase() + '_guard', command,
    roles: ['authenticated'], permissive: 'RESTRICTIVE',
  })))],
});
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 201 });

describe('reviewed production forward release', () => {
  it('parses read-only proof separately from apply and rejects ambiguous or unknown options', () => {
    expect(releaseModeFromArgs([])).toEqual({ apply: false, requireApplied: false });
    expect(releaseModeFromArgs(['--apply'])).toEqual({ apply: true, requireApplied: false });
    expect(releaseModeFromArgs(['--require-applied'])).toEqual({ apply: false, requireApplied: true });
    expect(() => releaseModeFromArgs(['--apply', '--require-applied'])).toThrow('cannot be combined');
    expect(() => releaseModeFromArgs(['--require-applied=true'])).toThrow('Unknown release option');
  });

  it('rejects conflicting proof/apply options before inventory or database access', async () => {
    const fetchImpl = vi.fn();
    const listMigrationFiles = vi.fn(listReviewedMigrationFiles);
    await expect(runForwardRelease({
      manifest, files, projectRef: manifest.projectRef, token: 'test-token',
      apply: true, requireApplied: true, fetchImpl, listMigrationFiles,
    })).rejects.toThrow('cannot be combined');
    expect(listMigrationFiles).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps applied-proof mode held before database access when newer migrations are unreviewed', async () => {
    const fetchImpl = vi.fn();
    await expect(runForwardRelease({
      manifest, files, projectRef: manifest.projectRef, token: 'test-token', requireApplied: true, fetchImpl,
      listMigrationFiles: () => [...listReviewedMigrationFiles(), '0255_ai_runtime_lockdown.sql', '0261_unreviewed.sql'],
    })).rejects.toThrow('outside the pinned 0240-0254 release');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed if inventory is unavailable in applied-proof mode', async () => {
    const fetchImpl = vi.fn();
    await expect(runForwardRelease({
      manifest, files, projectRef: manifest.projectRef, token: 'test-token', requireApplied: true, fetchImpl,
      listMigrationFiles: () => { throw new Error('Repository inventory unavailable'); },
    })).rejects.toThrow('Repository inventory unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['baseline', 'partial', 'unexpected'])('does not report applied proof for a %s ledger', async (state) => {
    const before = snapshot();
    if (state === 'partial') before.migrations.push(releaseLedger(manifest)[manifest.baseline.length]);
    if (state === 'unexpected') before.migrations.push({ version: '9999', name: 'unreviewed' });
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: before }])).mockResolvedValueOnce(reply(before.migrations));
    const error = await runForwardRelease({
      manifest, files, projectRef: manifest.projectRef, token: 'test-token', requireApplied: true, fetchImpl,
      listMigrationFiles: listReviewedMigrationFiles,
    }).catch((cause: Error) => cause);
    if (!(error instanceof Error)) throw new Error('Expected missing applied-release proof to fail.');
    expect(error.message).toContain('Reviewed release is not applied');
    expect(error.message).toContain('observed versions: 0001, 0002, 0003');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) expect(JSON.parse(call[1].body).read_only).toBe(true);
  });

  it('proves an exact completed release using only metadata reads', async () => {
    const after = released();
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: after }])).mockResolvedValueOnce(reply(after.migrations));
    const result = await runForwardRelease({
      manifest, files, projectRef: manifest.projectRef, token: 'test-token', requireApplied: true, fetchImpl,
      listMigrationFiles: listReviewedMigrationFiles,
    });
    expect(result.status).toBe('already_applied');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) expect(JSON.parse(call[1].body).read_only).toBe(true);
  });

  it('refuses applied proof when the recorded ledger lacks a required security postcondition', async () => {
    const after = released();
    after.workerRpc.authenticatedExecute = true;
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: after }])).mockResolvedValueOnce(reply(after.migrations));
    await expect(runForwardRelease({
      manifest, files, projectRef: manifest.projectRef, token: 'test-token', requireApplied: true, fetchImpl,
      listMigrationFiles: listReviewedMigrationFiles,
    })).rejects.toThrow('Released worker RPC grants were not confirmed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) expect(JSON.parse(call[1].body).read_only).toBe(true);
  });

  it('allows reviewed and historical filenames without replaying historical migrations', () => {
    expect(() => assertNoNewerMigrations([
      '0001_extensions_enums.sql', '0194_first.sql', '0194_second.sql',
      '0239_previous.sql', ...listReviewedMigrationFiles(), 'README.md',
    ], manifest)).not.toThrow();
  });

  it.each(['0255_ai_runtime_lockdown.sql', '0256_unreviewed.sql', '202609050001_future.sql'])(
    'holds the pinned bundle when a newer migration exists: %s', (file) => {
      expect(() => assertNoNewerMigrations([...listReviewedMigrationFiles(), file], manifest)).toThrow(file);
    },
  );

  it.each([false, true])('rejects newer migrations before any database access, apply=%s', async (apply) => {
    const after = released();
    // Even a completed-release response must never be requested under an obsolete bundle.
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: after }])).mockResolvedValueOnce(reply(after.migrations));
    const listMigrationFiles = vi.fn(() => [...listReviewedMigrationFiles(), '0255_ai_runtime_lockdown.sql']);
    await expect(runForwardRelease({
      manifest, files, projectRef: manifest.projectRef, token: 'test-token', apply, fetchImpl, listMigrationFiles,
    })).rejects.toThrow('0255_ai_runtime_lockdown.sql');
    expect(listMigrationFiles).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed before database access when repository inventory cannot be read', async () => {
    const fetchImpl = vi.fn();
    await expect(runForwardRelease({
      manifest, files, projectRef: manifest.projectRef, token: 'test-token', fetchImpl,
      listMigrationFiles: () => { throw new Error('Repository inventory unavailable'); },
    })).rejects.toThrow('Repository inventory unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pins exactly the range the manifest states, and normalizes checkout line endings', () => {
    // The range is asserted from the manifest rather than from a literal: that
    // duplication is what F-C08 was. The manifest currently pins 0240-0254.
    const pinned = manifest.migrations.map((m: { file: string }) => m.file.slice(0, 4)).sort();
    expect(files).toHaveLength(pinned.length);
    expect(files[0].version).toBe(pinned[0]);
    expect(files.at(-1)?.version).toBe(pinned.at(-1));
    expect(releaseRangeOf(manifest)).toBe(pinned[0] + '-' + pinned.at(-1));
    expect(readReleaseFiles(manifest, (file: string) => readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'))).toEqual(files);
    expect(() => readReleaseFiles(manifest, () => 'changed migration')).toThrow('checksum changed');
    expect(() => readReleaseFiles({ ...manifest, projectRef: 'wrong-project' })).toThrow('audited Bubaly production project');
  });

  // ── F-C08: re-pinning must be a manifest change, not a code change ────────
  //
  // The release range used to be hardcoded in three places in the script while
  // the manifest stated it again. The repository moved 38 migrations past the
  // pin, the guard fired correctly every run, and moving the pin meant editing
  // literals. These tests pin the property that made that necessary: the
  // manifest alone decides the range.
  describe('the manifest is the only statement of the pinned range', () => {
    const repinned = {
      ...manifest,
      migrations: [
        ...manifest.migrations,
        { file: '0255_ai_runtime_lockdown.sql', sha256: 'a847dae56371530be314aa9313c6b98a20c79053c1e9c2b4bb2c9d0108383903' },
      ],
    };

    it('accepts a re-pinned manifest with no code change, verifying the new checksum', () => {
      const extended = readReleaseFiles(repinned);
      expect(extended).toHaveLength(manifest.migrations.length + 1);
      expect(extended.at(-1)?.version).toBe('0255');
      expect(releaseRangeOf(repinned)).toBe('0240-0255');
      // The checksum is still real: corrupt the read and it must refuse.
      expect(() => readReleaseFiles(repinned, () => 'changed migration')).toThrow('checksum changed');
    });

    it('stops holding the release for a migration the re-pinned manifest now covers', () => {
      expect(() => assertNoNewerMigrations(
        [...listReviewedMigrationFiles(), '0255_ai_runtime_lockdown.sql'], manifest,
      )).toThrow('0255_ai_runtime_lockdown.sql');
      expect(() => assertNoNewerMigrations(
        [...listReviewedMigrationFiles(), '0255_ai_runtime_lockdown.sql'], repinned,
      )).not.toThrow();
    });

    it('names the range it is actually pinned to, and how to move it', () => {
      expect(() => assertNoNewerMigrations([...listReviewedMigrationFiles(), '0256_x.sql'], repinned))
        .toThrow('pinned 0240-0255 release');
      expect(() => assertNoNewerMigrations([...listReviewedMigrationFiles(), '0256_x.sql'], repinned))
        .toThrow('production-forward-release.json');
    });

    it('still requires a contiguous, duplicate-free range', () => {
      expect(() => releaseVersionsOf({ migrations: [
        { file: '0240_a.sql' }, { file: '0242_b.sql' },
      ] })).toThrow('contiguous');
      expect(() => releaseVersionsOf({ migrations: [
        { file: '0240_a.sql' }, { file: '0240_b.sql' },
      ] })).toThrow('duplicate');
      expect(() => releaseVersionsOf({ migrations: [] })).toThrow('pins no migrations');
    });

    it('still refuses a filename that could escape supabase/migrations', () => {
      for (const file of ['../../etc/passwd', '0240_a.sql/../../x', '0240-a.sql', '0240_A.sql']) {
        expect(() => readReleaseFiles({ ...manifest, migrations: [{ file, sha256: 'x' }] }))
          .toThrow();
      }
    });
  });

  it('requires the exact audited baseline and refuses partial or unrecorded releases', () => {
    expect(() => assertPreflight(snapshot(), manifest)).not.toThrow();
    const partial = snapshot();
    partial.migrations.push({ version: '0240', name: 'closet_outfits' });
    expect(() => assertPreflight(partial, manifest)).toThrow('partially applied');
    const existing = snapshot();
    existing.tables.push({ name: manifest.newTables[0], rls: true });
    expect(() => assertPreflight(existing, manifest)).toThrow('already exists');
  });

  it('refuses schema, policy, helper, or RLS drift', () => {
    for (const key of ['columns', 'constraints', 'policies', 'functions']) {
      const drift = snapshot();
      drift[key] = [];
      expect(() => assertPreflight(drift, manifest)).toThrow('catalog drift');
    }
    const drift = snapshot();
    drift.tables[0].rls = false;
    expect(() => assertPreflight(drift, manifest)).toThrow('protected table');
  });

  it('records only executed migrations inside one guarded transaction', () => {
    const sql = buildReleaseSql(manifest, files);
    expect(sql.startsWith('begin;')).toBe(true);
    expect(sql.endsWith('commit;')).toBe(true);
    expect(sql).toContain("lock_timeout = '5s'");
    expect(sql.indexOf('Release ledger changed')).toBeLessThan(sql.indexOf(files[0].sql));
    expect(sql.match(/insert into supabase_migrations.schema_migrations\(/g)).toHaveLength(15);
    for (const file of files) expect(sql).toContain(file.sql);
    expect(sql).not.toMatch(/migration repair|--include-all|drop schema|truncate table/i);
    expect(sql).toContain('AI worker RPC permissions are incorrect');
  });

  it('defaults to metadata-only preview and rejects the wrong project before network access', async () => {
    const before = snapshot();
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: before }])).mockResolvedValueOnce(reply(before.migrations));
    const result = await runForwardRelease({ manifest, files, projectRef: manifest.projectRef, token: 'test-token', fetchImpl, listMigrationFiles: listReviewedMigrationFiles });
    expect(result.status).toBe('preview');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) expect(JSON.parse(call[1].body).read_only).toBe(true);
    await expect(runForwardRelease({ manifest, files, projectRef: 'wrong', token: 'test-token', fetchImpl, listMigrationFiles: listReviewedMigrationFiles })).rejects.toThrow('audited Bubaly');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('applies once and independently confirms the final ledger and protected tables', async () => {
    const before = snapshot(), after = released();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply([{ snapshot: before }])).mockResolvedValueOnce(reply(before.migrations))
      .mockResolvedValueOnce(reply({}))
      .mockResolvedValueOnce(reply([{ snapshot: after }])).mockResolvedValueOnce(reply(after.migrations));
    const result = await runForwardRelease({ manifest, files, projectRef: manifest.projectRef, token: 'test-token', apply: true, fetchImpl, listMigrationFiles: listReviewedMigrationFiles });
    expect(result.status).toBe('applied');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).read_only).toBe(false);
    expect(fetchImpl.mock.calls[2][1].redirect).toBe('error');
    expect(() => assertReleased({ ...after, policies: [] }, manifest)).toThrow('INSERT security');
  });

  it('does not replay a completed release', async () => {
    const after = released();
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: after }])).mockResolvedValueOnce(reply(after.migrations));
    expect((await runForwardRelease({ manifest, files, projectRef: manifest.projectRef, token: 'test-token', apply: true, fetchImpl, listMigrationFiles: listReviewedMigrationFiles })).status).toBe('already_applied');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never automatically retries an ambiguous mutation or exposes private error details', async () => {
    for (const uncertain of [true, false]) {
      const before = snapshot();
      const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: before }])).mockResolvedValueOnce(reply(before.migrations));
      if (uncertain) fetchImpl.mockRejectedValueOnce(new Error('test-token private detail'));
      else fetchImpl.mockResolvedValueOnce(new Response('ERROR: 42703: private family data test-token', { status: 400 }));
      const error = await runForwardRelease({ manifest, files, projectRef: manifest.projectRef, token: 'test-token', apply: true, fetchImpl, listMigrationFiles: listReviewedMigrationFiles }).catch((e: Error) => e);
      if (!(error instanceof Error)) throw new Error('Expected the production release to fail.');
      expect(error.message).toMatch(/uncertain|SQLSTATE 42703/);
      expect(error.message).not.toMatch(/private family data|test-token/i);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    }
  });
});
