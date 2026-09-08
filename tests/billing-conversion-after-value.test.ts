// X10 — conversion among families that reached first value, and how long it
// took them. The ordering rule is the point: a family already paying before the
// milestone did not convert because of it.
//
// The second column of this file is `paidAt`, NOT `subscriptions.created_at`:
// this repo writes one subscriptions row per family at family creation and
// updates it in place, so `created_at` is the family's birthday and using it
// made `converted` structurally zero.
import { describe, it, expect } from 'vitest';
import { conversionAfterValue, type ActivationReach, type ConversionSubscription } from '@/lib/billing/conversion';

const reach = (familyId: string, reachedAt: string): ActivationReach => ({ familyId, reachedAt });
const sub = (
  familyId: string,
  paidAt: string,
  over: Partial<ConversionSubscription> = {},
): ConversionSubscription => ({ familyId, plan: 'family', status: 'active', paidAt, ...over });

describe('conversionAfterValue', () => {
  it('is null — not 0% — when nobody has reached first value', () => {
    const c = conversionAfterValue([], [sub('f1', '2026-01-01T00:00:00.000Z')]);
    expect(c.families).toBe(0);
    expect(c.rate).toBeNull();
    expect(c.medianDays).toBeNull();
  });

  it('counts a family that went paid after the milestone', () => {
    const c = conversionAfterValue(
      [reach('f1', '2026-01-01T00:00:00.000Z')],
      [sub('f1', '2026-01-03T00:00:00.000Z')],
    );
    expect(c).toMatchObject({ families: 1, converted: 1, rate: 1, medianDays: 2 });
  });

  it('does NOT count a family that was already paying before the milestone', () => {
    const c = conversionAfterValue(
      [reach('f1', '2026-02-01T00:00:00.000Z')],
      [sub('f1', '2026-01-01T00:00:00.000Z')],
    );
    expect(c.converted).toBe(0);
    expect(c.rate).toBe(0);
    expect(c.medianDays).toBeNull();
  });

  it('ignores free and non-active subscriptions', () => {
    const c = conversionAfterValue(
      [reach('f1', '2026-01-01T00:00:00.000Z'), reach('f2', '2026-01-01T00:00:00.000Z')],
      [
        sub('f1', '2026-01-02T00:00:00.000Z', { plan: 'free' }),
        sub('f2', '2026-01-02T00:00:00.000Z', { status: 'trialing' }),
      ],
    );
    expect(c.converted).toBe(0);
    expect(c.families).toBe(2);
  });

  it('counts a family once, from its earliest reach', () => {
    const c = conversionAfterValue(
      [
        reach('f1', '2026-01-05T00:00:00.000Z'),
        reach('f1', '2026-01-01T00:00:00.000Z'),
        reach('f1', '2026-01-09T00:00:00.000Z'),
      ],
      [sub('f1', '2026-01-03T00:00:00.000Z')],
    );
    expect(c.families).toBe(1);
    expect(c.converted).toBe(1);
    expect(c.medianDays).toBe(2);
  });

  it('takes the earliest paid moment when a family has several rows', () => {
    const c = conversionAfterValue(
      [reach('f1', '2026-01-01T00:00:00.000Z')],
      [sub('f1', '2026-01-11T00:00:00.000Z'), sub('f1', '2026-01-05T00:00:00.000Z')],
    );
    expect(c.medianDays).toBe(4);
  });

  it('reports the median across families', () => {
    const c = conversionAfterValue(
      ['f1', 'f2', 'f3'].map((f) => reach(f, '2026-01-01T00:00:00.000Z')),
      [
        sub('f1', '2026-01-02T00:00:00.000Z'),   // 1 day
        sub('f2', '2026-01-11T00:00:00.000Z'),   // 10 days
        sub('f3', '2026-01-06T00:00:00.000Z'),   // 5 days
      ],
    );
    expect(c.rate).toBe(1);
    expect(c.medianDays).toBe(5);
  });

  it('averages the middle two on an even count', () => {
    const c = conversionAfterValue(
      ['f1', 'f2', 'f3', 'f4'].map((f) => reach(f, '2026-01-01T00:00:00.000Z')),
      [
        sub('f1', '2026-01-02T00:00:00.000Z'),   // 1
        sub('f2', '2026-01-04T00:00:00.000Z'),   // 3
        sub('f3', '2026-01-06T00:00:00.000Z'),   // 5
        sub('f4', '2026-01-08T00:00:00.000Z'),   // 7
      ],
    );
    expect(c.medianDays).toBe(4);
  });

  it('ignores unparseable timestamps rather than producing NaN', () => {
    const c = conversionAfterValue(
      [reach('f1', 'not-a-date'), reach('f2', '2026-01-01T00:00:00.000Z')],
      [sub('f1', '2026-01-02T00:00:00.000Z'), sub('f2', 'nonsense')],
    );
    expect(c.families).toBe(1);
    expect(c.converted).toBe(0);
    expect(Number.isNaN(c.rate as number)).toBe(false);
  });

  it('mixes converted and unconverted into a real rate', () => {
    const c = conversionAfterValue(
      ['f1', 'f2', 'f3', 'f4'].map((f) => reach(f, '2026-01-01T00:00:00.000Z')),
      [sub('f1', '2026-01-02T00:00:00.000Z')],
    );
    expect(c.rate).toBe(0.25);
  });

  it('marks the median approximate when a conversion was dated from the row, not an event', () => {
    const c = conversionAfterValue(
      [reach('f1', '2026-01-01T00:00:00.000Z')],
      [sub('f1', '2026-01-03T00:00:00.000Z', { basis: 'row_updated_at' })],
    );
    expect(c.converted).toBe(1);
    expect(c.medianDaysApproximate).toBe(true);
  });

  it('leaves the median exact when every conversion came from a billing event', () => {
    const c = conversionAfterValue(
      [reach('f1', '2026-01-01T00:00:00.000Z')],
      [sub('f1', '2026-01-03T00:00:00.000Z', { basis: 'event' })],
    );
    expect(c.medianDaysApproximate).toBe(false);
  });
});
