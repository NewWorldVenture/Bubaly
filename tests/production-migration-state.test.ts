import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG_QUERY, baselineBlockedMessage, hasUnrecordedBaseline, moneyWriteVerdict, readProductionMigrationState } from '../scripts/audit-production-migration-state.mjs';

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

// Every other policy in the snapshot is reported as md5(qual)/md5(with_check).
// On the money tables that produced a loop: a reader could see "permissive
// INSERT policy on wallet_transactions" and could not see whether it required
// manager role, because a hash of can_manage_family and a hash of
// is_family_member are equally opaque — and those two differ by whether a child
// can mint money. The only safe response was to escalate, which is what
// happened, three releases running. moneyWriteVerdict resolves the one bit that
// decides it.
describe('money write verdict', () => {
  const guardedTableWithDrift = [
    { table: 'wallet_transactions', name: 'wallet_transactions_mng_insert', command: 'INSERT', permissive: true, managerGated: true },
    { table: 'wallet_transactions', name: 'drifted_in', command: 'INSERT', permissive: true, managerGated: false },
    { table: 'wallet_transactions', name: 'wallet_transactions_manager_insert_guard', command: 'INSERT', permissive: false, managerGated: true },
  ];
  // The real shape of production before 0275: right name, wrong rule, no guard.
  const unguardedTable = [
    { table: 'bills', name: 'bills_insert', command: 'INSERT', permissive: true, managerGated: false },
  ];

  it('separates a finding that is reportable from one that is exploitable', () => {
    // The wallet case: a stray permissive policy, but a restrictive guard ANDs
    // against it, so a child still cannot write. Worth reporting, not worth
    // halting a release over — which is the whole point of LB-016.
    const guarded = moneyWriteVerdict({ moneyWritePolicies: guardedTableWithDrift });
    expect(guarded.openWrites).toEqual(['wallet_transactions.drifted_in (INSERT)']);
    expect(guarded.unguarded).toEqual([]);
    expect(guarded.exploitable).toBe(false);

    // The finance case: an open write on a table with no backstop at all.
    const open = moneyWriteVerdict({ moneyWritePolicies: [...guardedTableWithDrift, ...unguardedTable] });
    expect(open.unguarded).toEqual(['bills']);
    expect(open.exploitable).toBe(true);
  });

  it('is quiet when every write is manager-gated', () => {
    const clean = moneyWriteVerdict({ moneyWritePolicies: [
      { table: 'bills', name: 'bills_insert', command: 'INSERT', permissive: true, managerGated: true },
      { table: 'bills', name: 'bills_manager_insert_guard', command: 'INSERT', permissive: false, managerGated: true },
    ] });
    expect(clean).toMatchObject({ openWrites: [], unguarded: [], exploitable: false });
  });

  it('points at the runbook instead of leaving the reader to re-derive it', () => {
    expect(moneyWriteVerdict({ moneyWritePolicies: [] }).runbook)
      .toBe('docs/runbooks/LB-016-wallet-permissive-policy-finding.md');
  });

  // Three releases stopped at the ledger gate and each responder read this
  // failure as the wallet finding coming back. They are different problems that
  // surface in the same red check, so the message has to say which one it is.
  it('separates the ledger blocker from the money boundary and names the runbook', () => {
    const runbook = moneyWriteVerdict({ moneyWritePolicies: [] }).runbook;
    const message = baselineBlockedMessage(runbook);
    expect(message).toContain('no recorded baseline migration 0004');
    expect(message).toContain('Historical replay is blocked');
    expect(message).toContain('NOT the money boundary');
    expect(message).toContain(`${runbook} §4`);
  });

  it('asks the database for the manager-gated bit without exporting any expression', () => {
    // The hashing posture for every other policy must not regress: this adds a
    // boolean, not policy text.
    expect(CATALOG_QUERY).toContain("like '%can_manage_family%'");
    expect(CATALOG_QUERY).toContain("'moneyWritePolicies'");
    expect(CATALOG_QUERY).not.toMatch(/'usingExpr'|'checkExpr'|'qual',\s*qual/);
  });
});
