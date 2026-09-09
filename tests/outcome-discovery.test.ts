import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OUTCOMES, buildOutcomePlan, outcomeFromParam, outcomePath, outcomesForRoute } from '@/lib/outcomes/launcher';
import { countFromResult, countMatchingResult, discoverOutcomes } from '@/lib/outcomes/discovery';

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { OutcomesStrip } = await import('@/components/outcomes/outcomes-strip');
const { RelatedOutcomes } = await import('@/components/outcomes/related-outcomes');

describe('outcomes discovered from real plan routes', () => {
  it('covers all eight workflows using the existing step destinations as the source of truth', () => {
    for (const outcome of OUTCOMES) {
      for (const step of buildOutcomePlan(outcome.id)) {
        expect(outcomesForRoute(step.href).map((item) => item.id), `${outcome.id} → ${step.href}`).toContain(outcome.id);
      }
    }
    expect(outcomesForRoute('/dashboard/calendar').map((item) => item.id)).toEqual(['run_today', 'plan_trip', 'stay_healthy']);
    expect(outcomesForRoute('/dashboard/meals').map((item) => item.id)).toEqual(['feed_family']);
  });

  it('resolves nested routes, query strings and trailing slashes, without matching similar prefixes or outside URLs', () => {
    expect(outcomesForRoute('/dashboard/trips/abc?tab=packing#list').map((item) => item.id)).toEqual(['plan_trip']);
    expect(outcomesForRoute('/dashboard/meals/').map((item) => item.id)).toEqual(['feed_family']);
    for (const href of ['/dashboard/meals-old', '/dashboard/not-a-module', 'https://example.com/dashboard/meals', '//example.com/dashboard/meals']) expect(outcomesForRoute(href)).toEqual([]);
  });

  it('validates deep links against the real outcome registry', () => {
    for (const outcome of OUTCOMES) {
      expect(outcomeFromParam(new URL(outcomePath(outcome.id), 'https://bubaly.test').searchParams.get('outcome'))).toBe(outcome.id);
    }
    for (const value of ['not-real', ['feed_family'], null, 4, '__proto__']) expect(outcomeFromParam(value)).toBeNull();
  });

  it('promotes outcomes whose source records need attention, with the exact source count', () => {
    const home = discoverOutcomes('/home', { eventsToday: 0, overdueTasks: 0, openGrocery: 12, birthdaysSoon: 1 });
    expect(home.suggestions.slice(0, 2).map((item) => item.outcome.id)).toEqual(['feed_family', 'celebrate']);
    expect(home.suggestions[0].evidence).toEqual([{ count: 12, labelKey: 'outcomeDiscovery.openGrocery' }]);
    const command = discoverOutcomes('/dashboard/command-center', { eventsRemaining: 0, overdueChores: 0, unplannedDinners: 0, expiringDocuments: 4 });
    expect(command.suggestions[0].outcome.id).toBe('prepare_unexpected');
    for (const suggestion of [...home.suggestions, ...command.suggestions]) expect(suggestion.stepCount).toBe(buildOutcomePlan(suggestion.outcome.id).length);
  });

  it('does not turn unknown, malformed or capped source reads into count evidence', () => {
    expect(countFromResult({ count: 50, error: null })).toBe(50);
    expect(countMatchingResult({ count: 50, data: [{ today: true }], error: null }, (row) => row.today)).toBeNull();
    expect(countMatchingResult({ count: 2, data: [{ today: true }, { today: false }], error: null }, (row) => row.today)).toBe(1);
    for (const count of [null, undefined, -1, NaN, 1.5]) expect(countFromResult({ count })).toBeNull();
    expect(countFromResult({ count: 0, error: { message: 'read failed' } })).toBeNull();
    const result = discoverOutcomes('/home', { overdueTasks: null, openGrocery: -1, birthdaysSoon: 2 });
    expect(result.unavailable).toBe(true);
    expect(result.suggestions[0].outcome.id).toBe('celebrate');
    expect(result.suggestions.flatMap((item) => item.evidence)).toEqual([{ count: 2, labelKey: 'outcomeDiscovery.birthdaysSoon' }]);
    expect(discoverOutcomes('/home', { eventsToday: 0, overdueTasks: 0 }).unavailable).toBe(false);
  });
});

describe('reachable outcome cards and chips', () => {
  it('renders live counts and review links without claiming that work ran', async () => {
    const html = renderToStaticMarkup(await OutcomesStrip({ href: '/home', snapshot: { openGrocery: 17, birthdaysSoon: 2 } }));
    expect(html).toContain('Items on the shopping list: 17');
    expect(html).toContain('href="/dashboard/outcomes?outcome=feed_family"');
    expect(html).toContain('Review 4 connected steps');
    expect(html).not.toContain('working on it');
    expect(html).not.toContain('handled');
  });

  it('keeps steps reachable during a source failure and gives the user a refresh destination', async () => {
    const html = renderToStaticMarkup(await OutcomesStrip({ href: '/dashboard/command-center', snapshot: { overdueChores: null } }));
    expect(html).toContain('Some household counts are unavailable');
    expect(html).toContain('href="/dashboard/command-center"');
    expect(html).not.toContain('Overdue chores: 0');
    expect(html).not.toContain('all clear');
  });

  it('renders only outcomes tied to the current module and leaves unknown routes empty', async () => {
    const html = renderToStaticMarkup(await RelatedOutcomes({ href: '/dashboard/meals' }));
    expect(html).toContain(outcomePath('feed_family'));
    expect(html).not.toContain(outcomePath('plan_trip'));
    expect(html).toContain('min-h-11');
    expect(await RelatedOutcomes({ href: '/unrelated' })).toBeNull();
  });
});
