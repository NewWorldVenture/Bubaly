import { describe, expect, it } from 'vitest';
import { type RecordedExpense } from '@/lib/finance/subscription-candidates';
import {
  priceHistorySourceCoverage, reviewSubscriptionPriceHistory, selectRecordedSubscriptionAmount,
  type PriceHistorySubscription,
} from '@/lib/finance/subscription-price-history';

const subscription: PriceHistorySubscription = { id: 'sub-a', name: 'Example Media', costCents: 1500, cadence: 'monthly', note: null };
const window = { from: '2024-07-01', to: '2026-09-06' };
function records(): RecordedExpense[] {
  return ['2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => ({
    id: `txn-${i}`, name: 'Example Media', amount: [15, 15, 18][i], type: 'expense', date,
    category: 'Subscriptions', accountId: 'account-a', memberId: 'member-a', currency: 'USD',
  }));
}
function review(rows = records(), tracked = subscription) {
  return reviewSubscriptionPriceHistory(rows, tracked, window, rows.length);
}

describe('conservative recorded subscription charge history', () => {
  it('shows changing recorded amounts without splitting the same account/member group', () => {
    const history = review();
    expect(history.state).toBe('matched');
    expect(history.groups).toHaveLength(1);
    expect(history.groups[0].evidence.map((item) => item.amountCents)).toEqual([1500, 1500, 1800]);
    expect(history.groups[0].evidence[2]).toMatchObject({ recordId: 'txn-2', date: '2026-08-15', currency: 'USD', differenceFromTrackedCents: 300, differenceFromPreviousCents: 300 });
    expect(history.reason).toContain('not proof');
    expect(selectRecordedSubscriptionAmount(history, 'txn-2')?.amountCents).toBe(1800);
    expect(subscription).toMatchObject({ costCents: 1500, note: null });
  });

  it('preserves recorded decreases, exact-cent strings and same-name whitespace normalization', () => {
    const rows = records();
    rows[0].name = '  EXAMPLE   MEDIA ';
    rows[2].amount = '12.50';
    const history = review(rows);
    expect(history.state).toBe('matched');
    expect(history.groups[0].evidence[2]).toMatchObject({ amountCents: 1250, differenceFromTrackedCents: -250, differenceFromPreviousCents: -250 });
  });

  it.each([0, 1, 2])('does not establish history from %i recorded charges', (count) => {
    const history = review(records().slice(0, count));
    expect(history.state).toBe('unknown');
    expect(selectRecordedSubscriptionAmount(history, 'txn-0')).toBeNull();
  });

  it.each(['account', 'member'])('keeps different %s groups ambiguous, even if one is supported', (field) => {
    const extra = { ...records()[0], id: 'txn-other', accountId: field === 'account' ? 'account-b' : 'account-a', memberId: field === 'member' ? 'member-b' : 'member-a' };
    const history = review([...records(), extra]);
    expect(history.state).toBe('ambiguous');
    expect(history.groups).toHaveLength(2);
    expect(selectRecordedSubscriptionAmount(history, 'txn-2')).toBeNull();
  });

  it('does not fuzzy-merge different merchant names', () => {
    const other = records().map((row, i) => ({ ...row, id: `other-${i}`, name: 'Example-Media' }));
    const history = review([...records(), ...other]);
    expect(history.state).toBe('matched');
    expect(history.groups).toHaveLength(1);
    expect(history.unmatchedRecords).toBe(3);
  });

  it('uses an exact eligible fetched source reference for a manually renamed subscription', () => {
    const history = review(records(), { ...subscription, name: 'Family streaming', note: 'Sources: transactions/txn-1 (2026-07-15).' });
    expect(history.state).toBe('matched');
    expect(history.unresolvedSourceReferences).toBe(0);
  });

  it('does not use absent, prefix-matching, refunded or non-USD source anchors', () => {
    const rows = records();
    rows[0].type = 'income';
    rows[1].currency = 'EUR';
    const history = review(rows, { ...subscription, name: 'Renamed', note: 'transactions/txn-0; transactions/txn-1; transactions/txn-20; transactions/missing.' });
    expect(history.state).toBe('unknown');
    expect(history.groups).toEqual([]);
    expect(history.unresolvedSourceReferences).toBe(4);
  });

  it('does not silently choose between a named group and a distinct source-linked group', () => {
    const other = records().map((row, i) => ({ ...row, id: `other-${i}`, name: 'Another Merchant' }));
    const history = review([...records(), ...other], { ...subscription, note: 'transactions/other-0' });
    expect(history.state).toBe('ambiguous');
    expect(history.groups).toHaveLength(2);
  });

  it.each([
    ['refund', { category: 'Refund' }], ['transfer', { type: 'transfer' }],
    ['negative', { amount: -1 }], ['zero', { amount: 0 }], ['nonfinite', { amount: Infinity }],
    ['fractional cent', { amount: 15.001 }], ['exponent string', { amount: '1e2' }],
    ['invalid date', { date: '2026-02-30' }], ['future date', { date: '2026-09-07' }],
    ['out of window', { date: '2020-01-01' }], ['generic name', { name: 'payment' }],
  ] as const)('excludes %s records', (_label, change) => {
    const history = review([...records(), { ...records()[0], id: 'bad-record', ...change }]);
    expect(history.state).toBe('matched');
    expect(history.excluded.invalidRecords).toBe(1);
    expect(history.groups[0].evidence).toHaveLength(3);
  });

  it.each(['EUR', null])('never converts or assumes USD for %s account currency', (currency) => {
    const history = review(records().map((row) => ({ ...row, currency })));
    expect(history.state).toBe('unknown');
    expect(history.excluded.unsupportedCurrencyRecords).toBe(3);
    expect(history.groups).toEqual([]);
  });

  it('excludes missing linked accounts even if a currency string says USD', () => {
    expect(review(records().map((row) => ({ ...row, accountId: null }))).excluded.unsupportedCurrencyRecords).toBe(3);
  });

  it('excludes every occurrence of duplicate ids and refuses ambiguous same-day cadence', () => {
    const duplicateIds = review([...records(), { ...records()[0] }]);
    expect(duplicateIds.excluded.invalidRecords).toBe(2);
    expect(duplicateIds.state).toBe('unknown');
    const duplicateDates = review([...records(), { ...records()[0], id: 'same-day' }]);
    expect(duplicateDates.excluded.duplicateDateRecords).toBe(2);
    expect(duplicateDates.groups[0].evidence).toHaveLength(2);
    expect(duplicateDates.groups[0].cadence).toBeNull();
    expect(duplicateDates.state).toBe('unknown');
  });

  it.each([
    ['weekly', ['2026-08-01', '2026-08-08', '2026-08-15']],
    ['monthly', ['2026-01-31', '2026-02-28', '2026-03-31']],
    ['quarterly', ['2026-01-15', '2026-04-15', '2026-07-15']],
    ['yearly', ['2024-09-01', '2025-09-01', '2026-09-01']],
  ] as const)('retains supported %s cadence evidence', (cadence, dates) => {
    const history = review(records().map((row, i) => ({ ...row, date: dates[i] })), { ...subscription, cadence });
    expect(history.state).toBe('matched');
    expect(history.groups[0].cadence).toBe(cadence);
  });

  it('does not compare or prefill a mismatched tracked cadence', () => {
    const history = review(records(), { ...subscription, cadence: 'yearly' });
    expect(history.state).toBe('unknown');
    expect(history.groups[0].evidence.every((item) => item.differenceFromTrackedCents === null)).toBe(true);
    expect(selectRecordedSubscriptionAmount(history, 'txn-2')).toBeNull();
  });

  it('does not infer cadence across missing monthly records or a bad tracked amount', () => {
    const rows = records();
    rows[1].date = '2026-04-15';
    expect(review(rows).state).toBe('unknown');
    expect(review(records(), { ...subscription, costCents: -1 }).state).toBe('unknown');
  });
});

