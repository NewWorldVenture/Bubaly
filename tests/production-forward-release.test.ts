import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertPreflight, assertReleased, buildReleaseSql, readReleaseFiles, releaseLedger, runForwardRelease } from '../scripts/apply-production-forward-release.mjs';

const manifest = JSON.parse(readFileSync('supabase/production-forward-release.json', 'utf8'));
const files = readReleaseFiles(manifest);
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
  policies: [...manifest.policyTables, 'ai_requests'].map((table: string) => ({
    table, name: table + '_insert', command: 'INSERT', roles: ['authenticated'], checkHash: 'non-empty-reviewed-check',
  })),
});
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 201 });

describe('reviewed production forward release', () => {
  it('pins precisely 0240-0252 and normalizes checkout line endings', () => {
    expect(files).toHaveLength(13);
    expect(files[0].version).toBe('0240');
    expect(files.at(-1)?.version).toBe('0252');
    expect(readReleaseFiles(manifest, (file: string) => readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'))).toEqual(files);
    expect(() => readReleaseFiles(manifest, () => 'changed migration')).toThrow('checksum changed');
    expect(() => readReleaseFiles({ ...manifest, projectRef: 'wrong-project' })).toThrow('pinned');
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
    expect(sql.match(/insert into supabase_migrations.schema_migrations\(/g)).toHaveLength(13);
    for (const file of files) expect(sql).toContain(file.sql);
    expect(sql).not.toMatch(/migration repair|--include-all|drop schema|truncate table/i);
    expect(sql).toContain('AI worker RPC permissions are incorrect');
  });

  it('defaults to metadata-only preview and rejects the wrong project before network access', async () => {
    const before = snapshot();
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: before }])).mockResolvedValueOnce(reply(before.migrations));
    const result = await runForwardRelease({ manifest, files, projectRef: manifest.projectRef, token: 'test-token', fetchImpl });
    expect(result.status).toBe('preview');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) expect(JSON.parse(call[1].body).read_only).toBe(true);
    await expect(runForwardRelease({ manifest, files, projectRef: 'wrong', token: 'test-token', fetchImpl })).rejects.toThrow('audited Bubaly');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('applies once and independently confirms the final ledger and protected tables', async () => {
    const before = snapshot(), after = released();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply([{ snapshot: before }])).mockResolvedValueOnce(reply(before.migrations))
      .mockResolvedValueOnce(reply({}))
      .mockResolvedValueOnce(reply([{ snapshot: after }])).mockResolvedValueOnce(reply(after.migrations));
    const result = await runForwardRelease({ manifest, files, projectRef: manifest.projectRef, token: 'test-token', apply: true, fetchImpl });
    expect(result.status).toBe('applied');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).read_only).toBe(false);
    expect(fetchImpl.mock.calls[2][1].redirect).toBe('error');
    expect(() => assertReleased({ ...after, policies: [] }, manifest)).toThrow('INSERT security');
  });

  it('does not replay a completed release', async () => {
    const after = released();
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: after }])).mockResolvedValueOnce(reply(after.migrations));
    expect((await runForwardRelease({ manifest, files, projectRef: manifest.projectRef, token: 'test-token', apply: true, fetchImpl })).status).toBe('already_applied');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never automatically retries an ambiguous mutation or exposes private error details', async () => {
    for (const uncertain of [true, false]) {
      const before = snapshot();
      const fetchImpl = vi.fn().mockResolvedValueOnce(reply([{ snapshot: before }])).mockResolvedValueOnce(reply(before.migrations));
      if (uncertain) fetchImpl.mockRejectedValueOnce(new Error('test-token private detail'));
      else fetchImpl.mockResolvedValueOnce(new Response('ERROR: 42703: private family data test-token', { status: 400 }));
      const error = await runForwardRelease({ manifest, files, projectRef: manifest.projectRef, token: 'test-token', apply: true, fetchImpl }).catch((e: Error) => e);
      if (!(error instanceof Error)) throw new Error('Expected the production release to fail.');
      expect(error.message).toMatch(/uncertain|SQLSTATE 42703/);
      expect(error.message).not.toMatch(/private family data|test-token/i);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    }
  });
});
