import { describe, expect, it, vi } from 'vitest';
import {
  briefingContextKey, createBriefingSession, parseBriefingResponse, purgeLegacyBriefingCache,
  type BriefingResponse,
} from '@/lib/briefing/cache-isolation';
import { DEFAULT_LOCALE, LOCALES } from '@/lib/i18n/locales';

const day = '2026-09-05';
const context = {
  familyId: 'household-a', userId: 'user-a', role: 'parent' as const,
  isSuperAdmin: false, planLevel: 2, featureTiers: {},
  selfMember: {
    id: 'member-a', family_id: 'household-a', user_id: 'user-a', role: 'parent' as const,
    display_name: 'Member A', color: null, birthday: null, email: null, phone: null,
    avatar_url: null, is_active: true, onboarding_key: null,
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  },
};

function payload(greeting = 'Current member'): BriefingResponse {
  return {
    generatedAt: '2026-09-05T12:00:00.000Z',
    briefing: {
      greeting, subtitle: 'Saturday', familySummary: ['Current household'],
      schedule: [], conflicts: [], kidsNeeds: [], meals: [], reminders: [],
      operationsScore: {
        overall: 90, categories: [], stressLevel: 'low', stressReason: null, recommendation: 'Enjoy today.',
      },
      completed: ['A task'], outstanding: [{ text: 'A reminder', urgency: 'high' }],
      tomorrowPreview: { events: 1, notes: ['An event'] },
      weeklyHighlights: [{ category: 'School', emoji: 'S', items: ['A class'] }], weeklyConflicts: [],
    },
    digest: {
      items: [{ domain: 'bill', urgency: 'today', title: greeting, detail: 'Due today', dueLabel: 'today', dayOffset: 0 }],
      counts: { overdue: 0, today: 1, soon: 0, total: 1 },
      byDomain: [{ domain: 'bill', count: 1 }], headline: '1 due today.',
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const reply = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
});

describe('BRIEF-CACHE-ISOLATION context boundary', () => {
  it('separates every trusted viewer locale while preserving default-call compatibility', () => {
    const keys = LOCALES.map(locale => briefingContextKey(context, day, locale.code));
    expect(new Set(keys).size).toBe(LOCALES.length);
    expect(briefingContextKey(context, day)).toBe(briefingContextKey(context, day, DEFAULT_LOCALE));
  });
  it('separates household, signed-in user, member, and day identities', () => {
    const original = briefingContextKey(context, day);
    expect(original).not.toBeNull();
    const alternatives = [
      { ...context, familyId: 'household-b', selfMember: { ...context.selfMember, family_id: 'household-b' } },
      { ...context, userId: 'user-b', selfMember: { ...context.selfMember, user_id: 'user-b' } },
      { ...context, selfMember: { ...context.selfMember, id: 'member-b' } },
    ];
    for (const next of alternatives) expect(briefingContextKey(next, day)).not.toBe(original);
    expect(briefingContextKey(context, '2026-09-06')).not.toBe(original);
  });

  it('invalidates for both role sources, member updates, admin access, plan, and feature permissions', () => {
    const original = briefingContextKey(context, day);
    const alternatives: Parameters<typeof briefingContextKey>[0][] = [
      { ...context, role: 'guest' },
      { ...context, selfMember: { ...context.selfMember, role: 'guest' } },
      { ...context, selfMember: { ...context.selfMember, updated_at: '2026-09-05T12:00:00.000Z' } },
      { ...context, isSuperAdmin: true },
      { ...context, planLevel: 0 },
      { ...context, featureTiers: { '/dashboard/briefing': 'off' } },
    ];
    for (const next of alternatives) expect(briefingContextKey(next, day)).not.toBe(original);
  });

  it('keeps equivalent context objects stable', () => {
    expect(briefingContextKey({ ...context, selfMember: { ...context.selfMember } }, day))
      .toBe(briefingContextKey(context, day));
  });

  it('fails closed for absent, inactive, or mismatched membership during a switch', () => {
    const invalid = [
      { ...context, familyId: '' }, { ...context, userId: '' }, { ...context, selfMember: null },
      { ...context, selfMember: { ...context.selfMember, is_active: false } },
      { ...context, familyId: 'household-b' }, { ...context, userId: 'user-b' },
    ];
    for (const next of invalid) expect(briefingContextKey(next, day)).toBeNull();
  });
});

describe('persisted cache retirement and runtime contents', () => {
  it('removes valid, malformed, and older legacy entries without reading them or touching unrelated storage', () => {
    const entries = new Map([
      ['fos_briefing_morning_2026-09-05', JSON.stringify(payload('Previous member'))],
      ['fos_briefing_evening_2026-09-05', '{malformed'],
      ['fos_briefing_weekly_2026-08-01', 'null'],
      ['fos_briefing_scoped_forgery', JSON.stringify({ ...payload(), permissionRevision: 'guessed' })],
      ['dashboard-preferences', 'keep'],
    ]);
    const getItem = vi.fn();
    const setItem = vi.fn();
    purgeLegacyBriefingCache({
      get length() { return entries.size; },
      key: index => [...entries.keys()][index] ?? null,
      removeItem: key => { entries.delete(key); },
      ...{ getItem, setItem },
    });
    expect([...entries]).toEqual([['dashboard-preferences', 'keep']]);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('tolerates blocked browser storage', () => {
    expect(() => purgeLegacyBriefingCache({
      get length(): number { throw new Error('Blocked'); },
      key: () => null, removeItem: () => {},
    })).not.toThrow();
  });

  it('preserves the established morning, evening, weekly, and optional digest response fields', () => {
    expect(parseBriefingResponse(payload())).toEqual(payload());
    const withoutDigest = payload();
    delete withoutDigest.digest;
    expect(parseBriefingResponse(withoutDigest)).toEqual(withoutDigest);
  });

  it.each([
    null, [], {},
    { briefing: payload().briefing, at: payload().generatedAt },
    { ...payload(), generatedAt: 'yesterday' },
    { ...payload(), briefing: { ...payload().briefing, schedule: null } },
    { ...payload(), briefing: { ...payload().briefing, familySummary: [{}] } },
    { ...payload(), briefing: { ...payload().briefing, reminders: [{ text: 'Secret', urgency: 'invalid' }] } },
    { ...payload(), briefing: { ...payload().briefing, operationsScore: { ...payload().briefing.operationsScore, stressLevel: 'invalid' } } },
    { ...payload(), digest: { ...payload().digest, items: [{ domain: 'invalid', urgency: 'today' }] } },
    { ...payload(), digest: { ...payload().digest, counts: { overdue: -1, today: 0, soon: 0, total: 0 } } },
  ])('rejects malformed or legacy payload %# before it enters memory', value => {
    expect(parseBriefingResponse(value)).toBeNull();
  });
});

describe('current-context async state', () => {
  it('starts a separate empty session after any identity or permission boundary and when returning to an earlier identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(payload('Private previous brief')));
    const previous = createBriefingSession(fetcher);
    await previous.generate('morning');
    expect(previous.getSnapshot().morning.data?.digest?.items[0].title).toBe('Private previous brief');
    previous.clear();
    for (const session of [previous, createBriefingSession(fetcher), createBriefingSession(fetcher)]) {
      for (const state of Object.values(session.getSnapshot())) {
        expect(state).toEqual({ data: null, loading: false, error: null, attempted: false });
      }
    }
  });

  it('aborts old requests and ignores late successes without clearing the current loading state', async () => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const session = createBriefingSession(fetcher);
    const oldRun = session.generate('morning');
    const oldSignal = fetcher.mock.calls[0][1]?.signal;
    session.clear();
    expect(oldSignal?.aborted).toBe(true);
    const currentRun = session.generate('morning');
    old.resolve(reply(payload('Old member')));
    await oldRun;
    expect(session.getSnapshot().morning).toEqual({ data: null, loading: true, error: null, attempted: true });
    current.resolve(reply(payload('Current member')));
    await currentRun;
    expect(session.getSnapshot().morning.data?.briefing.greeting).toBe('Current member');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ cache: 'no-store', body: JSON.stringify({ type: 'morning' }) });
  });

  it('ignores old response bodies that finish parsing after a context change', async () => {
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json } as unknown as Response);
    const session = createBriefingSession(fetcher);
    const run = session.generate('morning');
    await Promise.resolve();
    expect(json).toHaveBeenCalledOnce();
    session.clear();
    body.resolve(payload('Previous household'));
    await run;
    expect(session.getSnapshot().morning.data).toBeNull();
    expect(session.getSnapshot().morning.attempted).toBe(false);
  });

  it('ignores late failures without replacing the current briefing or error state', async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(reply(payload()));
    const session = createBriefingSession(fetcher);
    const oldRun = session.generate('morning');
    session.clear();
    await session.generate('morning');
    old.reject(new Error('Old household failed'));
    await oldRun;
    expect(session.getSnapshot().morning.error).toBeNull();
    expect(session.getSnapshot().morning.data?.briefing.greeting).toBe('Current member');
  });

  it('keeps tab loading/errors independent and prevents duplicate requests', async () => {
    const morning = deferred<Response>();
    const evening = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(morning.promise).mockReturnValueOnce(evening.promise);
    const session = createBriefingSession(fetcher);
    const first = session.generate('morning');
    await session.generate('morning');
    const second = session.generate('evening');
    expect(fetcher).toHaveBeenCalledTimes(2);
    morning.reject(new Error('Morning failed'));
    await first;
    expect(session.getSnapshot().morning.error).toBe('Morning failed');
    expect(session.getSnapshot().morning.attempted).toBe(true);
    expect(session.getSnapshot().evening).toEqual({ data: null, loading: true, error: null, attempted: true });
    evening.resolve(reply(payload('Evening')));
    await second;
    expect(session.getSnapshot().evening.data?.briefing.greeting).toBe('Evening');
  });

  it('clears briefing, digest, and generated time together on a denied refresh and allows retry', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(payload()))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(reply(payload('Retried')));
    const session = createBriefingSession(fetcher);
    await session.generate('morning');
    await session.generate('morning');
    expect(session.getSnapshot().morning).toEqual({
      data: null, loading: false, error: 'Failed to generate briefing', attempted: true,
    });
    await session.generate('morning');
    expect(session.getSnapshot().morning.data?.briefing.greeting).toBe('Retried');
    expect(session.getSnapshot().morning.error).toBeNull();
  });

  it('shows an actionable error for invalid JSON or invalid shapes and replaces an absent digest atomically', async () => {
    const withoutDigest = payload();
    delete withoutDigest.digest;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{bad json'))
      .mockResolvedValueOnce(reply({ briefing: [] }))
      .mockResolvedValueOnce(reply(payload()))
      .mockResolvedValueOnce(reply(withoutDigest));
    const session = createBriefingSession(fetcher);
    await session.generate('weekly');
    expect(session.getSnapshot().weekly.error).toBeTruthy();
    expect(session.getSnapshot().weekly.loading).toBe(false);
    await session.generate('weekly');
    expect(session.getSnapshot().weekly.error).toBe('Could not read the generated briefing. Please try again.');
    expect(session.getSnapshot().weekly.data).toBeNull();
    await session.generate('weekly');
    expect(session.getSnapshot().weekly.data?.digest).toBeDefined();
    await session.generate('weekly');
    expect(session.getSnapshot().weekly.data?.digest).toBeUndefined();
  });

  it('notifies subscribers of context cleanup and stops notifying after unsubscribe', async () => {
    const session = createBriefingSession(vi.fn<typeof fetch>().mockResolvedValue(reply(payload())));
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    const empty = session.getSnapshot();
    await session.generate('morning');
    expect(session.getSnapshot()).not.toBe(empty);
    expect(listener).toHaveBeenCalledTimes(2);
    session.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    session.clear();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
