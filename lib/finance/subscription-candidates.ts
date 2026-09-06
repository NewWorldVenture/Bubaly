import type { Cadence } from '@/lib/finance/subscriptions';

export const CANDIDATE_WINDOW_DAYS = 800;
export const CANDIDATE_SOURCE_LIMIT = 500;

export type RecordedExpense = {
  id: string;
  name: string;
  amount: number | string;
  type: string;
  date: string;
  category: string | null;
  accountId: string | null;
  memberId: string | null;
  /** Currency of the accessible linked financial account; null means unknown. */
  currency: string | null;
};
export type TrackedCandidateMatch = { name: string; note?: string | null };
export type CandidateWindow = { from: string; to: string };
export type SubscriptionReviewContext = {
  familyId: string;
  userId: string;
  memberId: string | null;
  role: string | null;
  active: boolean;
};

/** Identity and access changes invalidate evidence, even within the same family. */
export function subscriptionReviewContextKey(context: SubscriptionReviewContext): string {
  return JSON.stringify([context.familyId, context.userId, context.memberId, context.role, context.active]);
}

export type SubscriptionCandidate = {
  id: string;
  name: string;
  amountCents: number;
  currency: 'USD';
  cadence: Cadence;
  observed: CandidateWindow;
  explanation: string;
  evidence: { source: 'transactions'; recordId: string; date: string; amountCents: number; currency: 'USD' }[];
};
export type SubscriptionCandidateResponse = {
  familyId: string;
  context: SubscriptionReviewContext;
  candidates: SubscriptionCandidate[];
  window: CandidateWindow;
  recordsRead: number;
  limited: boolean;
  unsupportedCurrencyRecords: number;
};

const DAY = 86_400_000;
const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function cents(value: number | string): number | null {
  if (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  const result = Math.round(amount * 100);
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(result)
    && result > 0 && Math.abs(amount * 100 - result) < 0.000001 ? result : null;
}

export function subscriptionCandidateWindow(now = new Date()): CandidateWindow {
  const to = now.toISOString().slice(0, 10);
  return { from: new Date(new Date(`${to}T00:00:00Z`).getTime() - CANDIDATE_WINDOW_DAYS * DAY).toISOString().slice(0, 10), to };
}

function cadenceFor(dates: Date[]): Cadence | null {
  const pairs = dates.slice(1).map((date, index) => [dates[index], date] as const);
  if (pairs.every(([a, b]) => Math.abs((b.getTime() - a.getTime()) / DAY - 7) <= 1)) return 'weekly';
  const monthEnd = (date: Date) => date.getUTCDate() === new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  for (const [cadence, months] of [['monthly', 1], ['quarterly', 3], ['yearly', 12]] as const) {
    if (pairs.every(([a, b]) => (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() === months
      && (Math.abs(b.getUTCDate() - a.getUTCDate()) <= 3 || (monthEnd(a) && monthEnd(b))))) return cadence;
  }
  return null;
}

/** Suppress matching names at every tracked status, or already-recorded source evidence. */
export function candidateAlreadyTracked(candidate: SubscriptionCandidate, tracked: readonly TrackedCandidateMatch[]): boolean {
  return tracked.some((sub) => normalizeName(sub.name) === normalizeName(candidate.name)
    || candidate.evidence.some((item) => sub.note?.includes(`transactions/${item.recordId}`)));
}

/** Conservative observations only: no fuzzy merchant merging, single-charge inference or currency conversion. */
export function detectSubscriptionCandidates(
  expenses: readonly RecordedExpense[], tracked: readonly TrackedCandidateMatch[], window: CandidateWindow,
): SubscriptionCandidate[] {
  if (!calendarDate(window.from) || !calendarDate(window.to) || window.from > window.to) return [];
  const idCounts = new Map<string, number>();
  for (const expense of expenses) idCounts.set(expense.id, (idCounts.get(expense.id) ?? 0) + 1);
  const groups = new Map<string, { expense: RecordedExpense; amountCents: number; date: Date }[]>();
  for (const expense of expenses) {
    const name = normalizeName(expense.name);
    const date = calendarDate(expense.date);
    const amountCents = cents(expense.amount);
    if (!expense.id || idCounts.get(expense.id) !== 1 || expense.type !== 'expense' || expense.currency !== 'USD' || !expense.accountId
      || !date || expense.date < window.from || expense.date > window.to || amountCents === null
      || name.length < 3 || name.length > 160 || /^(subscription|payment|charge|monthly|expense)$/.test(name)
      || /\b(refund|refunded|transfer|reversal|reversed|chargeback)\b/i.test(`${expense.name} ${expense.category ?? ''}`)) continue;
    const key = JSON.stringify([name, amountCents, expense.currency, expense.accountId, expense.memberId]);
    const group = groups.get(key) ?? [];
    group.push({ expense, amountCents, date });
    groups.set(key, group);
  }
  const candidates: SubscriptionCandidate[] = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    group.sort((a, b) => a.expense.date.localeCompare(b.expense.date) || a.expense.id.localeCompare(b.expense.id));
    if (new Set(group.map((item) => item.expense.date)).size !== group.length) continue;
    const cadence = cadenceFor(group.map((item) => item.date));
    if (!cadence) continue;
    const first = group[0];
    const candidate: SubscriptionCandidate = {
      id: `transactions:${first.expense.id}`,
      name: first.expense.name.trim().replace(/\s+/g, ' '),
      amountCents: first.amountCents,
      currency: 'USD',
      cadence,
      observed: { from: first.expense.date, to: group[group.length - 1].expense.date },
      explanation: `${group.length} recorded expenses have the same name, amount and USD account currency, for the same account and person, at an approximately ${cadence} interval. This is a recurring expense candidate, not a confirmed subscription.`,
      evidence: group.map(({ expense, amountCents }) => ({ source: 'transactions', recordId: expense.id, date: expense.date, amountCents, currency: 'USD' })),
    };
    if (!candidateAlreadyTracked(candidate, tracked)) candidates.push(candidate);
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Only a manual-form draft. Charges do not establish usage, status changes or a next charge date. */
export function subscriptionCandidateDraft(candidate: SubscriptionCandidate) {
  const evidence = candidate.evidence;
  const sample = evidence.length <= 3 ? evidence : [evidence[0], evidence[1], evidence[evidence.length - 1]];
  return {
    name: candidate.name,
    cost: (candidate.amountCents / 100).toFixed(2),
    cadence: candidate.cadence,
    category: 'Other',
    last_used: '',
    next_charge: '',
    note: `Recorded expense evidence: ${evidence.length} same-name USD ${(candidate.amountCents / 100).toFixed(2)} records, ${candidate.observed.from} to ${candidate.observed.to}. Sources: ${sample.map((item) => `transactions/${item.recordId} (${item.date})`).join('; ')}${evidence.length > sample.length ? '; additional records shown during review' : ''}.`,
  };
}
