import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// AI Assist (/api/ai/insights) for the kids-and-learning modules, driven through
// the REAL route against an in-memory database:
//
//   S6   the homework planner and school coach printed each due date as its
//        GREENWICH day; an evening deadline in Los Angeles became tomorrow's
//   S10  homework, todos, goals, rewards and timetable dropped a failed read and
//        told the model the family had nothing, answered at HTTP 200; so did
//        the school coach, which wrote a plan for a child with nothing due
//        when its homework or grades read failed
//   S11  the rewards coach's "Total points earned" summed 20 of 40 unordered
//        rows of any status, 'done' included
//   S14/S15  a guest refused the 'school' summary was handed the same homework
//        by the 'homework' kind, and the timetable by 'timetable'

const FAMILY = 'family-one';
const ADA = 'member-ada';
const BO = 'member-bo';
const CY = 'member-cy';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent', complete: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-ada' },
    active: { familyId: FAMILY, role: h.role, member: { id: ADA }, family: { timezone: 'America/Los_Angeles', name: 'Rivers' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: h.createServer }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The Free plan's AI allowance (N18) has its own cases in
// tests/the-free-plans-ai-allowance-holds-on-every-helper.test.ts; it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAccess: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
  assertAIAllowance: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
}));
// The per-kind plan gate is covered by tests/insight-kinds-are-gated-like-their-pages.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null, refuseIfLocked: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/ai/insights/route';

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: string | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T16:00:00Z')); // 09:00 PDT, Wednesday 14 October
  h.role = 'parent';
  // PostgREST's db-max-rows on a default project.
  base = createInMemorySupabase<SupabaseClient<Database>>({ maxRows: 1000 });
  failing = null;
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.createServer.mockReset().mockImplementation(async () => h.db);
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [
    { id: ADA, family_id: FAMILY, display_name: 'Ada', is_active: true },
    { id: BO, family_id: FAMILY, display_name: 'Bo', is_active: true },
    { id: CY, family_id: FAMILY, display_name: 'Cy', is_active: true },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('S10 — a failed read is not an empty family', () => {
  it.each([
    ['homework', 'homework_assignments'],
    ['todos', 'todo_items'],
    ['goals', 'goals'],
    ['rewards', 'chore_assignments'],
    ['rewards', 'reward_redemptions'],
    ['timetable', 'school_classes'],
    ['school', 'homework_assignments'],
    ['school', 'grades'],
  ])('%s: a failed %s read answers "could not load", and the model is not asked', async (kind, table) => {
    failing = table;

    const response = await ask(kind);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(['homework', 'todos', 'goals', 'rewards', 'timetable', 'school'])('%s still answers when every read succeeds', async (kind) => {
    expect((await ask(kind)).status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});

describe('S6 — a due date is the family\'s day', () => {
  beforeEach(() => {
    base.seed('homework_assignments', [
      // 18:00 PDT on Wednesday 14 October is 01:00 UTC on the 15th.
      { id: 'hw-1', family_id: FAMILY, member_id: BO, title: 'Science poster', subject: 'Science', status: 'assigned', due_at: '2026-10-15T01:00:00Z' },
      // 23:59 PDT on the 15th.
      { id: 'hw-2', family_id: FAMILY, member_id: CY, title: 'Book report', subject: 'English', status: 'in_progress', due_at: '2026-10-16T06:59:00Z' },
      // Handed in: not open homework (lib/homework/board.ts isOpen).
      { id: 'hw-3', family_id: FAMILY, member_id: CY, title: 'Handed-in maths', subject: 'Maths', status: 'submitted', due_at: '2026-10-13T20:00:00Z' },
    ]);
  });

  it('the homework planner is told each deadline on the family\'s clock, and only open work', async () => {
    expect((await ask('homework')).status).toBe(200);
    const text = prompt();

    expect(text).toContain('Science poster (Science) — Bo, assigned, due 2026-10-14 18:00');
    expect(text).toContain('Book report (English) — Cy, in_progress, due 2026-10-15 23:59');
    // Greenwich's days, which is what the planner used to be told.
    expect(text).not.toContain('Bo, assigned, due 2026-10-15');
    expect(text).not.toContain('due 2026-10-16');
    expect(text).not.toContain('Handed-in maths');
  });

  it('the school coach is told the same days', async () => {
    expect((await ask('school')).status).toBe(200);
    const text = prompt();

    expect(text).toContain('Science poster (assigned, due: 2026-10-14 18:00)');
    expect(text).not.toContain('due: 2026-10-15)');
    expect(text).not.toContain('Handed-in maths');
  });
});

describe('S11 — the rewards coach is told the ledger, not a sample of it', () => {
  it('earned is every approved chore, spent is approved or fulfilled rewards, per member', async () => {
    base.seed('chore_assignments', [
      // Older approved chores first, so an unordered prefix would be them alone.
      ...Array.from({ length: 30 }, (_, i) => ({ id: `bo-${i}`, family_id: FAMILY, member_id: BO, status: 'approved', points_awarded: 10 })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `cy-${i}`, family_id: FAMILY, member_id: CY, status: 'approved', points_awarded: 5 })),
      // 'done' is not in the ledger (lib/rewards/points, 0439).
      { id: 'cy-done', family_id: FAMILY, member_id: CY, status: 'done', points_awarded: 1000 },
      { id: 'bo-open', family_id: FAMILY, member_id: BO, status: 'todo', points_awarded: null },
      { id: 'cy-submitted', family_id: FAMILY, member_id: CY, status: 'submitted', points_awarded: null },
    ]);
    base.seed('reward_redemptions', [
      { id: 'r1', family_id: FAMILY, member_id: BO, cost_points: 100, status: 'approved', created_at: '2026-10-10T10:00:00Z' },
      { id: 'r2', family_id: FAMILY, member_id: CY, cost_points: 50, status: 'fulfilled', created_at: '2026-10-11T10:00:00Z' },
      { id: 'r3', family_id: FAMILY, member_id: CY, cost_points: 70, status: 'rejected', created_at: '2026-10-12T10:00:00Z' },
    ]);

    expect((await ask('rewards')).status).toBe(200);
    const text = prompt();

    expect(text).toContain('- Bo: earned 300, spent 100, available 200');
    expect(text).toContain('- Cy: earned 150, spent 50, available 100');
    expect(text).toContain('Chores still open (to do, in progress or awaiting approval): 2.');
    expect(text).not.toContain('Total points earned');
  });
});

describe('AUD-1040-LEDGER-PAGING — the rewards coach counts each redemption once', () => {
  it('a request landing between two pages of redemptions does not spend an old reward twice', async () => {
    base.seed('chore_assignments', Array.from({ length: 30 }, (_, i) => ({ id: `cy-${i}`, family_id: FAMILY, member_id: CY, status: 'approved', points_awarded: 10 })));
    base.seed('reward_redemptions', [
      ...Array.from({ length: 999 }, (_, i) => ({ id: `r-${String(i).padStart(4, '0')}`, family_id: FAMILY, member_id: BO, cost_points: 1, status: 'rejected', created_at: '2026-10-12T10:00:00Z' })),
      { id: 'red-approved', family_id: FAMILY, member_id: CY, cost_points: 100, status: 'approved', created_at: '2026-10-01T10:00:00Z' },
      { id: 'r-old', family_id: FAMILY, member_id: BO, cost_points: 1, status: 'rejected', created_at: '2026-09-01T10:00:00Z' },
    ]);
    let pages = 0;
    h.db = withFaults(base, (table) => {
      if (table === 'reward_redemptions' && ++pages === 2) {
        base.seed('reward_redemptions', [{ id: 'req-new', family_id: FAMILY, member_id: BO, cost_points: 500, status: 'requested', created_at: '2026-10-14T15:00:00Z' }]);
      }
      return null;
    });

    expect((await ask('rewards')).status).toBe(200);
    expect(prompt()).toContain('- Cy: earned 300, spent 100, available 200');
  });
});

describe('AUD-1040-LEDGER-PAGING — a ledger refused on a later page is not summed', () => {
  it.each(['chore_assignments', 'reward_redemptions'])('%s refused past its first page: the coach is not asked', async (table) => {
    base.seed('chore_assignments', [{ id: 'cy-1', family_id: FAMILY, member_id: CY, status: 'approved', points_awarded: 10 }]);
    base.seed('reward_redemptions', [{ id: 'r1', family_id: FAMILY, member_id: CY, cost_points: 5, status: 'approved', created_at: '2026-10-10T10:00:00Z' }]);
    h.db = withFaults(base, (faulted, calls) => (faulted === table && calls.some((c) => c.method === 'gt') ? { message: 'Fixture later page refused' } : null));

    expect((await ask('rewards')).status).not.toBe(200);
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('S14/S15 — a guest is refused the homework and timetable summaries, like the school one', () => {
  it.each(['homework', 'timetable', 'school'])('a guest asking for the %s summary is refused before any read', async (kind) => {
    h.role = 'guest';
    const response = await ask(kind);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'insights.thatSummaryIsForThe' });
    expect(h.createServer).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(['child', 'teen', 'caregiver', 'adult'])('a %s still gets the homework and timetable summaries', async (role) => {
    h.role = role;
    expect((await ask('homework')).status).toBe(200);
    expect((await ask('timetable')).status).toBe(200);
  });
});
