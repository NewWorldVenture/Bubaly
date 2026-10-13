// A14 — the notifications, settings and announcements insights read with their
// errors dropped.
//
// Each of these kinds returned `x.data ?? []`, so a failed read reached the
// model as "Recent notifications: none" or "Activity counts: 0" and its
// "nothing needs your attention" / "set up your calendar" came back at HTTP
// 200. The route's own `required()` — added so "a refused query must never
// reach a model as nothing found" — now covers them too.
//
// Driven through POST /api/ai/insights, against an in-memory household.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null, refuseIfLocked: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/ai/insights/route';

let failing: string | null;

beforeEach(() => {
  const base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'Nothing needs your attention.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [{ id: 'member-one', family_id: 'family-one', display_name: 'Ada', is_active: true, user_id: 'user-one' }]);
});
afterEach(() => vi.restoreAllMocks());

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));

const READS: [string, string][] = [
  ['notifications', 'notifications'],
  ['settings', 'calendar_events'],
  ['settings', 'todo_items'],
  ['settings', 'chores'],
  ['settings', 'meals'],
  ['settings', 'documents'],
  ['announcements', 'family_announcements'],
];

describe('a household summary is not built on a read that failed', () => {
  it.each(READS)('%s: a failed %s read answers "could not load", and the model is not asked', async (kind, table) => {
    failing = table;
    const response = await ask(kind);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(['notifications', 'settings', 'announcements'])('%s still answers when every read succeeds (control)', async (kind) => {
    const response = await ask(kind);
    expect(response.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});
