import type { Cadence } from '@/lib/finance/subscriptions';
import {
  CANDIDATE_SOURCE_LIMIT, subscriptionReviewContextKey,
  type CandidateWindow, type RecordedExpense, type SubscriptionReviewContext,
} from '@/lib/finance/subscription-candidates';

export const PRICE_HISTORY_SOURCE_LIMIT = CANDIDATE_SOURCE_LIMIT;
export type PriceHistorySubscription = { id: string; name: string; costCents: number; cadence: string; note: string | null };
export type PriceHistoryCoverage = {
  state: 'complete' | 'limited' | 'unavailable';
  totalRecords: number | null;
  recordsRead: number;
  limit: number;
};
export type RecordedCharge = {
  source: 'transactions'; recordId: string; date: string; amountCents: number; currency: 'USD';
  differenceFromTrackedCents: number | null; differenceFromPreviousCents: number | null;
};
export type PriceHistoryGroup = {
  id: string; name: string; accountId: string; memberId: string | null; currency: 'USD';
  cadence: Cadence | null; supported: boolean; duplicateDateRecords: number;
  observed: CandidateWindow | null; evidence: RecordedCharge[];
};
export type SubscriptionPriceHistory = {
  state: 'matched' | 'unknown' | 'ambiguous' | 'unavailable';
  reason: string;
  subscription: PriceHistorySubscription;
  window: CandidateWindow;
  coverage: PriceHistoryCoverage;
  excluded: { invalidRecords: number; unsupportedCurrencyRecords: number; duplicateDateRecords: number };
  unmatchedRecords: number;
  unresolvedSourceReferences: number;
  groups: PriceHistoryGroup[];
};
export type SubscriptionPriceHistoryResponse = {
  familyId: string; context: SubscriptionReviewContext; history: SubscriptionPriceHistory;
};

const DAY = 86_400_000;
const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validCost = (amount: number) => Number.isSafeInteger(amount) && amount >= 0;

export function subscriptionHistoryTargetKey(subscription: PriceHistorySubscription): string {
  return JSON.stringify([subscription.id, subscription.name, subscription.costCents, subscription.cadence, subscription.note ?? null]);
}

/** Completeness is only about the bounded, authorized query, never all billing history. */
export function priceHistorySourceCoverage(count: unknown, returnedRows: number): PriceHistoryCoverage {
  const validRows = Number.isSafeInteger(returnedRows) && returnedRows >= 0 && returnedRows <= PRICE_HISTORY_SOURCE_LIMIT + 1;
  const available = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    && validRows && returnedRows === Math.min(count, PRICE_HISTORY_SOURCE_LIMIT + 1);
  return {
    state: !available ? 'unavailable' : count > PRICE_HISTORY_SOURCE_LIMIT ? 'limited' : 'complete',
    totalRecords: available ? count : null,
    recordsRead: validRows ? Math.min(returnedRows, PRICE_HISTORY_SOURCE_LIMIT) : 0,
    limit: PRICE_HISTORY_SOURCE_LIMIT,
  };
}

