import { describe, expect, it } from 'vitest';
import { moneyWriteVerdict } from '../scripts/audit-production-migration-state.mjs';

const table = 'wallet_transactions';
const policy = (name: string, command: string, permissive: boolean, managerGated: boolean, roles = ['authenticated']) => ({ table, name, command, permissive, managerGated, roles });
const verdict = (moneyWritePolicies: ReturnType<typeof policy>[]) => moneyWriteVerdict({ tables: [{ name: table, rls: true }], moneyWritePolicies });

describe('money policy guards cover the actual write command and audience', () => {
  it.each(['UPDATE', 'DELETE'])('an INSERT guard does not close %s', command => {
    const result = verdict([policy('open', command, true, false), policy('insert_only', 'INSERT', false, true)]);
    expect(result.exploitable).toBe(true);
    expect(result.unguarded).toContain(table);
  });

  it('requires every command of a permissive ALL policy to have a manager guard', () => {
    expect(verdict([policy('open', 'ALL', true, false), policy('insert_only', 'INSERT', false, true)]).exploitable).toBe(true);
    expect(verdict([policy('open', 'ALL', true, false), ...['INSERT', 'UPDATE', 'DELETE'].map(command => policy(command, command, false, true))]).exploitable).toBe(false);
  });

  it('does not count a restrictive policy that does not require a manager', () => {
    expect(verdict([policy('open', 'INSERT', true, false), policy('using_true', 'INSERT', false, false)]).exploitable).toBe(true);
  });

  it('does not count a guard for a different role', () => {
    expect(verdict([policy('public_open', 'INSERT', true, false, ['public']), policy('authenticated_only', 'INSERT', false, true)]).exploitable).toBe(true);
    expect(verdict([policy('auth_open', 'INSERT', true, false), policy('all_roles_guard', 'INSERT', false, true, ['public'])]).exploitable).toBe(false);
  });

  it('keeps manager-only writes closed without requiring a redundant restrictive guard', () => {
    expect(verdict([policy('manager_insert', 'INSERT', true, true)]).exploitable).toBe(false);
  });
});
