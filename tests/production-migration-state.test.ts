import { at } from './helpers/source-order';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG_QUERY, MONEY_TABLES, baselineBlockedMessage, hasUnrecordedBaseline, moneyWriteVerdict, readProductionMigrationState } from '../scripts/audit-production-migration-state.mjs';

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
    expect(guard).toBeLessThan(at(workflow, 'run: supabase db push --yes'));
    expect(workflow).toContain('if: always()');
    const audit = readFileSync('.github/workflows/supabase-schema-audit.yml', 'utf8');
    expect(audit).not.toContain('db push');
    expect(audit).not.toContain('migration repair');
  });

  it('defaults production verification to read-only, including dependency pushes', () => {
    const workflow = readFileSync('.github/workflows/supabase-production-migrations.yml', 'utf8');
    expect(workflow).toMatch(/workflow_dispatch:\s+inputs:\s+apply:\s+description: [^\n]+\s+type: boolean\s+default: false/);
    // Retain automatic verification when dependencies or migration sources change.
    expect(workflow).toContain("- 'package.json'");
    expect(workflow).toContain("- 'package-lock.json'");
    expect(workflow).toContain("- 'supabase/migrations/**'");
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('environment: production');
    expect(workflow).not.toContain('continue-on-error: true');
  });

  it('requires a successful explicit manual apply for every production mutation step', () => {
    const workflow = readFileSync('.github/workflows/supabase-production-migrations.yml', 'utf8');
    const steps = workflow.split(/^      - /m).slice(1);
    const writes = steps.filter(step => /(?:^        run: |^          )(?:supabase (?:db push|migration (?:repair|up))|(?:npm run|node) [^\n]*--apply|psql\b)/m.test(step));
    expect(writes.map(step => step.match(/^name: (.+)/)?.[1])).toEqual([
      'Apply ordered migrations',
      'Backfill and enforce media provenance',
      'Backfill canonical marketing pages',
      'Backfill blog image provenance',
      'Reconcile canonical SEO and AEO coverage',
    ]);
    for (const step of writes) {
      // The typed boolean excludes omitted/false inputs, event check excludes
      // pushes, and success() retains the ledger/failure/cancellation boundary.
      expect(step.match(/^        if: (.+)$/m)?.[1].trim()).toBe(
        "success() && github.event_name == 'workflow_dispatch' && inputs.apply == true",
      );
    }
    const verification = steps.filter(step => /^name: (?:Audit|Verify|Report|Link)/.test(step));
    expect(verification).toHaveLength(10);
    for (const step of verification) expect(step).not.toMatch(/^        if:/m);
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
    { table: 'wallet_transactions', name: 'wallet_transactions_mng_insert', command: 'INSERT', roles: ['authenticated'], permissive: true, managerGated: true },
    { table: 'wallet_transactions', name: 'drifted_in', command: 'INSERT', roles: ['authenticated'], permissive: true, managerGated: false },
    { table: 'wallet_transactions', name: 'wallet_transactions_manager_insert_guard', command: 'INSERT', roles: ['authenticated'], permissive: false, managerGated: true },
  ];
  // The real shape of production before 0275: right name, wrong rule, no guard.
  const unguardedTable = [
    { table: 'bills', name: 'bills_insert', command: 'INSERT', roles: ['authenticated'], permissive: true, managerGated: false },
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
      { table: 'bills', name: 'bills_insert', command: 'INSERT', roles: ['authenticated'], permissive: true, managerGated: true },
      { table: 'bills', name: 'bills_manager_insert_guard', command: 'INSERT', roles: ['authenticated'], permissive: false, managerGated: true },
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
    expect(CATALOG_QUERY).toContain("in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)')");
    expect(CATALOG_QUERY).not.toContain("like '%can_manage_family%'");
    expect(CATALOG_QUERY).toContain("'roles'");
    expect(CATALOG_QUERY).toContain("'moneyWritePolicies'");
    expect(CATALOG_QUERY).not.toMatch(/'usingExpr'|'checkExpr'|'qual',\s*qual/);
  });

  it('includes allowance_rules in automated and hand-run money inventories', () => {
    const boundary = readFileSync('docs/audit/money-boundary-state.sql', 'utf8');
    const diagnostic = readFileSync('docs/audit/money-policy-diagnostic.sql', 'utf8');
    expect(MONEY_TABLES).toContain('allowance_rules');
    expect(CATALOG_QUERY).toContain("'wallet_rules','allowance_rules'");
    expect(boundary).toContain("('wallet_rules'),('allowance_rules')");
    expect(diagnostic).toContain("'wallet_rules','allowance_rules'");
  });
});

