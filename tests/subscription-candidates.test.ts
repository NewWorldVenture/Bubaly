import { describe, expect, it } from 'vitest';
import { candidateAlreadyTracked, detectSubscriptionCandidates, subscriptionCandidateDraft, subscriptionCandidateWindow, type RecordedExpense } from '@/lib/finance/subscription-candidates';

const window = { from: '2024-01-01', to: '2026-09-06' };
function records(dates = ['2026-06-15', '2026-07-15', '2026-08-15'], change: Partial<RecordedExpense> = {}): RecordedExpense[] {
  return dates.map((date, i) => ({ id: `expense-${i}`, name: 'Example Media', amount: 14.99, type: 'expense', date, category: 'Subscriptions', accountId: 'account-a', memberId: 'member-a', currency: 'USD', ...change }));
}

describe('recorded-expense subscription candidates', () => {
  it('requires three distinct recorded charges and explains exact evidence', () => {
    for (const size of [0, 1, 2]) expect(detectSubscriptionCandidates(records().slice(0, size), [], window)).toEqual([]);
    const [candidate] = detectSubscriptionCandidates(records(), [], window);
    expect(candidate).toMatchObject({ name: 'Example Media', currency: 'USD', amountCents: 1499, cadence: 'monthly', observed: { from: '2026-06-15', to: '2026-08-15' } });
    expect(candidate.evidence.map((item) => item.recordId)).toEqual(['expense-0', 'expense-1', 'expense-2']);
    expect(candidate.explanation).toContain('not a confirmed subscription');
  });

  it.each([
    ['weekly', ['2026-08-01', '2026-08-08', '2026-08-15']],
    ['monthly', ['2026-01-31', '2026-02-28', '2026-03-31']],
    ['quarterly', ['2026-01-15', '2026-04-15', '2026-07-15']],
    ['yearly', ['2024-06-15', '2025-06-15', '2026-06-15']],
  ])('supports conservative %s cadence evidence', (cadence, dates) => {
    expect(detectSubscriptionCandidates(records(dates as string[]), [], window)[0]?.cadence).toBe(cadence);
  });

  it.each([
    { amount: -10 }, { amount: 0 }, { amount: NaN }, { amount: Infinity }, { amount: 1.001 }, { amount: '1e2' },
    { type: 'income' }, { type: 'transfer' }, { category: 'Refund' }, { name: 'Example Media refund' },
    { name: 'Payment' }, { currency: null }, { currency: 'EUR' }, { accountId: null },
    { date: '2026-02-30' }, { date: '2027-01-01' }, { date: '2023-01-01' },
  ])('excludes unsupported or ambiguous source data: %j', (change) => {
    expect(detectSubscriptionCandidates(records(undefined, change), [], window)).toEqual([]);
  });

  it('does not merge punctuation variants, different amounts, accounts or people', () => {
    for (const change of [{ name: 'Example-Media' }, { amount: 19.99 }, { accountId: 'account-b' }, { memberId: 'member-b' }]) {
      const input = records();
      input[2] = { ...input[2], ...change };
      expect(detectSubscriptionCandidates(input, [], window)).toEqual([]);
    }
  });

  it('allows only case and whitespace normalization and preserves exact decimal costs', () => {
    const input = records(undefined, { amount: '14.99' });
    input[1].name = ' EXAMPLE   MEDIA ';
    expect(detectSubscriptionCandidates(input, [], window)[0]?.amountCents).toBe(1499);
  });

  it('rejects irregular intervals, repeated dates, and duplicated source ids', () => {
    expect(detectSubscriptionCandidates(records(['2026-06-15', '2026-07-15', '2026-08-25']), [], window)).toEqual([]);
    expect(detectSubscriptionCandidates(records(['2026-06-15', '2026-06-15', '2026-07-15']), [], window)).toEqual([]);
    expect(detectSubscriptionCandidates(records(undefined, { id: 'same-record' }), [], window)).toEqual([]);
  });

  it('excludes already tracked names or source references, including renamed drafts', () => {
    const [candidate] = detectSubscriptionCandidates(records(), [], window);
    expect(detectSubscriptionCandidates(records(), [{ name: ' EXAMPLE MEDIA ' }], window)).toEqual([]);
    expect(candidateAlreadyTracked(candidate, [{ name: 'Edited name', note: 'Recorded expense evidence: transactions/expense-1 (2026-07-15)' }])).toBe(true);
  });

  it('does not infer a next charge, usage, savings or create a persisted record in its draft', () => {
    const [candidate] = detectSubscriptionCandidates(records(), [], window);
    const draft = subscriptionCandidateDraft(candidate);
    expect(draft).toMatchObject({ name: 'Example Media', cost: '14.99', cadence: 'monthly', category: 'Other', last_used: '', next_charge: '' });
    expect(draft.note).toContain('transactions/expense-0 (2026-06-15)');
    expect(draft).not.toHaveProperty('id');
    expect(draft).not.toHaveProperty('status');
  });

  it('is deterministic and leaves its inputs unchanged', () => {
    const input = records();
    const before = structuredClone(input);
    expect(detectSubscriptionCandidates([...input].reverse(), [], window)).toEqual(detectSubscriptionCandidates(input, [], window));
    expect(input).toEqual(before);
    expect(subscriptionCandidateWindow(new Date('2026-09-06T12:00:00Z')).to).toBe('2026-09-06');
  });
});
