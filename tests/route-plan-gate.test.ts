import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * The AI endpoints behind feature-gated pages.
 *
 * Each of these sits behind a page that `requireFeature` refuses, and each one
 * calls a model — so the fetch was the bypass, on the one surface in the app
 * that costs money per request. Traced on 2026-09-13: of 39 routes under
 * `/api/ai`, nine went through `assertAIAccess` and four resolved the plan by
 * hand; the rest checked only for a session.
 *
 * Fourteen of those served a page that is gated. They are gated now, through
 * the same resolver the page uses.
 */

const state = vi.hoisted(() => ({ db: null as unknown, familyId: 'family-plus', failSubscriptionsRead: false }));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'parent@example.com' },
    memberships: [],
    active: { familyId: state.familyId, role: 'parent', member: { id: 'member-1' } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});

// The rate limiter is the first thing after the gate, and the model call is
// after that. Spying here proves the gate refuses BEFORE anything is spent.
const limiter = vi.hoisted(() => ({ enforce: vi.fn(async () => ({ ok: true as const })) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: limiter.enforce }));
vi.mock('@/lib/ai/provider', () => ({
  resolveProvider: () => null,
  isAIConfigured: () => false,
  describeAIError: () => 'unavailable',
}));

const { POST: savings } = await import('@/app/api/ai/savings/route');

type DB = SupabaseClient<Database>;
const FREE = 'family-free';
const PLUS = 'family-plus';

function failingSubscriptions(db: ReturnType<typeof createInMemorySupabase<DB>>): DB {
  const failing = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'gte', 'lte', 'neq', 'order', 'limit', 'maybeSingle', 'single']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: new Error('subscriptions read failed') }).then(resolve);
    return chain;
  };
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) =>
        state.failSubscriptionsRead && table === 'subscriptions' ? failing() : (target as DB).from(table as never);
    },
  }) as DB;
}

beforeEach(() => {
  limiter.enforce.mockClear();
  state.failSubscriptionsRead = false;
  state.familyId = PLUS;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = createInMemorySupabase<DB>();
  db.seed('families', [
    { id: FREE, name: 'Free household', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
    { id: PLUS, name: 'Plus household', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
  ]);
  db.seed('subscriptions', [{ family_id: PLUS, plan: 'plus', status: 'active' }]);
  state.db = failingSubscriptions(db);
});

describe('an AI endpoint refuses before it spends anything', () => {
  it('answers 403 for a family below the tier, and never reaches the rate limiter', async () => {
    state.familyId = FREE;

    const response = await savings();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'plan_required', needLevel: 1 });
    expect(limiter.enforce).not.toHaveBeenCalled();
  });

  it('lets an entitled family through to the work', async () => {
    state.familyId = PLUS;

    const response = await savings();

    expect(response.status).not.toBe(403);
    expect(limiter.enforce).toHaveBeenCalled();
  });

  it('answers 503 — not 403 — when the plan cannot be read', async () => {
    state.familyId = PLUS;
    state.failSubscriptionsRead = true;

    const response = await savings();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'unavailable' });
    expect(limiter.enforce).not.toHaveBeenCalled();
  });
});

describe('every endpoint behind a gated page carries the gate', () => {
  // The pairing is the finding: each route serves a page that refuses the same
  // families it did not. Removing a line here has to be deliberate.
  const GATED: Record<string, string[]> = {
    'ai/assist': ['/dashboard/inbox', '/dashboard/concierge'],
    'ai/auto/accident': ['/dashboard/auto'],
    'ai/briefing': ['/dashboard/briefing'],
    'ai/chef': ['/dashboard/kitchen'],
    'ai/flyer': ['/dashboard/scan'],
    'ai/health/coach': ['/dashboard/health'],
    'ai/home/diagnose': ['/dashboard/home'],
    'ai/home/find-pro': ['/dashboard/home'],
    'ai/home/forecast': ['/dashboard/home'],
    'ai/home/utility-savings': ['/dashboard/utilities'],
    'ai/import': ['/dashboard/inbox'],
    'ai/resolve-conflict': ['/dashboard/conflicts'],
    'ai/savings': ['/dashboard/subscriptions'],
    'ai/trip': ['/dashboard/trip-intel'],
    // Not under /api/ai, and the same finding: each serves a gated page, and
    // most of them call a model too.
    'behavior/insight': ['/dashboard/behavior'],
    'weekend/discover': ['/dashboard/weekend'],
    'vacations/ai': ['/dashboard/vacations'],
    'vacations/weather': ['/dashboard/vacations'],
    'social/ai': ['/dashboard/social'],
    'notifications/generate': ['/dashboard/notifications'],
  };

  const read = (route: string) => fs.readFileSync(path.join(process.cwd(), 'app/api', route, 'route.ts'), 'utf8');
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each(Object.entries(GATED))('%s gates on %s', (route, hrefs) => {
    const source = stripComments(read(route));
    expect(source).toContain('refuseUnlessEntitled(');
    for (const href of hrefs) expect(source).toContain(`'${href}'`);
  });

  it('refuses before the model is reached in each of them', () => {
    // Ordering is the whole point: a gate after the provider call would refuse
    // the family and still have paid for the answer.
    for (const route of Object.keys(GATED)) {
      const source = stripComments(read(route));
      const gate = source.indexOf('refuseUnlessEntitled(');
      const provider = source.indexOf('resolveProvider(');
      expect(gate).toBeGreaterThan(-1);
      if (provider > -1) expect(gate).toBeLessThan(provider);
    }
  });
});
