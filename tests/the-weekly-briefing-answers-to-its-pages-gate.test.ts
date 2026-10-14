// N20 — the weekly briefing endpoint checked "plan level >= 2" and nothing
// else, while its page resolves the admin-overridable tier
// (`requireFeature('/dashboard/weekly-briefing')`). With the feature switched
// Off, a Family+ member's direct POST still made the 2,600-token model call;
// with the tier lowered to Family Basic, the page admitted a Basic family and
// every call it made answered 402.
//
// The endpoint now asks the page's own question (`refuseUnlessEntitled`), and
// a plan below the tier is still the 402 the page's button knows. Driven
// through the real route and the real entitlement resolution: the family's
// plan from the service client, the admin's tier from `app_settings`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { entitledServiceClient } from './helpers/entitled-service-client';

const h = vi.hoisted(() => ({ db: null as unknown, plan: 'plus', complete: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'accept-language': 'en-US' }),
}));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: async () => ({
    user: { id: 'auth-parent', email: 'parent@example.test' },
    active: { familyId: 'family', role: 'parent', member: { id: 'm-parent', display_name: 'Alex' }, family: { name: 'Family', timezone: 'UTC' } },
  }),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => h.db,
  createServiceClient: () => entitledServiceClient(h.plan),
}));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
  describeAIError: () => ({ code: 'unknown', message: 'unknown' }),
}));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_s: unknown, _i: unknown, fn: (obs: { used: () => void; failed: () => void }) => unknown) => fn({ used: () => {}, failed: () => {} }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));

const { POST } = await import('@/app/api/ai/weekly-briefing/route');

let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  db = createInMemorySupabase<SupabaseClient<Database>>();
  h.db = db;
  h.plan = 'plus';
  h.complete.mockReset();
  h.complete.mockResolvedValue({ text: JSON.stringify({ headline: 'A steady week.', dayByDay: [] }), toolCalls: [] });
  db.seed('families', [{ id: 'family', timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'm-parent', family_id: 'family', user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true }]);
  db.seed('grocery_lists', [{ id: 'l-open', family_id: 'family', name: 'Groceries', is_archived: false, archived_at: null }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = () => POST(new NextRequest('http://localhost/api/ai/weekly-briefing', { method: 'POST', body: '{}' }));
const tier = (value: string) => db.seed('app_settings', [{ key: 'feature_tiers', value: { 'weekly-briefing': value } }]);

describe('the weekly briefing endpoint and its page agree', () => {
  it('answers 404 and calls no model when an admin has switched the feature Off', async () => {
    tier('off');

    const res = await post();

    expect(res.status).toBe(404);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('serves a Family Basic family once an admin lowers the feature to Family Basic', async () => {
    tier('basic');
    h.plan = 'basic';

    const res = await post();

    expect(res.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('control: a family below the tier still gets the 402 the page’s button shows as an upgrade', async () => {
    h.plan = 'basic';

    const res = await post();

    expect(res.status).toBe(402);
    expect(h.complete).not.toHaveBeenCalled();
  });
});
