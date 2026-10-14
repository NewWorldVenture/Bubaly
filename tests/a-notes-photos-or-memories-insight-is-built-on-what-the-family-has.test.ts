// N14 — AI Assist for notes, photos and trip memories.
//
//   * None of the three passed its reads through required(), so a refused or
//     timed-out read became [] and the model was told "No notes yet.",
//     "Photos: 0 total. Albums: 0." or "Trip memories recorded: 0" — answered
//     at HTTP 200 and shown as a grounded insight about an empty household.
//   * "Photos: N total" was the length of a read capped at 20 (memories the
//     same), so a family with thousands of photos was told it had 20.
//   * The notes prompt read `n.content`; notes have a `body` (0002_tables.sql)
//     and no `content`, so every note reached the model as its title alone.
//
// Driven through the REAL route (POST /api/ai/insights) and prompt builders
// against an in-memory database; only the model is replaced, by a recorder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The Free plan's AI allowance (N18) has its own cases in
// tests/the-free-plans-ai-allowance-holds-on-every-helper.test.ts; it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAccess: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
}));
// The per-kind plan gate is covered by tests/insight-kinds-are-gated-like-their-pages.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null, refuseIfLocked: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/ai/insights/route';

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: string | null;

beforeEach(() => {
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Ada', is_active: true }]);
});
afterEach(() => vi.restoreAllMocks());

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('a notes, photos or memories insight is not built on a read that failed', () => {
  it.each([
    ['notes', 'notes'],
    ['photos', 'family_photos'], ['photos', 'family_albums'],
    ['memories', 'trip_memories'], ['memories', 'vacations'],
  ])('%s: a failed %s read answers "could not load", and the model is not asked', async (kind, table) => {
    failing = table;

    const response = await ask(kind);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('the prompt says what the family actually has', () => {
  it('a note reaches the model with its body, not its title alone', async () => {
    base.seed('notes', [{ id: 'n1', family_id: FAMILY, title: 'School', body: 'Sign the permission slip by Friday', updated_at: '2026-10-12T00:00:00Z' }]);

    expect((await ask('notes')).status).toBe(200);
    expect(prompt()).toContain('"School": Sign the permission slip by Friday');
  });

  it('photos and albums are counted, not measured off a read capped at 20', async () => {
    base.seed('family_photos', Array.from({ length: 45 }, (_, i) => ({ id: `p${i}`, family_id: FAMILY, storage_path: `x/${i}.jpg`, created_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` })));
    base.seed('family_albums', Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, family_id: FAMILY, name: `Album ${i}`, created_at: '2026-09-01T00:00:00Z' })));

    expect((await ask('photos')).status).toBe(200);
    expect(prompt()).toContain('Photos: 45 total. Albums: 12 total.');
  });

  it('trip memories and vacations are counted too', async () => {
    base.seed('trip_memories', Array.from({ length: 33 }, (_, i) => ({ id: `m${i}`, family_id: FAMILY, title: `Memory ${i}`, memory_date: '2026-08-01' })));
    base.seed('vacations', Array.from({ length: 14 }, (_, i) => ({ id: `v${i}`, family_id: FAMILY, title: `Trip ${i}`, created_at: '2026-08-01T00:00:00Z' })));

    expect((await ask('memories')).status).toBe(200);
    expect(prompt()).toContain('Trip memories recorded: 33. Vacations logged: 14.');
  });
});
