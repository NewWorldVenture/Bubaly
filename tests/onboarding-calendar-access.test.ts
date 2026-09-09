import { describe, expect, it, vi } from 'vitest';
import { assertOnboardingCalendarAccess } from '@/lib/services/onboarding-calendar/access';
import type { ServiceScope } from '@/lib/services/types';

const FAMILY = '20000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-09T12:00:00Z');
type Result = { data: unknown; error: unknown; count?: unknown };
type Read = { table: string; columns?: string; options?: unknown; filters: unknown[][] };

function fixture(familyId = FAMILY) {
  const results: Record<string, Result> = {
    app_settings: { data: null, error: null },
    families: { data: { id: FAMILY, trial_ends_at: null, closed_at: null }, error: null },
    subscriptions: { data: [], error: null, count: 0 },
  };
  const reads: Read[] = [];
  const rejected = new Set<string>();
  const constructionFailures = new Set<string>();
  const from = vi.fn((table: string) => {
    if (constructionFailures.has(table)) throw new Error('Read construction failed');
    if (!Object.hasOwn(results, table)) throw new Error(`Unexpected table: ${table}`);
    const read: Read = { table, filters: [] };
    reads.push(read);
    const query = {
      select(columns: string, options?: unknown) { read.columns = columns; read.options = options; return query; },
      eq(column: string, value: unknown) { read.filters.push(['eq', column, value]); return query; },
      in(column: string, values: unknown) { read.filters.push(['in', column, values]); return query; },
      maybeSingle() { return query; },
      then(resolve: (result: Result) => unknown, reject?: (error: unknown) => unknown) {
        return Promise.resolve().then(() => {
          if (rejected.has(table)) throw new Error('Read transport unavailable');
          return results[table];
        }).then(resolve, reject);
      },
    };
    return query;
  });
  const scope: ServiceScope = { db: { from } as unknown as ServiceScope['db'], familyId,
    userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'UTC', now: NOW };
  const tier = (value: unknown) => { results.app_settings.data = { value: { 'calendar-sync': value } }; };
  const family = (patch: Record<string, unknown>) => { results.families.data = { id: FAMILY, trial_ends_at: null, closed_at: null, ...patch }; };
  const subscriptions = (rows: unknown[], count: unknown = rows.length) => { results.subscriptions = { data: rows, error: null, count }; };
  return { scope, results, reads, from, rejected, constructionFailures, tier, family, subscriptions };
}