// Two states reported as CLEAN by a policy-only rule. Both were reachable by
// this verdict for as long as it existed, and §0 of the runbook glossed the
// result as a stronger guarantee than the data supported.
describe('money write verdict — the states a policy-only rule cannot see', () => {
  const tables = (over: Record<string, boolean> = {}) =>
    MONEY_TABLES
      .map((name) => ({ name, rls: over[name] ?? true }));

  const gated = (table: string) => ([
    { table, name: `${table}_mng_insert`, command: 'INSERT', roles: ['authenticated'], permissive: true, managerGated: true },
    { table, name: `${table}_manager_insert_guard`, command: 'INSERT', roles: ['authenticated'], permissive: false, managerGated: true },
  ]);

  // 1. RLS off. Every policy below it is inert.
  it('calls a table with RLS disabled open, even with guards and no ungated write', () => {
    const verdict = moneyWriteVerdict({
      tables: tables({ family_wallets: false }),
      moneyWritePolicies: gated('family_wallets'),
    });
    // Exactly the shape that reads clean on policies alone:
    expect(verdict.openWrites).toEqual([]);
    expect(verdict.unguarded).toEqual([]);
    // ...and is open in fact.
    expect(verdict.rlsDisabled).toEqual(['family_wallets']);
    expect(verdict.exploitable).toBe(true);
    expect(verdict.verdicts.family_wallets).toBe('OPEN - RLS DISABLED');
  });

  // 2. No write policy at all. Closed — but by decision, not by omission.
  it('reports a table with no write policy rather than leaving it out', () => {
    const verdict = moneyWriteVerdict({ tables: tables(), moneyWritePolicies: gated('bills') });
    expect(verdict.noWritePolicy).toContain('wallet_transactions');
    expect(verdict.verdicts.wallet_transactions).toBe('CLOSED - RLS on, no write policy grants access');
    expect(verdict.exploitable).toBe(false);
  });

  // The gloss that started this: `unguarded: []` never meant "every table has a
  // guard", only "no table that HAS a write policy lacks one".
  it('does not let an empty unguarded list imply every table is guarded', () => {
    const verdict = moneyWriteVerdict({ tables: tables(), moneyWritePolicies: gated('bills') });
    expect(verdict.unguarded).toEqual([]);
    expect(verdict.noWritePolicy.length).toBeGreaterThan(0); // the rest are not "guarded"
  });

  it('detects the 0088 allowance open write until the 0306 guards are present', () => {
    const allowanceWrite = {
      table: 'allowance_rules', name: 'Members manage allowance_rules', command: 'ALL',
      roles: ['authenticated'], permissive: true, managerGated: false,
    };
    const before0306 = moneyWriteVerdict({ tables: tables(), moneyWritePolicies: [allowanceWrite] });
    expect(before0306.openWrites).toEqual(['allowance_rules.Members manage allowance_rules (ALL)']);
    expect(before0306.unguarded).toEqual(['allowance_rules']);
    expect(before0306.exploitable).toBe(true);
    expect(before0306.verdicts.allowance_rules).toBe('OPEN - non-manager can write');

    const guards0306 = ['INSERT', 'UPDATE', 'DELETE'].map((command) => ({
      table: 'allowance_rules', name: `allowance_rules_manager_${command.toLowerCase()}_guard`,
      command, roles: ['authenticated'], permissive: false, managerGated: true,
    }));
    const after0306 = moneyWriteVerdict({ tables: tables(), moneyWritePolicies: [allowanceWrite, ...guards0306] });
    expect(after0306.openWrites).toEqual(['allowance_rules.Members manage allowance_rules (ALL)']);
    expect(after0306.unguarded).toEqual([]);
    expect(after0306.exploitable).toBe(false);
    expect(after0306.verdicts.allowance_rules).toBe('closed by restrictive guard');
  });

  // This is a synthetic representation of the dated 2026-09-11 production
  // evidence. The then-current inventory contained ten tables and omitted
  // allowance_rules; it cannot establish that table's 0306 guards in production.
  it('keeps the historical ten-table production reading from implying allowance coverage', () => {
    const historicalTables = MONEY_TABLES.filter((table) => table !== 'allowance_rules');
    const rows = historicalTables.flatMap(gated);
    const verdict = moneyWriteVerdict({
      tables: historicalTables.map((name) => ({ name, rls: true })),
      moneyWritePolicies: rows,
    });
    expect(verdict.exploitable).toBe(false);
    expect(verdict.rlsDisabled).toEqual([]);
    expect(verdict.absent).toEqual(['allowance_rules']);
    expect(verdict.verdicts.allowance_rules).toBe('table absent');
    expect(historicalTables.every((table) => String(verdict.verdicts[table]).startsWith('CLOSED'))).toBe(true);
  });

  // A snapshot taken before the table list existed cannot answer the RLS
  // question. Saying "on" would invent a guarantee; saying "off" would invent a
  // finding. It says neither.
  it('does not guess about RLS when the snapshot cannot tell it', () => {
    const verdict = moneyWriteVerdict({ moneyWritePolicies: gated('bills') });
    expect(verdict.rlsKnown).toBe(false);
    expect(verdict.rlsDisabled).toEqual([]);
    expect(verdict.exploitable).toBe(false);
  });

  it('distinguishes a table that is absent from one that is unguarded', () => {
    const verdict = moneyWriteVerdict({
      tables: tables().filter((t) => t.name !== 'wallet_rules'),
      moneyWritePolicies: gated('bills'),
    });
    expect(verdict.absent).toEqual(['wallet_rules']);
    expect(verdict.unguarded).not.toContain('wallet_rules');
    expect(verdict.verdicts.wallet_rules).toBe('table absent');
  });
});