describe('bounded source coverage', () => {
  it.each([undefined, null, NaN, Infinity, -1, 0.5, '3', Number.MAX_SAFE_INTEGER + 1])('does not claim completeness for count %s', (count) => {
    expect(priceHistorySourceCoverage(count, 3).state).toBe('unavailable');
    const history = reviewSubscriptionPriceHistory(records(), subscription, window, count);
    expect(history.state).toBe('unavailable');
    expect(history.groups).toEqual([]);
    expect(selectRecordedSubscriptionAmount(history, 'txn-2')).toBeNull();
  });

  it('rejects missing or extra rows despite a valid count', () => {
    expect(priceHistorySourceCoverage(4, 3).state).toBe('unavailable');
    expect(priceHistorySourceCoverage(2, 3).state).toBe('unavailable');
    expect(priceHistorySourceCoverage(900, 500).state).toBe('unavailable');
    expect(priceHistorySourceCoverage(900, 501)).toMatchObject({ state: 'limited', recordsRead: 500, totalRecords: 900 });
  });

  it('discloses truncation and cannot prefill from a seemingly unique group in partial history', () => {
    const filler = Array.from({ length: 497 }, (_, i) => ({ ...records()[0], id: `filler-${i}`, name: `Other merchant ${i}` }));
    const history = reviewSubscriptionPriceHistory([...records(), ...filler], subscription, window, 900, 501);
    expect(history.coverage.state).toBe('limited');
    expect(history.state).toBe('unknown');
    expect(history.groups).toHaveLength(1);
    expect(selectRecordedSubscriptionAmount(history, 'txn-2')).toBeNull();
  });

  it('supports a genuinely empty accessible window without inventing a billing history', () => {
    const history = review([]);
    expect(history.coverage).toMatchObject({ state: 'complete', recordsRead: 0, totalRecords: 0 });
    expect(history.state).toBe('unknown');
    expect(history.reason).toContain('does not establish that no charges occurred');
  });
});
