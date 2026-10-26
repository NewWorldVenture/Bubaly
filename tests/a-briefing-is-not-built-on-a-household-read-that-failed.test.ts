// S16 — the AI briefings stated "0 chores due", "0% completion" and an empty
// digest whenever the read behind them failed.
//
// POST /api/ai/briefing bound only `{ data }` for chore_assignments and the
// concierge digest's reads (bills, medications, maintenance_tasks,
// home_warranties, vacations, pantry), so a failed read became
// "CHORES DUE TODAY (0): - None overdue" and a concierge digest with nothing in
// it — "You're all caught up" — at HTTP 200. POST /api/ai/weekly-briefing did
// the same with both of its chore reads, and its prompt then ORDERED the recap
// to report 0% completion. The cron's delivery (lib/briefing/deliver.ts) fails
// closed on the same digest reads; the routes now do what they already did for
// the calendar and the groceries.
//
// The daily brief's appointments read was the same: a failed read was briefed
// as "MEDICAL APPOINTMENTS THIS WEEK: - None" at 200, while the weekly brief
// already refused on it. It now refuses too.
//
// Driven through the REAL routes against an in-memory household, with one
// table's reads failing each way a read fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { entitledServiceClient } from './helpers/entitled-service-client';

const mocks = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn(), complete: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'accept-language': 'en-US' }),
}));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: mocks.context,
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: mocks.server,
  createServiceClient: () => entitledServiceClient('plus'),
}));
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => 2,
}));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: mocks.complete }),
  describeAIError: (error: unknown) => String(error),
}));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, _input: unknown, fn: (obs: { used: () => void }) => unknown) => fn({ used: () => {} }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ countHandledThisWeek: async () => ({ total: 0 }) }));
import { POST as dailyBriefing } from '@/app/api/ai/briefing/route';
import { POST as weeklyBriefing } from '@/app/api/ai/weekly-briefing/route';
import { getMessages, translate } from '@/lib/i18n/messages';

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-09-07T12:00:00Z');
const RAW = 'raw-detail-57014 canceling statement due to statement timeout';

let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase<DB>();
  db.seed('families', [{ id: 'family', timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'm-parent', family_id: 'family', user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true }]);
  db.seed('grocery_lists', [{ id: 'l-open', family_id: 'family', name: 'Groceries', is_archived: false, archived_at: null }]);
  // What a healthy read would have told the brief.
  db.seed('chore_assignments', [{ id: 'c-1', family_id: 'family', member_id: 'm-parent', status: 'todo', due_at: '2026-09-07T08:00:00Z' }]);
  db.seed('maintenance_tasks', [{ id: 'mt-1', family_id: 'family', title: 'Replace the smoke alarm batteries', status: 'todo', due_at: '2026-09-01T00:00:00Z', completed_at: null }]);
  db.seed('home_warranties', [{ id: 'w-1', family_id: 'family', name: 'Dishwasher warranty', expires_on: '2026-09-20', deleted_at: null }]);
  db.seed('vacations', [{ id: 'v-1', family_id: 'family', title: 'Lake week', destination: 'Tahoe', start_date: '2026-09-25', end_date: '2026-09-30', status: 'planning' }]);
  mocks.server.mockResolvedValue(db);
  mocks.context.mockResolvedValue({
    user: { id: 'auth-parent' },
    active: { familyId: 'family', role: 'parent', member: { id: 'm-parent', display_name: 'Alex' }, family: { name: 'Family', timezone: 'UTC' } },
  });
  mocks.complete.mockReset();
  mocks.complete.mockResolvedValue({ text: '{}', toolCalls: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The household, with every read of one table failing the given way. */
function failing(table: string, mode: 'returns an error' | 'rejects') {
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'from') return Reflect.get(target, key, receiver);
      return (name: string) => {
        if (name !== table) return target.from(name);
        const chain: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'neq', 'is', 'in', 'not', 'or', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range', 'abortSignal']) chain[method] = () => chain;
        chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => (mode === 'rejects'
          ? Promise.reject(new TypeError(`fetch failed: ${RAW}`))
          : Promise.resolve({ data: null, error: { code: '57014', message: RAW, details: null, hint: null } })).then(resolve, reject);
        return chain;
      };
    },
  });
}

const routes = {
  daily: { post: dailyBriefing, url: 'http://localhost/api/ai/briefing', body: { type: 'morning' }, key: 'briefing.failedToGenerateBriefing' },
  weekly: { post: weeklyBriefing, url: 'http://localhost/api/ai/weekly-briefing', body: {}, key: 'weeklyBriefing.failedToGenerateWeeklyBriefing' },
} as const;

const cases = [
  ...(['chore_assignments', 'bills', 'medication_schedules', 'maintenance_tasks', 'home_warranties', 'vacations', 'pantry_items'] as const).map((table) => ['daily', table] as const),
  // The daily brief bound only `data` from its appointments read too, so a
  // failed read reached the prompt as "MEDICAL APPOINTMENTS THIS WEEK: - None"
  // and the brief told the family there was nothing to take a child to.
  ['daily', 'appointments'] as const,
  // And its members, school, sports, reminders and meals reads, which the
  // weekly brief already refuses on (N5): a failed one was "- None".
  ...(['family_members', 'school_events', 'sports_events', 'reminders', 'meal_plans'] as const).map((table) => ['daily', table] as const),
  // N5: the weekly brief bound only `data` from these, so a failed read was
  // briefed as an empty week ("nothing scheduled", "- none") at 200.
  ...(['chore_assignments', 'calendar_events', 'school_events', 'sports_events', 'appointments', 'meal_plans', 'reminders', 'family_members'] as const)
    .map((table) => ['weekly', table] as const),
].flatMap(([route, table]) => (['returns an error', 'rejects'] as const).map((mode) => [route, table, mode] as const));

describe('a briefing is unavailable, not empty, when a household read fails', () => {
  it.each(cases)('the %s briefing, when the %s read %s', async (route, table, mode) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.server.mockResolvedValue(failing(table, mode));
    const { post, url, body, key } = routes[route];

    const res = await post(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

    expect(res.status).toBe(503);
    const answer = await res.json();
    // The route's own words, never the database's.
    expect(answer).toEqual({ error: translate(getMessages('en-US'), key) });
    expect(JSON.stringify(answer)).not.toContain('raw-detail');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each(['daily', 'weekly'] as const)('the %s briefing still answers when every read succeeds', async (route) => {
    const { post, url, body } = routes[route];
    // The weekly brief needs a reply that is a briefing (N14): an empty object is not one.
    if (route === 'weekly') mocks.complete.mockResolvedValue({ text: JSON.stringify({ headline: 'A steady week.', dayByDay: [] }), toolCalls: [] });

    const res = await post(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

    expect(res.status).toBe(200);
  });
});
