// Six modules wrote the currency symbol by hand.
//
// THE DEFECT, and why a locale sweep would have missed it. Each of these carried
// the same line:
//
//   `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
//
// The "$" is a LITERAL and only the digits are localised. Swapping 'en-US' for a
// reader's locale — which is exactly what the hardcoded-locale ratchet rewards —
// produces "$2.768": the American symbol position with German separators, a
// currency notation nobody writes. The ratchet would have counted it converted and
// gone down.
//
// `style: 'currency'` puts the symbol where the locale puts it. So these cases
// assert the exact string AND that the symbol does not lead in a locale that puts
// it last, because neither is visible to `toContain`.
//
// And the separators are written as ESCAPES below, not typed. Intl puts U+00A0
// between a German amount and its symbol and U+202F between French thousands, and
// a test file with a plain space in the expectation fails with two strings that
// look identical in the diff. That is the third time this audit.
//
// The currency itself stays the money's own: a family's move, trip, project and
// salary are quoted in dollars whichever language they read, so fr-FR renders
// "$US" — the dollar, named in French — and never euros.
import { describe, expect, it } from 'vitest';
import { money as careerMoney } from '@/lib/career/hub';
import { money as movingMoney } from '@/lib/moving/planner';
import { money as projectMoney } from '@/lib/projects/planner';
import { dollars as tripDollars } from '@/lib/vacations/meta';
import { dollars as weekendDollars, priceRange } from '@/lib/weekend/meta';
import { simulateDecision } from '@/lib/twin/simulate';
import { groupByMonth } from '@/lib/memories/timeline';
import { weeklyPlan } from '@/lib/declutter/missions';

const WHOLE_DOLLARS: [string, (c: number | null | undefined, l?: 'de-DE' | 'fr-FR') => string][] = [
  ['lib/career/hub money', careerMoney],
  ['lib/moving/planner money', movingMoney],
  ['lib/projects/planner money', projectMoney],
  ['lib/vacations/meta dollars', tripDollars],
];

describe('the six hand-prefixed dollar signs', () => {
  it.each(WHOLE_DOLLARS)('%s puts the symbol where the locale puts it', (_name, fn) => {
    expect(fn(276760)).toBe('$2,768');
    expect(fn(276760, 'de-DE')).toBe('2.768\u00a0$');
    expect(fn(276760, 'fr-FR')).toBe('2\u202f768\u00a0$US');
    // The whole point: a naive locale swap would have left the "$" leading.
    expect(fn(276760, 'de-DE').startsWith('$')).toBe(false);
  });

  it.each(WHOLE_DOLLARS)('%s still returns the em dash for nothing', (_name, fn) => {
    expect(fn(null)).toBe('—');
    expect(fn(undefined, 'de-DE')).toBe('—');
  });

  // weekend/meta returns EMPTY rather than an em dash for an unknown price, which
  // is deliberate: its caller concatenates the result into a chip.
  it('lib/weekend/meta dollars keeps its empty-string contract', () => {
    expect(weekendDollars(null)).toBe('');
    expect(weekendDollars(4500, 'de-DE')).toBe('45\u00a0$');
  });

  it('lib/twin/simulate formats its impact copy for the reader', () => {
    const ctx = { memberEvents: [], budgets: [{ category: 'Fun', limitCents: 50000, spentCents: 10000 }] };
    const decision = { kind: 'spend' as const, label: 'Tickets', category: 'Fun', amountCents: 20000 };
    const en = simulateDecision(decision, ctx);
    const de = simulateDecision(decision, { ...ctx, locale: 'de-DE' });
    expect(en.headline).toContain('$200');
    expect(de.headline).toContain('200\u00a0$');
    expect(de.headline.includes('$200')).toBe(false);
    // The locale must not reach the arithmetic.
    expect(de.verdict).toBe(en.verdict);
    expect(de.impacts.length).toBe(en.impacts.length);
  });
});

describe('priceRange — amounts from the locale, words from the catalogue', () => {
  it('renders a range in the reader locale', () => {
    expect(priceRange(1000, 4500)).toBe('$10–$45');
    expect(priceRange(1000, 4500, 'de-DE')).toBe('10\u00a0$–45\u00a0$');
    expect(priceRange(2000, 2000, 'de-DE')).toBe('20\u00a0$');
  });

  it('falls back to English for the two words when given no translator', () => {
    // The same contract fmtRelative uses for "Today"/"Tomorrow": a caller with no
    // translator gets English rather than a raw key.
    expect(priceRange(1000, null)).toBe('from $10');
    expect(priceRange(null, 4500)).toBe('up to $45');
  });

  it('uses the translator when the caller has one, around a localised amount', () => {
    const t = (key: string, p?: Record<string, string | number>) =>
      key === 'weekend.priceFrom' ? `ab ${p?.price}` : `bis ${p?.price}`;
    expect(priceRange(1000, null, 'de-DE', t)).toBe('ab 10\u00a0$');
    expect(priceRange(null, 4500, 'de-DE', t)).toBe('bis 45\u00a0$');
  });
});

describe('the two date labels in the same tranche', () => {
  it('groups memories under a month label in the reader locale', () => {
    const items = [{ id: '1', kind: 'photo' as const, title: 'Beach', date: '2026-07-04' }];
    expect(groupByMonth(items)[0].label).toBe('July 2026');
    expect(groupByMonth(items, 'de-DE')[0].label).toBe('Juli 2026');
    // NOTE for whoever reads this next: nothing in app/ or components/ imports
    // groupByMonth. It is exported, unit-tested, and rendered by no surface — the
    // second dead tested export this audit has found (lib/location/geo.ts timeAgo
    // was the first).
  });

  it('labels each day of a declutter week in the reader locale', () => {
    const zones = [{ id: 'z1', name: 'Garage', room: null, kind: 'garage' as const, clutter_score: 4, last_reset_at: null, is_active: true }];
    // Local midday on a Monday: weeklyPlan derives its day keys with the local
    // calendar, so a UTC instant would land on Sunday west of Greenwich.
    const monday = new Date(2026, 6, 13, 12, 0, 0);
    const en = weeklyPlan(zones, [], ['m1'], monday);
    const de = weeklyPlan(zones, [], ['m1'], monday, 2, 'de-DE');
    expect(en[0]?.dayLabel).toBe('Mon');
    expect(de[0]?.dayLabel).toBe('Mo');
    // Same plan either way — the locale must not reach the scheduling.
    expect(de.map((p) => p.day)).toEqual(en.map((p) => p.day));
  });
});
