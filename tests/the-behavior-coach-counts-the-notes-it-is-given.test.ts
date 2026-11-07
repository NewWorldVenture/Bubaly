import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// The Behavior page's AI coach (POST /api/ai/insights, kind 'behavior') read
// the family's notes and then counted them by `sentiment` and `score`, columns
// behavior_logs never had: 00730 gave it `kind` (positive / concern / neutral)
// and `points`. So every family's coach was told "0 positive, 0 challenging"
// over the notes it had just been handed, whatever they said, and asked to
// celebrate a pattern and soften a challenge it was told did not exist. Its
// sample of notes carried the child's member id rather than their name, so the
// coach could not tell one child's notes from a sibling's.
//
// Driven through the real route against an in-memory database.

const FAMILY = 'family-one';
const ME = 'member-me';
const KID = 'member-kid';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-me' },
    active: { familyId: FAMILY, role: 'parent', member: { id: ME }, family: { timezone: 'America/Los_Angeles', name: 'Fixture' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAccess: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
  assertAIAllowance: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

const { POST } = await import('@/app/api/ai/insights/route');

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));
  db = createInMemorySupabase<SupabaseClient<Database>>();
  h.db = db;
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [
    { id: ME, family_id: FAMILY, display_name: 'Ada', is_active: true, birthday: null },
    { id: KID, family_id: FAMILY, display_name: 'Ben', is_active: true, birthday: '2016-04-02' },
  ]);
  db.seed('behavior_logs', [
    { id: 'b1', family_id: FAMILY, member_id: KID, kind: 'positive', category: 'kindness', note: 'Shared his lunch', points: 1, occurred_at: '2026-10-12T17:00:00Z', logged_by: 'user-me' },
    { id: 'b2', family_id: FAMILY, member_id: KID, kind: 'positive', category: 'responsibility', note: 'Fed the cat unasked', points: 1, occurred_at: '2026-10-11T17:00:00Z', logged_by: 'user-me' },
    { id: 'b3', family_id: FAMILY, member_id: KID, kind: 'concern', category: 'respect', note: 'Slammed the door', points: -1, occurred_at: '2026-10-10T17:00:00Z', logged_by: 'user-me' },
    { id: 'b4', family_id: FAMILY, member_id: KID, kind: 'neutral', category: 'mood', note: 'A quiet day', points: 0, occurred_at: '2026-10-09T17:00:00Z', logged_by: 'user-me' },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ask = () => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'behavior' }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('the behavior coach is told what the notes say', () => {
  it('counts the positive and the challenging notes by their kind', async () => {
    const response = await ask();
    expect(response.status).toBe(200);
    expect(prompt()).toContain('Behavior logs (recent 4): 2 positive, 1 challenging.');
  });

  it('a neutral note is neither positive nor challenging, whatever its points', async () => {
    db.seed('behavior_logs', [
      { id: 'b5', family_id: FAMILY, member_id: KID, kind: 'neutral', category: 'focus', note: 'Bonus for tidying', points: 3, occurred_at: '2026-10-08T17:00:00Z', logged_by: 'user-me' },
    ]);
    await ask();
    expect(prompt()).toContain('Behavior logs (recent 5): 2 positive, 1 challenging.');
  });

  it('names the child each sampled note is about, with its kind, and no member id', async () => {
    await ask();
    const text = prompt();
    expect(text).toContain('{"member":"Ben","kind":"concern","category":"respect","note":"Slammed the door"}');
    expect(text).not.toContain(KID);
  });
});
