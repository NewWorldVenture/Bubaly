import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextOccurrenceOnOrAfter, projectedNextCharge, subscriptionCadence } from '@/lib/finance/hub';
import { expenseSuggestions, type FamilySnapshot } from '@/lib/autopilot/engine';
import { bodyOf } from './helpers/source-order';

/**
 * A SUBSCRIPTION'S "CHARGE COMING UP" FIRED ONCE, EVER.
 *
 * `subscriptions_tracked.next_charge` is a date someone typed in when they
 * added the subscription, and nothing in the product ever rolls it. The
 * autopilot's expense heads-up (lib/autopilot/engine.ts) measured
 * `daysUntil(today, next_charge)` against that stored date and fired only
 * when it fell within the next week — so it fired for the first cycle and,
 * once the date had passed, never again. The Subscriptions module said
 * "Next on <date>" about a day already gone. The forecast
 * (lib/finance/timeline.ts) alone walked the date forward on its cadence.
 *
 * Now the stored date is read as the series' anchor and projected onto the
 * cadence (`projectedNextCharge`): the heads-up fires every cycle, keyed by
 * the cycle it is about, and the module names the charge actually coming.
 */

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const TODAY = '2026-06-24';
const echo = (key: string) => key;
const snapshot = (subscriptions: FamilySnapshot['subscriptions']): FamilySnapshot =>
  ({ today: TODAY, tz: 'UTC', subscriptions } as unknown as FamilySnapshot);
const sub = (over: Partial<FamilySnapshot['subscriptions'][number]>): FamilySnapshot['subscriptions'][number] =>
  ({ id: 's1', name: 'Netflix', costCents: 1599, cadence: 'monthly', nextCharge: null, lastUsed: TODAY, status: 'active', ...over });

describe('subscriptionCadence', () => {
  it('reads the module\'s four, the forecast\'s aliases, and monthly for anything else', () => {
    expect(subscriptionCadence('weekly')).toBe('weekly');
    expect(subscriptionCadence('Quarterly')).toBe('quarterly');
    expect(subscriptionCadence('annually')).toBe('yearly');
    expect(subscriptionCadence(null)).toBe('monthly');
    expect(subscriptionCadence('sometimes')).toBe('monthly');
  });
});

describe('nextOccurrenceOnOrAfter', () => {
  it('a date still ahead, or today, is itself', () => {
    expect(nextOccurrenceOnOrAfter('2026-06-27', 'monthly', TODAY)).toBe('2026-06-27');
    expect(nextOccurrenceOnOrAfter(TODAY, 'monthly', TODAY)).toBe(TODAY);
  });
  it('a date months gone lands on this cycle\'s day, keeping the anchor\'s day of month', () => {
    expect(nextOccurrenceOnOrAfter('2026-01-27', 'monthly', TODAY)).toBe('2026-06-27');
    expect(nextOccurrenceOnOrAfter('2025-12-14', 'monthly', TODAY)).toBe('2026-07-14');
    expect(nextOccurrenceOnOrAfter('2026-01-31', 'monthly', '2026-02-10')).toBe('2026-02-28');
    expect(nextOccurrenceOnOrAfter('2026-01-31', 'monthly', '2026-03-01')).toBe('2026-03-31');
  });
  it('steps weekly, quarterly and yearly series', () => {
    expect(nextOccurrenceOnOrAfter('2026-01-02', 'weekly', TODAY)).toBe('2026-06-26');
    expect(nextOccurrenceOnOrAfter('2025-11-10', 'quarterly', TODAY)).toBe('2026-08-10');
    expect(nextOccurrenceOnOrAfter('2024-06-30', 'yearly', TODAY)).toBe('2026-06-30');
  });
  it('refuses an anchor that is not a day, and ignores a malformed today', () => {
    expect(nextOccurrenceOnOrAfter('soon', 'monthly', TODAY)).toBeNull();
    expect(nextOccurrenceOnOrAfter('2026-02-30', 'monthly', TODAY)).toBeNull();
    expect(nextOccurrenceOnOrAfter('2026-01-27', 'monthly', 'today')).toBe('2026-01-27');
  });
});

describe('projectedNextCharge', () => {
  it('projects a stored date onto its cadence, and nothing onto nothing', () => {
    expect(projectedNextCharge('2026-01-27', 'monthly', TODAY)).toBe('2026-06-27');
    expect(projectedNextCharge('2026-01-27T00:00:00.000Z', 'monthly', TODAY)).toBe('2026-06-27');
    expect(projectedNextCharge('2026-01-02', 'weekly', TODAY)).toBe('2026-06-26');
    expect(projectedNextCharge('2026-01-27', null, TODAY), 'no cadence reads as monthly').toBe('2026-06-27');
    expect(projectedNextCharge(null, 'monthly', TODAY)).toBeNull();
    expect(projectedNextCharge('', 'monthly', TODAY)).toBeNull();
  });
});

describe('the autopilot heads-up fires every cycle', () => {
  it('a charge whose stored date is five months gone is announced for this month, keyed by this month', () => {
    const out = expenseSuggestions(snapshot([sub({ nextCharge: '2026-01-27' })]), 'en-US', echo);
    const charge = out.filter((o) => o.dedupeKey.startsWith('sub-charge:'));
    expect(charge).toHaveLength(1);
    expect(charge[0].payload).toMatchObject({ subscriptionId: 's1', titleFacts: { kind: 'charge', name: 'Netflix', inDays: 3 } });
    expect(charge[0].dedupeKey).toBe('sub-charge:s1:2026-06-27');
    expect(charge[0].expiresAt).toBe('2026-06-27T23:59:59Z');
  });
  it('a charge whose projected day is more than a week out waits, as a fresh one would', () => {
    const out = expenseSuggestions(snapshot([sub({ nextCharge: '2026-01-14' })]), 'en-US', echo);
    expect(out.filter((o) => o.dedupeKey.startsWith('sub-charge:'))).toHaveLength(0);
  });
  it('a stored date still ahead is read as before', () => {
    const out = expenseSuggestions(snapshot([sub({ nextCharge: '2026-06-27' })]), 'en-US', echo);
    expect(out.map((o) => o.dedupeKey)).toContain('sub-charge:s1:2026-06-27');
  });
});

describe('the Subscriptions module names the charge actually coming', () => {
  it('"Next on" is the projected day, in the family\'s day', () => {
    const src = read('components/modules/subscriptions-module.tsx');
    const workspace = bodyOf(src, 'export function SubscriptionsWorkspace(', 'export function SubscriptionCandidateReview(');
    expect(workspace).toContain('const todayKey = todayInZone(timezone);');
    expect(workspace).toContain('const nextOn = projectedNextCharge(s.next_charge, s.cadence, todayKey);');
    expect(workspace).toContain("{nextOn ? ` · ${t('subscriptionsModule.nextOn', { date: fmtDate(nextOn) })}` : ''}");
    expect(workspace).not.toContain('fmtDate(s.next_charge)');
  });
});