function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function cents(value: number | string): number | null {
  if (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  const result = Math.round(amount * 100);
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(result) && result > 0
    && Math.abs(amount * 100 - result) < 0.000001 ? result : null;
}

function observedCadence(dates: Date[]): Cadence | null {
  if (dates.length < 3) return null;
  const pairs = dates.slice(1).map((date, i) => [dates[i], date] as const);
  if (pairs.every(([a, b]) => Math.abs((b.getTime() - a.getTime()) / DAY - 7) <= 1)) return 'weekly';
  const monthEnd = (date: Date) => date.getUTCDate() === new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  for (const [cadence, months] of [['monthly', 1], ['quarterly', 3], ['yearly', 12]] as const) {
    if (pairs.every(([a, b]) => (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() === months
      && (Math.abs(b.getUTCDate() - a.getUTCDate()) <= 3 || (monthEnd(a) && monthEnd(b))))) return cadence;
  }
  return null;
}

/** Amount is deliberately NOT a grouping key: the evidence may show changing charges. */
export function reviewSubscriptionPriceHistory(
  expenses: readonly RecordedExpense[], subscription: PriceHistorySubscription, window: CandidateWindow,
  sourceCount: unknown, returnedRows = expenses.length,
): SubscriptionPriceHistory {
  const coverage = priceHistorySourceCoverage(sourceCount, returnedRows);
  const history: SubscriptionPriceHistory = {
    state: 'unknown', reason: '', subscription, window, coverage,
    excluded: { invalidRecords: 0, unsupportedCurrencyRecords: 0, duplicateDateRecords: 0 },
    unmatchedRecords: 0, unresolvedSourceReferences: 0, groups: [],
  };
  if (coverage.state === 'unavailable' || expenses.length !== coverage.recordsRead
    || !calendarDate(window.from) || !calendarDate(window.to) || window.from > window.to) {
    return { ...history, state: 'unavailable', coverage: { ...coverage, state: 'unavailable' }, reason: 'The source window or record count could not be established. No complete history or match can be claimed.' };
  }
  const ids = new Map<string, number>();
  for (const row of expenses) ids.set(row.id, (ids.get(row.id) ?? 0) + 1);
  const grouped = new Map<string, { row: RecordedExpense; amountCents: number; date: Date }[]>();
  for (const row of expenses) {
    const name = normalizeName(row.name);
    const date = calendarDate(row.date);
    const amountCents = cents(row.amount);
    if (!validId(row.id) || ids.get(row.id) !== 1 || row.type !== 'expense' || !date || amountCents === null
      || row.date < window.from || row.date > window.to || name.length < 3 || name.length > 160
      || /^(subscription|payment|charge|monthly|expense)$/.test(name)
      || /\b(refund|refunded|transfer|reversal|reversed|chargeback)\b/i.test(`${row.name} ${row.category ?? ''}`)) {
      history.excluded.invalidRecords += 1;
      continue;
    }
    if (row.currency !== 'USD' || !row.accountId) {
      history.excluded.unsupportedCurrencyRecords += 1;
      continue;
    }
    const key = JSON.stringify([name, row.currency, row.accountId, row.memberId]);
    const group = grouped.get(key) ?? [];
    group.push({ row, amountCents, date });
    grouped.set(key, group);
  }
  const allGroups: PriceHistoryGroup[] = [];
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.row.date.localeCompare(b.row.date) || a.row.id.localeCompare(b.row.id));
    const dates = new Map<string, number>();
    for (const { row } of rows) dates.set(row.date, (dates.get(row.date) ?? 0) + 1);
    const unique = rows.filter(({ row }) => dates.get(row.date) === 1);
    const duplicateDateRecords = rows.length - unique.length;
    history.excluded.duplicateDateRecords += duplicateDateRecords;
    const cadence = duplicateDateRecords === 0 ? observedCadence(unique.map((item) => item.date)) : null;
    const comparable = cadence === subscription.cadence && validCost(subscription.costCents);
    const first = rows[0].row;
    allGroups.push({
      id: `transactions:${first.id}`, name: first.name.trim().replace(/\s+/g, ' '),
      accountId: first.accountId!, memberId: first.memberId, currency: 'USD',
      cadence, supported: cadence !== null, duplicateDateRecords,
      observed: unique.length ? { from: unique[0].row.date, to: unique[unique.length - 1].row.date } : null,
      evidence: unique.map(({ row, amountCents }, i) => ({
        source: 'transactions', recordId: row.id, date: row.date, amountCents, currency: 'USD',
        differenceFromTrackedCents: comparable ? amountCents - subscription.costCents : null,
        differenceFromPreviousCents: i ? amountCents - unique[i - 1].amountCents : null,
      })),
    });
  }
  // Exact references only. Text resembling an id cannot invent or partially match a charge.
  const references = new Set(Array.from((subscription.note ?? '').matchAll(/\btransactions\/([A-Za-z0-9_-]+)(?=$|[\s);,.\]])/g), (match) => match[1]));
  const eligibleIds = new Set(allGroups.flatMap((group) => group.evidence.map((record) => record.recordId)));
  history.unresolvedSourceReferences = [...references].filter((id) => !eligibleIds.has(id)).length;
  history.groups = allGroups.filter((group) => normalizeName(group.name) === normalizeName(subscription.name)
    || group.evidence.some((record) => references.has(record.recordId)));
  const matching = new Set(history.groups.map((group) => group.id));
  history.unmatchedRecords = allGroups.filter((group) => !matching.has(group.id)).reduce((sum, group) => sum + group.evidence.length, 0);
  if (history.groups.length > 1) {
    history.state = 'ambiguous';
    history.reason = 'Distinct name/account/member groups match this subscription or its fetched source references. They are shown separately, not attributed or combined. Edit manually after resolving the match.';
  } else if (coverage.state === 'limited') {
    history.reason = 'Only the most recent bounded records were reviewed. An unseen matching group may exist, so this partial history cannot establish a unique match or prefill a cost.';
  } else if (history.groups.length === 0) {
    history.reason = 'No matching eligible recorded charges were found in the accessible window. This does not establish that no charges occurred.';
  } else if (!history.groups[0].supported || history.groups[0].cadence !== subscription.cadence || !validCost(subscription.costCents)) {
    history.reason = 'A unique comparable match needs at least three uniquely dated charges at the tracked cadence and a valid tracked amount. The observed records do not establish that match.';
  } else {
    history.state = 'matched';
    history.reason = 'One same-name or source-linked group has at least three uniquely dated USD charges at the tracked cadence. This supports a recorded-charge comparison, not proof of a subscription or a provider plan-price change.';
  }
  return history;
}

