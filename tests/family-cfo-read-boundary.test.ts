import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-cfo/page.tsx', 'utf8');

// PLA-0776: Family CFO is a money surface that advertises "every figure is
// live". If any of its five financial reads (accounts, bills, savings goals,
// transactions, budgets) fails, it must fail closed — never render Net position
// $0 / "Due in 30 days $0" / no goals, a reassuring-but-wrong financial picture
// a family could act on (miss a bill, assume savings vanished). A genuinely
// missing table (unapplied migration) is still tolerated as empty.
describe('family-cfo page read boundary', () => {
  it('collects the five finance read errors with a missing-table filter', () => {
    expect(page).toContain('const financeError = [accountsRes.error, billsRes.error, goalsRes.error, spendRes.error, budgetsRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a finance read failure', () => {
    expect(page).toContain('if (financeError) {');
    expect(page).toContain("console.error('[dashboard/family-cfo] finance read failed', financeError);");
    expect(page).toContain('return <ErrorState message="Could not load your family finances from Supabase. Refresh and try again." />;');
  });

  it('derives the finance data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (financeError) {');
    const deriveIdx = page.indexOf('const accounts = accountsRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
