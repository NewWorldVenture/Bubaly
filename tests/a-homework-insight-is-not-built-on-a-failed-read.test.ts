import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// The Homework page's "AI study plan" and the School page's "AI school coach"
// (/api/ai/insights, kinds `homework` and `school`) read their rows with
// `x.data ?? []` and no error check. supabase-js resolves a refused or failed
// read as `{ data: null, error }`, so a failed homework read became
// "Open homework:\nnone" and the model wrote a cheerful plan for a child with
// nothing due, at HTTP 200. The route's own `required()` exists for exactly
// this (tests/an-insight-is-not-built-on-a-household-read-that-failed.test.ts);
// these two kinds never called it.
//
// Both kinds also read "open" homework as `status <> 'done'`, which keeps
// `submitted` work in the list: the coach told a child to start an essay they
// had already handed in. The Homework board (lib/homework/board.ts `isOpen`)
// and the school service (`listHomeworkDue`) both count only `assigned` and
// `in_progress` as still to do.

const FAMILY = 'family-one';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: FAMILY, role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The per-kind plan gate is covered by tests/insight-kinds-are-gated-like-their-pages.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
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
  base.seed('family_members', [{ id: 'member-ava', family_id: FAMILY, display_name: 'Ava', is_active: true }]);
  base.seed('homework_assignments', [
    { id: 'hw-1', family_id: FAMILY, member_id: 'member-ava', title: 'Fractions worksheet', subject: 'Maths', status: 'assigned', due_at: '2099-01-02T15:00:00Z' },
    { id: 'hw-2', family_id: FAMILY, member_id: 'member-ava', title: 'Volcano poster', subject: 'Science', status: 'in_progress', due_at: '2099-01-03T15:00:00Z' },
    { id: 'hw-3', family_id: FAMILY, member_id: 'member-ava', title: 'Book report handed in', subject: 'English', status: 'submitted', due_at: '2099-01-01T15:00:00Z' },
    { id: 'hw-4', family_id: FAMILY, member_id: 'member-ava', title: 'Spelling list finished', subject: 'English', status: 'done', due_at: '2099-01-01T15:00:00Z' },
  ]);
  base.seed('grades', [{ id: 'g-1', family_id: FAMILY, member_id: 'member-ava', subject: 'Maths', grade: 'B', grade_type: 'test', date: '2099-01-01' }]);
});
afterEach(() => vi.restoreAllMocks());

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('a homework or school insight is not built on a failed read', () => {
  it.each([
    ['homework', 'homework_assignments'],
    ['school', 'homework_assignments'],
    ['school', 'grades'],
  ])('%s: a failed %s read answers "could not load", and the model is not asked', async (kind, table) => {
    failing = table;

    const response = await ask(kind);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(['homework', 'school'])('%s: lists the work still to do, and not work already handed in', async (kind) => {
    const response = await ask(kind);

    expect(response.status).toBe(200);
    const text = prompt();
    expect(text).toContain('Fractions worksheet');
    expect(text).toContain('Volcano poster');
    expect(text).not.toContain('Book report handed in');
    expect(text).not.toContain('Spelling list finished');
  });

  it('school: still shows the recent grades beside the open work', async () => {
    const response = await ask('school');

    expect(response.status).toBe(200);
    expect(prompt()).toContain('- Maths: B');
  });
});
