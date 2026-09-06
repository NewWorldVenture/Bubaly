'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isManager } from '@/lib/constants/roles';
import { subscriptionReviewContextKey, type SubscriptionReviewContext } from '@/lib/finance/subscription-candidates';
import {
  isSubscriptionPriceHistoryResponse, selectRecordedSubscriptionAmount, subscriptionHistoryTargetKey,
  type PriceHistorySubscription, type RecordedCharge, type SubscriptionPriceHistoryResponse,
} from '@/lib/finance/subscription-price-history';

const dollars = (cents: number) => `USD ${(cents / 100).toFixed(2)}`;
const difference = (cents: number) => cents === 0 ? 'unchanged' : `${dollars(Math.abs(cents))} ${cents > 0 ? 'higher' : 'lower'}`;

export function SubscriptionPriceHistoryReview({ context, subscription, onPrefill }: {
  context: SubscriptionReviewContext; subscription: PriceHistorySubscription; onPrefill: (charge: RecordedCharge) => void;
}) {
  const key = JSON.stringify([subscriptionReviewContextKey(context), subscriptionHistoryTargetKey(subscription)]);
  const canReview = !!context.userId && !!context.memberId && context.active && isManager(context.role);
  const [review, setReview] = useState<{ key: string; generation: number; loading: boolean; result: SubscriptionPriceHistoryResponse | null; error: string | null }>({
    key, generation: 0, loading: false, result: null, error: null,
  });
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => () => {
    generation.current += 1;
    request.current?.abort();
  }, [key]);
  const visible = review.key === key && review.generation === generation.current ? review : { key, generation: generation.current, loading: false, result: null, error: null };

  async function load() {
    if (!canReview || visible.loading) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const scan = ++generation.current;
    const isCurrent = () => !controller.signal.aborted && currentKey.current === key && generation.current === scan;
    setReview({ key, generation: scan, loading: true, result: null, error: null });
    try {
      const response = await fetch(`/api/subscriptions/price-history?subscriptionId=${encodeURIComponent(subscription.id)}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!isCurrent()) return;
      const result: unknown = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) {
        const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'Recorded charges could not be reviewed. Try again.';
        throw new Error(message);
      }
      if (!isSubscriptionPriceHistoryResponse(result, context, subscription)) throw new Error('The recorded-charge review did not match the current account, family or subscription. Refresh and try again.');
      setReview({ key, generation: scan, loading: false, result, error: null });
    } catch (error) {
      if (isCurrent()) setReview({ key, generation: scan, loading: false, result: null, error: error instanceof Error ? error.message : 'Recorded charges could not be reviewed. Try again.' });
    }
  }

  const history = canReview ? visible.result?.history : null;
  return (
    <section aria-label={`Recorded charge history for ${subscription.name}`} className="mt-3 space-y-3 border-t border-border pt-3">
      <Button type="button" variant="secondary" disabled={!canReview || visible.loading} aria-label={`Review recorded charges for ${subscription.name}`}
        onClick={() => { void load(); }}>{visible.loading ? 'Reading charges...' : visible.result || visible.error ? 'Refresh recorded charges' : 'Review recorded charges'}</Button>
      {!canReview && <p className="text-xs text-muted">A current parent or adult membership is required to review recorded charges.</p>}
      {visible.loading && <p role="status" className="text-sm text-muted">Reading authorized recorded charges...</p>}
      {visible.error && <p role="alert" className="text-sm text-danger">{visible.error}</p>}
      {history && (
        <div className="space-y-3 text-sm">
          <p role="status">{history.reason}</p>
          <p className="text-xs text-muted">Source window: {history.window.from} to {history.window.to}. Read {history.coverage.recordsRead} of {history.coverage.totalRecords} accessible expense records in this window.
            {history.coverage.state === 'limited' ? ' Truncated to the 500 most recent records; cost prefill is unavailable.' : ' This is a bounded recorded-expense review, not complete provider billing history.'}</p>
          <p className="text-xs text-muted">Excluded: {history.excluded.invalidRecords} invalid, duplicate-ID, refund or transfer records; {history.excluded.unsupportedCurrencyRecords} unknown or non-USD account-currency records; {history.excluded.duplicateDateRecords} duplicate-date records.
            {' '}{history.unmatchedRecords} eligible records did not match this subscription. {history.unresolvedSourceReferences} note source references were not found in eligible fetched records and were not used as anchors. Inaccessible, unrecorded and out-of-window charges remain unknown.</p>
          <p className="text-xs text-muted">An observed amount increase is not a confirmed provider plan-price change. These records do not explain tax, proration, benefits or household use.</p>
          {history.groups.map((group) => (
            <details key={group.id} open={history.state === 'matched' || undefined} className="min-w-0 rounded-xl border border-border p-3">
              <summary className="cursor-pointer break-words font-medium focus-visible:outline focus-visible:outline-2">{group.name}: {group.evidence.length} uniquely dated recorded charges{group.cadence ? `, approximately ${group.cadence}` : ', cadence unconfirmed'}</summary>
              <div className="mt-3 space-y-3">
                <p className="break-words text-xs text-muted">Account: <code className="break-all">{group.accountId}</code>. Recorded member: <code className="break-all">{group.memberId ?? 'not assigned in source'}</code>.</p>
                {group.observed && <p className="text-xs text-muted">Observed window: {group.observed.from} to {group.observed.to}.</p>}
                <p className="text-xs text-muted">Tracked amount: {dollars(subscription.costCents)} / {subscription.cadence}. Comparisons are available only for a supported matching cadence.</p>
                <ul aria-label={`Recorded charge evidence for ${group.name}`} className="space-y-3">
                  {group.evidence.map((charge) => {
                    const selected = selectRecordedSubscriptionAmount(history, charge.recordId);
                    const sourceId = `charge-source-${subscription.id}-${charge.recordId}`;
                    return (
                      <li key={charge.recordId} className="min-w-0 space-y-2 rounded-lg bg-surface/40 p-2">
                        <p><time dateTime={charge.date}>{charge.date}</time> - {dollars(charge.amountCents)}</p>
                        <p className="text-xs text-muted">{charge.differenceFromTrackedCents === null ? 'Not comparable to the tracked billing amount.' : `Compared with tracked amount: ${difference(charge.differenceFromTrackedCents)}.`}
                          {charge.differenceFromPreviousCents !== null ? ` Difference from previous recorded charge: ${difference(charge.differenceFromPreviousCents)}.` : ' First charge in the observed group.'}</p>
                        <a href={`#${sourceId}`} className="block break-all text-xs text-brand-text underline">Source: transactions/{charge.recordId}</a>
                        <div id={sourceId} className="break-words text-xs text-muted">Recorded source: {group.name}, {charge.date}, {dollars(charge.amountCents)}; account <code className="break-all">{group.accountId}</code>; member <code className="break-all">{group.memberId ?? 'unassigned'}</code>.</div>
                        {selected && <Button type="button" variant="secondary" onClick={() => {
                          if (canReview && currentKey.current === key && generation.current === visible.generation && request.current?.signal.aborted !== true) onPrefill(selected);
                        }}>Use {dollars(charge.amountCents)} in Edit form</Button>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          ))}
          <p className="text-xs text-muted">Selecting a supported amount only opens the existing editable form. Cost is not saved until you choose Save. Status, renewal date, recorded use and notes are preserved.</p>
        </div>
      )}
    </section>
  );
}
