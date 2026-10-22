import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// N2 — POST /api/behavior/insight checked a session and the family's plan and
// nothing else. The Behavior page sends a guest away, shows a teen or a child
// only the notes they wrote, and offers neither the coaching; a direct POST
// with a sibling's member id still read every note written about that sibling
// (the held 0510 leaves RLS family-wide) and coached from them — or, with no
// AI key, answered their counts and categories.
//
// The REAL route against an in-memory database. The plan gate is the one
// thing stubbed (tests/route-plan-gate.test.ts covers it).

const FAMILY = 'family-1';
const SIB = 'member-sib';
const NOTE = 'Ben hid in the bathroom after the fight with his sister';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' as string, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-me' },
    active: { familyId: FAMILY, role: h.role, member: { id: 'member-me' }, family: { name: 'Fixture', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
// The monthly allowance (F19) is its own suite (every-ai-route-counts-against-the-allowance); it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  refuseOverAIAllowance: async () => null,
  withinAIAllowance: async () => true,
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: async () => ({ model: 'test', complete: h.complete }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

const { POST } = await import('@/app/api/behavior/insight/route');

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db as unknown as SupabaseClient<Database>;
  h.role = 'parent';
  h.complete.mockReset().mockResolvedValue({ text: '{"insight":"Coached.","tips":["a","b","c"]}', usage: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('behavior_logs', [
    { id: 'b1', family_id: FAMILY, member_id: SIB, kind: 'concern', category: 'siblings', note: NOTE, points: -1, occurred_at: new Date(Date.now() - 86_400_000).toISOString(), logged_by: 'user-parent' },
    { id: 'b2', family_id: FAMILY, member_id: SIB, kind: 'positive', category: 'chores', note: 'Ben emptied the dishwasher', points: 1, occurred_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), logged_by: 'user-parent' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

const ask = (memberId?: string) => POST(new Request('https://fixture.invalid/api/behavior/insight', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(memberId ? { memberId } : {}),
}) as never);

describe('behaviour coaching answers to the Behavior page\'s rule', () => {
  it.each(['guest', 'teen', 'child'])('a %s asking about a sibling is refused, and no note is read', async (role) => {
    h.role = role;
    const response = await ask(SIB);
    expect(response.status).toBe(403);
    const body = await response.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('concern');
    expect(body).not.toHaveProperty('insight');
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.log.some((entry) => entry.table === 'behavior_logs')).toBe(false);
  });

  it.each(['guest', 'teen', 'child'])('a %s gets no counts or categories from the no-AI fallback either', async (role) => {
    h.role = role;
    h.complete.mockRejectedValue(new Error('AI is not configured'));
    const response = await ask();
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toMatch(/positive|concern|siblings/);
  });

  it.each(['parent', 'adult', 'caregiver'])('a %s is still coached from the family\'s notes', async (role) => {
    h.role = role;
    const response = await ask(SIB);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ insight: 'Coached.', tips: ['a', 'b', 'c'] });
    const prompt = (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;
    expect(prompt).toContain(NOTE);
  });
});
