import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/modules/finances-module.tsx', 'utf8');

describe('finances read boundary', () => {
  it('coordinates all financial reads before deriving summary metrics', () => {
    expect(source).toContain('error: accountsError, refresh: refreshAccounts');
    expect(source).toContain('error: txnsError, refresh: refreshTxns');
    expect(source).toContain('error: budgetsError, refresh: refreshBudgets');
    expect(source).toContain('error: billsError, refresh: refreshBills');
    expect(source).toContain('error: goalsError, refresh: refreshGoals');
    expect(source).toContain('Could not load financial data. Refresh and try again.');
    expect(source).toContain('void refreshAccounts(); void refreshTxns(); void refreshBudgets(); void refreshBills(); void refreshGoals();');
  });
});
