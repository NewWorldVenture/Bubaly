// The proactive context slice ("what Bubaly has noticed") is loaded for almost
// every assistant intent and is not manager-only, so a guest's prompt got it.
// It read `school_events` and printed the next term start as a "Coming
// transition (school_start, <date>): … <the school's own event title> starts
// in N days", and its counts line told the guest how much homework was due and
// how many sports sessions the children had this week — the school and sports
// detail the activities slice carries, which a guest is not shown.
//
// Driven through `buildContext`, the builder POST /api/ai runs for each turn:
// the slice policy, the proactive slice and the renderer are all real, over an
// in-memory household. Only the counts' source is pinned, because it reads
// through the request client and its own queries are not what is under test.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/family/signals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/family/signals')>()),
  gatherSignalsResult: async () => ({
    data: {
      stress: { score: 20, level: 'calm' },
      completion: {},
      actions: [],
      counts: {
        eventsToday: 1, overdueTasks: 0, dueTodayTasks: 2, overdueBills: 0, billsDueSoon: 0,
        homeworkDueSoon: 4, sportsThisWeek: 3, plannedMeals: 5, emptyGrocery: false,
      },
    },
    error: null,
  }),
}));

import { buildContext } from '@/lib/ai/context/builder';

const FAMILY = 'fam-1';
const NOW = new Date('2026-08-10T15:00:00Z');
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

const scopeFor = (role: ServiceScope['role']): ServiceScope => ({
  db, familyId: FAMILY, userId: `user-${role}`, memberId: `mem-${role}`, role, actorKind: 'ai', tz: 'UTC', now: NOW,
});

async function proactivePrompt(role: ServiceScope['role']): Promise<string> {
  const built = await buildContext(scopeFor(role), { intent: 'daily_brief', slices: ['proactive'] });
  if (!built.ok) throw new Error(built.error);
  expect(built.data.sensitiveOmitted).not.toContain('proactive');
  return built.data.text;
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>() as DB;
  holder.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: 'UTC' }]);
  db.seed('family_members', ['parent', 'child', 'teen', 'caregiver', 'guest'].map((role) => ({
    id: `mem-${role}`, family_id: FAMILY, user_id: `user-${role}`, display_name: role, role, is_active: true,
  })));
  db.seed('school_events', [{ id: 'se-1', family_id: FAMILY, title: 'First day of school at Lincoln Elementary', starts_at: '2026-08-24T12:00:00Z' }]);
});

describe("a guest's context does not carry the children's school", () => {
  it('a guest gets no term-start transition and no homework or sports counts', async () => {
    const text = await proactivePrompt('guest');
    expect(text).not.toContain('school_start');
    expect(text).not.toContain('Lincoln Elementary');
    expect(text).not.toMatch(/homework due soon/);
    expect(text).not.toMatch(/sports this week/);
    // The slice itself still loads for them — the rest of it is theirs.
    expect(text).toContain('Today by the numbers: 1 event today');
    expect(text).toContain('5 meals planned');
    // And the school table was not read for them at all.
    expect(db.log.some((c) => c.table === 'school_events'), 'school_events was read for a guest').toBe(false);
  });

  it.each(['parent', 'child', 'teen', 'caregiver'] as const)('a %s still sees the term start and the counts', async (role) => {
    const text = await proactivePrompt(role);
    expect(text).toContain('Coming transition (school_start, 2026-08-24)');
    expect(text).toContain('Lincoln Elementary');
    expect(text).toContain('4 homework due soon');
    expect(text).toContain('3 sports this week');
  });
});