/** The only supported prefill is a selected factual charge in a unique complete-window match. */
export function selectRecordedSubscriptionAmount(history: SubscriptionPriceHistory, recordId: string): RecordedCharge | null {
  if (history.state !== 'matched' || history.coverage.state !== 'complete' || history.groups.length !== 1) return null;
  const group = history.groups[0];
  if (!group.supported || group.cadence !== history.subscription.cadence || group.evidence.length < 3) return null;
  const record = group.evidence.find((item) => item.recordId === recordId);
  return record?.currency === 'USD' && Number.isSafeInteger(record.amountCents) && record.amountCents > 0 ? record : null;
}

/** Do not render evidence or accept a prefill from a different identity, target or malformed response. */
export function isSubscriptionPriceHistoryResponse(
  value: unknown, context: SubscriptionReviewContext, subscription: PriceHistorySubscription,
): value is SubscriptionPriceHistoryResponse {
  try {
    if (!value || typeof value !== 'object') return false;
    const result = value as SubscriptionPriceHistoryResponse;
    const history = result.history;
    if (result.familyId !== context.familyId || !result.context
      || subscriptionReviewContextKey(result.context) !== subscriptionReviewContextKey(context)
      || !history || subscriptionHistoryTargetKey(history.subscription) !== subscriptionHistoryTargetKey(subscription)
      || !['matched', 'unknown', 'ambiguous'].includes(history.state) || typeof history.reason !== 'string'
      || !calendarDate(history.window.from) || !calendarDate(history.window.to) || history.window.from > history.window.to
      || !Array.isArray(history.groups)) return false;
    const coverage = history.coverage;
    if (typeof coverage.totalRecords !== 'number') return false;
    const expected = priceHistorySourceCoverage(coverage.totalRecords, Math.min(coverage.totalRecords, PRICE_HISTORY_SOURCE_LIMIT + 1));
    if (expected.state === 'unavailable' || expected.state !== coverage.state || expected.recordsRead !== coverage.recordsRead
      || coverage.limit !== PRICE_HISTORY_SOURCE_LIMIT) return false;
    if (![history.excluded.invalidRecords, history.excluded.unsupportedCurrencyRecords, history.excluded.duplicateDateRecords,
      history.unmatchedRecords, history.unresolvedSourceReferences].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
    const recordIds = new Set<string>();
    return history.groups.every((group) => typeof group.id === 'string' && typeof group.name === 'string' && typeof group.accountId === 'string'
      && group.currency === 'USD' && Array.isArray(group.evidence) && group.evidence.every((record) => {
        if (record.source !== 'transactions' || !validId(record.recordId) || recordIds.has(record.recordId)
          || record.currency !== 'USD' || !Number.isSafeInteger(record.amountCents) || record.amountCents <= 0
          || !calendarDate(record.date) || record.date < history.window.from || record.date > history.window.to
          || ![record.differenceFromTrackedCents, record.differenceFromPreviousCents].every((n) => n === null || Number.isSafeInteger(n))) return false;
        recordIds.add(record.recordId);
        return true;
      }));
  } catch {
    return false;
  }
}
