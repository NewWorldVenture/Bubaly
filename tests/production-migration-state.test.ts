import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG_QUERY, hasUnrecordedBaseline, readProductionMigrationState } from '../scripts/audit-production-migration-state.mjs';

const projectRef = 'abcdefghijklmnopqrst';
const token = 'test-management-token';
const policy = { table: 'profiles', name: 'profiles_insert_self' };

describe('production schema and migration history audit', () => {
  it('blocks replay when an existing baseline has not been recorded', () => {
    expect(hasUnrecordedBaseline({ policies: [policy], migrations: [] })).toBe(true);
    expect(hasUnrecordedBaseline({ policies: [policy], migrations: [{ version: '0003' }] })).toBe(true);
    expect(hasUnrecordedBaseline({ policies: [policy], migrations: [{ version: '0004' }] })).toBe(false);
    expect(hasUnrecordedBaseline({ policies: [], migrations: [] })).toBe(false);
  });

  it('uses read-only requests, deadlines and no redirects for both metadata queries', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{ snapshot: { hasMigrationLedger: true, tables: [], policies: [policy] } }]))
      .mockResolvedValueOnce(Response.json([{ version: '0003', name: 'functions_triggers' }]));
    const state = await readProductionMigrationState({ projectRef, token, fetchImpl });
    expect(hasUnrecordedBaseline(state)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [resource, options] of fetchImpl.mock.calls) {
      expect(String(resource)).toBe(`https://api.supabase.com/v1/projects/${projectRef}/database/query`);
      expect(JSON.parse(String(options?.body))).toMatchObject({ read_only: true });
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('does not query a nonexistent migration ledger', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      { snapshot: { hasMigrationLedger: false, tables: [], policies: [] } },
    ]));
    const state = await readProductionMigrationState({ projectRef, token, fetchImpl });
    expect(state.migrations).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or malformed connection configuration before making requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(readProductionMigrationState({ projectRef: '../other', token, fetchImpl })).rejects.toThrow('required');
    await expect(readProductionMigrationState({ projectRef, token: '', fetchImpl })).rejects.toThrow('required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not echo provider errors or credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`private ${token}`, { status: 403 }));
    await expect(readProductionMigrationState({ projectRef, token, fetchImpl })).rejects.toThrow('HTTP 403');
    fetchImpl.mockRejectedValue(new Error(token));
    await expect(readProductionMigrationState({ projectRef, token, fetchImpl })).rejects.toThrow('metadata request failed');
  });

  it('reads catalogs, not household data or arbitrary function bodies', () => {
    expect(CATALOG_QUERY).not.toMatch(/from\s+(public\.|auth\.|vault\.)/i);
    expect(CATALOG_QUERY).toContain("p.proname in");
    expect(CATALOG_QUERY).toContain('definitionHash');
  });

  it('puts the replay guard before db push and retains an audit on failure', () => {
    const workflow = readFileSync('.github/workflows/supabase-production-migrations.yml', 'utf8');
    const guard = workflow.indexOf('node scripts/audit-production-migration-state.mjs --enforce-history');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(workflow.indexOf('run: supabase db push --yes'));
    expect(workflow).toContain('if: always()');
    const audit = readFileSync('.github/workflows/supabase-schema-audit.yml', 'utf8');
    expect(audit).not.toContain('db push');
    expect(audit).not.toContain('migration repair');
  });
});
