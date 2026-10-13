import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/modules/finances-module.tsx', 'utf8');

describe('finances read boundary', () => {
  it('coordinates all financial reads before deriving summary metrics', () => {
    expect(source).toContain('error: accountsError, refresh: refreshAccounts');
    expect(source).toContain('error: txnsError, refresh: refreshTxns');
    // The month's figures have their own whole read (M13-SIB-FIN-CAP): its
    // failure is the screen's error, and a retry re-reads it too.
    expect(source).toContain('error: monthTxnsError, refresh: refreshMonthTxns');
    expect(source).toContain('const readError = accountsError || txnsError || monthTxnsError || budgetsError || billsError || goalsError;');
    expect(source).toContain('onRetry={() => { void refreshMonthTxns(); void refreshAccounts();');
    expect(source).toContain('error: budgetsError, refresh: refreshBudgets');
    expect(source).toContain('error: billsError, refresh: refreshBills');
    expect(source).toContain('error: goalsError, refresh: refreshGoals');
    expectSays(source, 'financesModule.couldNotLoadFinancialData', 'Could not load financial data. Refresh and try again.');
    expect(source).toContain('void refreshAccounts(); void refreshTxns(); void refreshBudgets(); void refreshBills(); void refreshGoals();');
  });
});

