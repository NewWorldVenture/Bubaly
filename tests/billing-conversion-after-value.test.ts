import { describe, it, expect } from 'vitest';
import {
  conversionAfterValue, type ActivationReach, type ConversionSubscription, type PaidActivationReceipt,
} from '@/lib/billing/conversion';

const NOW = new Date('2026-03-15T12:00:00Z');
const reach = (familyId: string, reachedAt = '2026-01-01T00:00:00Z'): ActivationReach => ({ familyId, reachedAt });
const sub = (familyId: string, over: Partial<ConversionSubscription> = {}): ConversionSubscription =>
  ({ familyId, plan: 'family', status: 'active', ...over });
const receipt = (familyId: string, recordedAt: string, over: Partial<PaidActivationReceipt> = {}): PaidActivationReceipt =>
  ({ familyId, recordedAt, kind: 'subscription', relatedType: 'subscription', meta: { plan: 'family', status: 'active' }, ...over });

describe('recorded paid activations after first value', () => {
  it('is undefined when no family reached first value', () => {
    expect(conversionAfterValue([], [sub('f1')], [], NOW))
      .toMatchObject({ families: 0, rate: null, medianDays: null });
  });
  it('counts a currently paid-active family with a qualifying notification after the milestone', () => {
    expect(conversionAfterValue([reach('f1')], [sub('f1')], [receipt('f1', '2026-01-03T00:00:00Z')], NOW))
      .toEqual({ families: 1, recordedPaidActivations: 1, rate: 1, medianDays: 2, missingEvidence: 0, priorOnly: 0, ambiguousStatus: 0 });
  });
  it('keeps prior-only receipts apart from missing evidence', () => {
    expect(conversionAfterValue(
      [reach('prior', '2026-02-01T00:00:00Z'), reach('missing')], [sub('prior'), sub('missing')],
      [receipt('prior', '2026-01-01T00:00:00Z')], NOW,
    )).toMatchObject({ recordedPaidActivations: 0, rate: 0, medianDays: null, priorOnly: 1, missingEvidence: 1 });
  });
  it('keeps conflicting current subscription status outside every paid cohort', () => {
    expect(conversionAfterValue(
      ['conflict', 'same'].map((id) => reach(id)),
      [sub('conflict'), sub('conflict', { status: 'canceled' }), sub('conflict'), sub('same'), sub('same')],
      [receipt('conflict', '2026-01-03T00:00:00Z'), receipt('same', '2026-01-03T00:00:00Z')], NOW,
    )).toMatchObject({ families: 2, recordedPaidActivations: 1, ambiguousStatus: 1, missingEvidence: 0, priorOnly: 0 });
  });
  it('includes a recorded reactivation and chooses the first qualifying record after the milestone', () => {
    expect(conversionAfterValue([reach('f1')], [sub('f1')], [
      receipt('f1', '2025-12-01T00:00:00Z'), receipt('f1', '2026-01-11T00:00:00Z'),
      receipt('f1', '2026-01-05T00:00:00Z'), receipt('f1', '2026-01-05T00:00:00Z'),
    ], NOW)).toMatchObject({ recordedPaidActivations: 1, medianDays: 4, priorOnly: 0 });
  });
  it('ignores free, non-active and unrecognised current plans', () => {
    const families = ['free', 'trial', 'unknown', 'canceled'];
    expect(conversionAfterValue(families.map((f) => reach(f)), [
      sub('free', { plan: 'free' }), sub('trial', { status: 'trialing' }),
      sub('unknown', { plan: 'mystery' }), sub('canceled', { status: 'canceled' }),
    ], families.map((f) => receipt(f, '2026-01-02T00:00:00Z')), NOW))
      .toMatchObject({ recordedPaidActivations: 0, families: 4, missingEvidence: 0 });
  });
  it('counts a family once using its earliest first value', () => {
    expect(conversionAfterValue(
      [reach('f1', '2026-01-05T00:00:00Z'), reach('f1'), reach('f1', '2026-01-09T00:00:00Z')],
      [sub('f1'), sub('f1')], [receipt('f1', '2026-01-03T00:00:00Z')], NOW,
    )).toMatchObject({ families: 1, recordedPaidActivations: 1, medianDays: 2 });
  });
  it('accepts a receipt at exactly the first-value instant', () => {
    expect(conversionAfterValue([reach('f1')], [sub('f1')], [receipt('f1', '2026-01-01T00:00:00Z')], NOW).medianDays).toBe(0);
  });
  it.each([
    [{ kind: 'subscription_churn' }], [{ relatedType: 'family' }], [{ meta: null }],
    [{ meta: [] }], [{ meta: {} }], [{ meta: { plan: 'free', status: 'active' } }],
    [{ meta: { plan: 'mystery', status: 'active' } }], [{ meta: { plan: 'plus', status: 'trialing' } }],
    [{ familyId: 'another-family' }], [{ recordedAt: 'not-a-date' }],
    [{ recordedAt: '2026-04-01T00:00:00Z' }],
  ] as [Partial<PaidActivationReceipt>][])('does not treat malformed or unrelated evidence as proof: %j', (over) => {
    expect(conversionAfterValue([reach('f1')], [sub('f1')], [receipt('f1', '2026-01-03T00:00:00Z', over)], NOW))
      .toMatchObject({ recordedPaidActivations: 0, missingEvidence: 1, priorOnly: 0 });
  });
  it('does not infer a transition from a current subscription or an updated-at value', () => {
    const renewed = { ...sub('f1'), updated_at: '2026-03-01T00:00:00Z', paidAt: '2026-03-01T00:00:00Z' };
    expect(conversionAfterValue([reach('f1')], [renewed], [], NOW))
      .toMatchObject({ recordedPaidActivations: 0, missingEvidence: 1, medianDays: null });
  });
  it.each([
    [['2026-01-02', '2026-01-11', '2026-01-06'], 5],
    [['2026-01-02', '2026-01-04', '2026-01-06', '2026-01-08'], 4],
  ] as [string[], number][])('reports a median of the first recorded delays: %j', (dates, expected) => {
    const ids = dates.map((_, i) => String(i));
    expect(conversionAfterValue(ids.map((id) => reach(id)), ids.map((id) => sub(id)),
      dates.map((at, i) => receipt(ids[i], at + 'T00:00:00Z')), NOW).medianDays).toBe(expected);
  });
  it('ignores invalid and future first-value dates without producing NaN', () => {
    expect(conversionAfterValue(
      [reach('bad', 'nonsense'), reach('future', '2027-01-01T00:00:00Z'), reach('ok')],
      [sub('ok')], [receipt('ok', 'invalid')], NOW,
    )).toMatchObject({ families: 1, rate: 0, missingEvidence: 1 });
  });
  it('uses every first-value family in the denominator, including unpaid families', () => {
    expect(conversionAfterValue(
      ['a', 'b', 'c', 'd'].map((id) => reach(id)), [sub('a')],
      [receipt('a', '2026-01-02T00:00:00Z')], NOW,
    ).rate).toBe(0.25);
  });
});
