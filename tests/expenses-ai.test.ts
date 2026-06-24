import { describe, expect, it } from 'vitest';
import {
  analyzeExpenses,
  buildExpensesPrompt,
  parseExpensesResponse,
  type ExpenseEntryLike,
} from '@/lib/finance/expenses-ai';

function expense(overrides: Partial<ExpenseEntryLike> = {}): ExpenseEntryLike {
  return { description: 'Groceries', total_cents: 5000, category: 'Groceries', spent_on: '2026-06-20', ...overrides };
}

describe('analyzeExpenses', () => {
  it('summarizes expenses', () => {
    const r = analyzeExpenses([
      expense({ total_cents: 5000, category: 'Groceries' }),
      expense({ total_cents: 3000, category: 'Dining' }),
      expense({ total_cents: 2000, category: 'Groceries' }),
    ]);
    expect(r.totalExpenses).toBe(3);
    expect(r.totalSpentCents).toBe(10000);
    expect(r.categoryCounts['Groceries']).toBe(2);
    expect(r.categoryCounts['Dining']).toBe(1);
    expect(r.summary).toContain('3 expenses');
    expect(r.summary).toContain('$100 total');
  });

  it('handles null category as Other', () => {
    const r = analyzeExpenses([expense({ category: null })]);
    expect(r.categoryCounts['Other']).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeExpenses([]);
    expect(r.totalExpenses).toBe(0);
    expect(r.totalSpentCents).toBe(0);
  });
});

describe('buildExpensesPrompt', () => {
  it('builds prompt with expense info', () => {
    const { system, user } = buildExpensesPrompt([expense({ description: 'Dinner out' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Dinner out');
  });
});

describe('parseExpensesResponse', () => {
  it('parses valid JSON', () => {
    const r = parseExpensesResponse('{"suggestions":["track daily"],"savingIdeas":["meal prep"],"budgetTip":"set limits"}');
    expect(r.suggestions).toEqual(['track daily']);
    expect(r.savingIdeas).toEqual(['meal prep']);
    expect(r.budgetTip).toBe('set limits');
  });

  it('handles malformed input', () => {
    const r = parseExpensesResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseExpensesResponse('```json\n{"suggestions":["x"],"savingIdeas":["y"],"budgetTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
