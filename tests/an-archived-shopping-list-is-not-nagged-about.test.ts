// Items on an archived shopping list are not nagged about or briefed.
//
// Archiving a list (the shopping module stamps `grocery_lists.archived_at`)
// takes it and its items off the shopping page, and every reader that goes
// through the groceries service or the household speaker skips it: "reading
// back a list nobody looks at is worse than saying nothing, because it sounds
// authoritative" (lib/assistant/service.ts). `grocery_lists` has two archive
// columns, `is_archived` (0002) and `archived_at` (0014); both are asked.
//
// Three readers of `grocery_items` ignored the list's archive state:
//
//   * Autopilot (lib/autopilot/scan.ts) turned every unchecked item a week old
//     into a "Still need: <item>" suggestion, every leftover on a list the
//     family had archived included;
//   * the Briefing page (POST /api/ai/briefing) and the weekly briefing
//     (POST /api/ai/weekly-briefing) gave those items to the model as
//     "GROCERIES STILL NEEDED".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runAutopilotScan } from '@/lib/autopilot/scan';
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
const TEN_DAYS_AGO = '2026-08-28T12:00:00Z';

/** One open list, one archived the way the app archives, one archived the 0002 way. */
function household(db: InMemorySupabase, familyId: string) {
  db.seed('families', [{ id: familyId, timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'm-parent', family_id: familyId, user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true }]);
  db.seed('grocery_lists', [
    { id: 'l-open', family_id: familyId, name: 'Groceries', is_archived: false, archived_at: null },
    { id: 'l-archived', family_id: familyId, name: 'Party shop', is_archived: false, archived_at: '2026-08-30T10:00:00Z' },
    { id: 'l-legacy', family_id: familyId, name: 'Old list', is_archived: true, archived_at: null },
  ]);
  db.seed('grocery_items', [
    { id: 'g-milk', family_id: familyId, list_id: 'l-open', name: 'Milk', category: 'dairy', is_checked: false, created_at: TEN_DAYS_AGO },
    { id: 'g-hats', family_id: familyId, list_id: 'l-archived', name: 'Party hats', category: null, is_checked: false, created_at: TEN_DAYS_AGO },
    { id: 'g-flour', family_id: familyId, list_id: 'l-legacy', name: 'Rye flour', category: null, is_checked: false, created_at: TEN_DAYS_AGO },
  ]);
}

const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;

describe('Autopilot', () => {
  it('asks about an item still on an open list, and only that one', async () => {
    const db = createInMemorySupabase({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] } });
    household(db, 'family-1');

    await runAutopilotScan(db as never, 'family-1', 'user-1', 'UTC', 'en-US', echo, NOW);

    const grocery = db.table('autopilot_suggestions').filter((row) => row.kind === 'groceries');
    expect(grocery.map((row) => row.dedupe_key)).toEqual(['grocery:g-milk']);
  });

  it('does not scan at all when the lists cannot be read', async () => {
    const db = createInMemorySupabase({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] } });
    household(db, 'family-1');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = {
      ...db,
      from: (table: string) => {
        if (table !== 'grocery_lists') return db.from(table);
        const reply = { data: null, error: { code: '08006', message: 'connection lost', details: null, hint: null } };
        const chain: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'is', 'in', 'order', 'limit']) chain[method] = () => chain;
        chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(reply).then(resolve);
        return chain;
      },
    };

    await expect(runAutopilotScan(failing as never, 'family-1', 'user-1', 'UTC', 'en-US', echo, NOW)).rejects.toThrow();
    expect(db.table('autopilot_suggestions')).toEqual([]);
    err.mockRestore();
  });
});

describe('the briefings', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    db = createInMemorySupabase<DB>();
    household(db, 'family');
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

  /** Everything the model was given, as one string. */
  const prompt = () => {
    expect(mocks.complete).toHaveBeenCalled();
    return JSON.stringify(mocks.complete.mock.calls[0][0]);
  };

  it('the daily briefing tells the model only what is on an open list', async () => {
    await dailyBriefing(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: JSON.stringify({ type: 'morning' }) }));

    const sent = prompt();
    expect(sent).toContain('GROCERIES STILL NEEDED (1 items)');
    expect(sent).toContain('Milk');
    expect(sent).not.toContain('Party hats');
    expect(sent).not.toContain('Rye flour');
  });

  it('the weekly briefing tells the model only what is on an open list', async () => {
    await weeklyBriefing(new NextRequest('http://localhost/api/ai/weekly-briefing', { method: 'POST', body: JSON.stringify({}) }));

    const sent = prompt();
    expect(sent).toContain('GROCERIES STILL NEEDED (1)');
    expect(sent).toContain('Milk');
    expect(sent).not.toContain('Party hats');
    expect(sent).not.toContain('Rye flour');
  });

  // AUD-1022-L2. A list the briefing could not read is not an empty list: told
  // "GROCERIES STILL NEEDED (0)", the model writes a confident "nothing to buy".
  // Both ways a read fails: the database answers an error, or the request never
  // completes and the promise rejects (settleAll turns that into an error too).
  const RAW = 'raw-detail-08006 connection to 10.0.0.7 lost';

  /** The household, with one grocery table's reads failing the given way. */
  function failing(table: 'grocery_lists' | 'grocery_items', mode: 'returns an error' | 'rejects') {
    return new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'from') return Reflect.get(target, key, receiver);
        return (name: string) => {
          if (name !== table) return target.from(name);
          const chain: Record<string, unknown> = {};
          for (const method of ['select', 'eq', 'neq', 'is', 'in', 'not', 'gte', 'lte', 'order', 'limit']) chain[method] = () => chain;
          chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => (mode === 'rejects'
            ? Promise.reject(new TypeError(`fetch failed: ${RAW}`))
            : Promise.resolve({ data: null, error: { code: '08006', message: RAW, details: null, hint: null } })).then(resolve, reject);
          return chain;
        };
      },
    });
  }

  const routes = {
    daily: { post: dailyBriefing, url: 'http://localhost/api/ai/briefing', body: { type: 'morning' }, key: 'briefing.failedToGenerateBriefing', log: '[api/ai/briefing] grocery read failed' },
    weekly: { post: weeklyBriefing, url: 'http://localhost/api/ai/weekly-briefing', body: {}, key: 'weeklyBriefing.failedToGenerateWeeklyBriefing', log: '[api/ai/weekly-briefing] grocery read failed' },
  } as const;
  const cases = (['daily', 'weekly'] as const).flatMap((route) => (['grocery_lists', 'grocery_items'] as const)
    .flatMap((table) => (['returns an error', 'rejects'] as const).map((mode) => [route, table, mode] as const)));

  it.each(cases)('the %s briefing is unavailable, not empty, when the %s read %s', async (route, table, mode) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.server.mockResolvedValue(failing(table, mode));
    const { post, url, body, key, log } = routes[route];

    const res = await post(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

    expect(res.status).toBe(503);
    const answer = await res.json();
    // The route's own message, in the reader's language; never the database's words.
    expect(answer).toEqual({ error: translate(getMessages('en-US'), key) });
    expect(JSON.stringify(answer)).not.toContain('raw-detail');
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(log, expect.objectContaining({ message: expect.stringContaining(RAW) }));
  });
});