describe('Calendar Sync configuration before a family exists', () => {
  it.each([null, { value: {} }, { value: { 'another-feature': 'off' } }])('uses the catalog default only after a successful absent override read: %j', async (data) => {
    const h = fixture(''); h.results.app_settings.data = data;
    await expect(assertOnboardingCalendarAccess(h.scope)).resolves.toBeUndefined();
    expect(h.reads).toEqual([{ table: 'app_settings', columns: 'value', options: undefined, filters: [['eq', 'key', 'feature_tiers']] }]);
  });

  it.each(['free', 'basic', 'plus'])('checks configured availability, without inventing a pre-claim family entitlement: %s', async (tier) => {
    const h = fixture(''); h.tier(tier);
    await expect(assertOnboardingCalendarAccess(h.scope)).resolves.toBeUndefined();
    expect(h.from).toHaveBeenCalledTimes(1);
  });

  it('refuses Off before reading any family or subscription', async () => {
    const h = fixture(); h.tier('off');
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
    expect(h.from.mock.calls.map(([table]) => table)).toEqual(['app_settings']);
  });

  it.each([undefined, {}, { value: null }, { value: [] }, { value: 'free' }, { value: false }, { value: 1 }])('refuses a missing or malformed settings payload: %j', async (data) => {
    const h = fixture(''); h.results.app_settings.data = data;
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it.each([null, false, 1, [], {}, '', 'premium', 'FREE'])('refuses an invalid relevant override instead of falling back: %j', async (tier) => {
    const h = fixture(''); h.tier(tier);
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it('ignores unrelated malformed overrides', async () => {
    const h = fixture(); h.results.app_settings.data = { value: { autopilot: null, 'calendar-sync': 'free' } };
    await expect(assertOnboardingCalendarAccess(h.scope)).resolves.toBeUndefined();
  });

  it.each(['query', 'transport', 'construction'] as const)('does not treat a %s configuration failure as a missing row', async (failure) => {
    const h = fixture();
    if (failure === 'query') h.results.app_settings.error = { message: 'Database unavailable' };
    if (failure === 'transport') h.rejected.add('app_settings');
    if (failure === 'construction') h.constructionFailures.add('app_settings');
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
    expect(h.from.mock.calls.map(([table]) => table)).toEqual(['app_settings']);
  });
});

describe('Calendar Sync requires the current family entitlement', () => {
  it('permits a grandfathered family only at the configured Free tier', async () => {
    const h = fixture();
    await expect(assertOnboardingCalendarAccess(h.scope)).resolves.toBeUndefined();
    h.tier('basic');
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it('grants the family trial Basic access and observes the exact expiry boundary', async () => {
    const h = fixture(); h.tier('basic'); h.family({ trial_ends_at: '2026-09-09T08:00:01-04:00' });
    await expect(assertOnboardingCalendarAccess(h.scope)).resolves.toBeUndefined();
    h.tier('plus');
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
    h.tier('free'); h.family({ trial_ends_at: '2026-09-09T08:00:00-04:00' });
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it.each(['family', 'family_annual', 'basic', 'basic_annual'])('recognizes the existing Basic plan %s, including an expired family trial', async (plan) => {
    const h = fixture(); h.family({ trial_ends_at: '2026-01-01T00:00:00Z' });
    h.subscriptions([{ family_id: FAMILY, plan, status: 'active' }]); h.tier('basic');
    await expect(assertOnboardingCalendarAccess(h.scope)).resolves.toBeUndefined();
    h.tier('plus');
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it.each(['plus', 'plus_annual'])('recognizes %s and a complete mixed subscription set', async (plan) => {
    const h = fixture(); h.tier('plus'); h.subscriptions([
      { family_id: FAMILY, plan: 'free', status: 'active' },
      { family_id: FAMILY, plan, status: 'trialing' },
    ]);
    await expect(assertOnboardingCalendarAccess(h.scope)).resolves.toBeUndefined();
  });

  it('does not treat a Free subscription as a paid trial extension', async () => {
    const h = fixture(); h.family({ trial_ends_at: '2026-09-01T00:00:00Z' });
    h.subscriptions([{ family_id: FAMILY, plan: 'free', status: 'trialing' }]);
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it('keeps closed families blocked even with a paid subscription', async () => {
    const h = fixture(); h.subscriptions([{ family_id: FAMILY, plan: 'plus', status: 'active' }]);
    h.family({ closed_at: '2026-09-08T00:00:00Z' });
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it('uses the same strict gate for background/system scope without an administrative preview exemption', async () => {
    const h = fixture(); h.scope = { ...h.scope, role: 'system', actorKind: 'system', userId: null, memberId: null };
    h.tier('off');
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
    h.tier('plus');
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it('re-reads current settings and family status on every check', async () => {
    const h = fixture();
    await expect(assertOnboardingCalendarAccess(h.scope)).resolves.toBeUndefined();
    h.family({ closed_at: '2026-09-09T11:59:00Z' });
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
    h.family({}); h.tier('off');
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
    expect(h.reads.filter((read) => read.table === 'app_settings')).toHaveLength(3);
    expect(h.reads.filter((read) => read.table === 'families')).toHaveLength(2);
  });

  it('scopes the entitlement reads and requests a complete active/trialing subscription count', async () => {
    const h = fixture(); await assertOnboardingCalendarAccess(h.scope);
    expect(h.reads.find((read) => read.table === 'families')?.filters).toEqual([['eq', 'id', FAMILY]]);
    expect(h.reads.find((read) => read.table === 'subscriptions')).toMatchObject({ options: { count: 'exact' },
      filters: [['eq', 'family_id', FAMILY], ['in', 'status', ['active', 'trialing']]] });
  });
});

describe('Calendar Sync refuses incomplete entitlement evidence', () => {
  it.each(['families', 'subscriptions'])('refuses a %s database or transport failure even if the other read succeeds', async (table) => {
    const h = fixture(); h.results[table].error = { message: 'Read failed' };
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
    h.results[table].error = null; h.rejected.add(table);
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it.each([null, undefined, {}, [], { id: 'other-family', trial_ends_at: null, closed_at: null }])('refuses a missing, malformed, or different family: %j', async (data) => {
    const h = fixture(); h.results.families.data = data;
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it.each(['trial_ends_at', 'closed_at'])('refuses invalid or absent %s evidence', async (column) => {
    for (const value of [undefined, '', 'yesterday', '2026-09-09', '2026-09-09T12:00:00', false, 1]) {
      const h = fixture(); h.family({ [column]: value });
      await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
    }
  });

  it.each([null, undefined, {}, 'empty'])('refuses malformed subscription collections: %j', async (data) => {
    const h = fixture(); h.results.subscriptions.data = data;
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it.each([null, undefined, -1, 0.5, '0', 1])('refuses incomplete or missing subscription totals: %j', async (count) => {
    const h = fixture(); h.results.subscriptions.count = count;
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it('refuses capped rows even when the visible paid row would grant access', async () => {
    const h = fixture(); h.tier('plus'); h.subscriptions([{ family_id: FAMILY, plan: 'plus', status: 'active' }], 2);
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });

  it.each([
    {}, { family_id: 'other-family', plan: 'plus', status: 'active' },
    { family_id: FAMILY, plan: 'enterprise', status: 'active' },
    { family_id: FAMILY, plan: 'plus', status: 'canceled' },
    { family_id: FAMILY, plan: null, status: 'active' },
    { family_id: FAMILY, plan: 'plus' },
  ])('refuses malformed or cross-family subscription evidence: %j', async (row) => {
    const h = fixture(); h.subscriptions([row]);
    await expect(assertOnboardingCalendarAccess(h.scope)).rejects.toThrow();
  });
});
