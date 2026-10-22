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


// Prompt redaction alone is not a boundary: buildContext returns the structured
// slice and persists it to the requester's ai_request_context snapshot. These
// cases exercise that real builder/ledger path, keeping the original five above.
type ProactiveCountsView = { counts: Record<string, unknown> | null; lifeEvents: { templateKey: string }[] };
const originalCounts = {
  eventsToday: 1, overdueTasks: 0, dueTodayTasks: 2, overdueBills: 0, billsDueSoon: 0,
  homeworkDueSoon: 4, sportsThisWeek: 3, plannedMeals: 5, emptyGrocery: false,
};
async function storedProactive(role: ServiceScope['role'], actorKind: ServiceScope['actorKind'] = 'ai') {
  const scope = { ...scopeFor(role), actorKind };
  const requestId = 'synthetic-context-' + role + '-' + actorKind;
  db.seed('ai_requests', [{ id: requestId, family_id: FAMILY, requested_by: scope.userId, requested_by_member_id: scope.memberId, status: 'processing' }]);
  const built = await buildContext(scope, { intent: 'daily_brief', slices: ['proactive', 'activities'], requestId });
  if (!built.ok) throw new Error(built.error);
  const saved = db.table('ai_request_context').find((row) => row.request_id === requestId);
  expect(saved, 'the builder persisted no context snapshot').toBeTruthy();
  expect(saved?.family_id).toBe(FAMILY);
  expect(db.log.some((call) => call.table === 'ai_request_context')).toBe(true);
  const snapshot = saved?.snapshot as { header: { viewerRole: string }; slices: { proactive: ProactiveCountsView } };
  expect(snapshot.header.viewerRole).toBe(role);
  expect(snapshot.slices.proactive).toEqual(built.data.slices.proactive);
  return { bundle: built.data, returned: built.data.slices.proactive as ProactiveCountsView, saved: snapshot.slices.proactive };
}

describe('a guest school redaction survives the structured and persisted context boundary', () => {
  it.each(['ai', 'member', 'system'] as const)('does not store homework or sports counts for a guest through %s context', async (actorKind) => {
    const result = await storedProactive('guest', actorKind);
    expect(result.returned.counts).not.toHaveProperty('homeworkDueSoon');
    expect(result.returned.counts).not.toHaveProperty('sportsThisWeek');
    expect(result.saved.counts).toEqual({ eventsToday: 1, overdueTasks: 0, dueTodayTasks: 2, overdueBills: 0, billsDueSoon: 0, plannedMeals: 5, emptyGrocery: false });
    expect(JSON.stringify(result.saved)).not.toContain('homeworkDueSoon');
    expect(JSON.stringify(result.saved)).not.toContain('sportsThisWeek');
    expect(result.saved.lifeEvents.some((event) => event.templateKey === 'school_start')).toBe(false);
    expect(result.bundle.text).not.toMatch(/homework due soon|sports this week|Lincoln Elementary/);
    expect(result.bundle.sensitiveOmitted).toContain('activities');
    expect(db.log.some((call) => call.table === 'school_events')).toBe(false);
  });

  it.each(['parent', 'adult', 'child', 'teen', 'caregiver'] as const)('keeps the entire original structured and saved counts for an allowed %s', async (role) => {
    const result = await storedProactive(role);
    expect(result.returned.counts).toEqual(originalCounts);
    expect(result.saved.counts).toEqual(originalCounts);
    expect(result.bundle.text).toContain('4 homework due soon');
    expect(result.bundle.text).toContain('3 sports this week');
    expect(result.bundle.sensitiveOmitted).not.toContain('activities');
  });

  it('redacts zero counts as omitted information rather than a made-up no-homework answer', async () => {
    const signals = await import('@/lib/family/signals');
    const spy = vi.spyOn(signals, 'gatherSignalsResult').mockResolvedValue({
      data: { stress: { score: 20, level: 'calm' }, completion: {}, actions: [], counts: { ...originalCounts, homeworkDueSoon: 0, sportsThisWeek: 0 } }, error: null,
    } as never);
    try {
      const result = await storedProactive('guest');
      expect(result.saved.counts).not.toHaveProperty('homeworkDueSoon');
      expect(result.saved.counts).not.toHaveProperty('sportsThisWeek');
      expect(result.bundle.text).not.toContain('0 homework');
    } finally { spy.mockRestore(); }
  });

  it('does not mutate source counts used by a later authorized reader', async () => {
    const signals = await import('@/lib/family/signals');
    const shared = { stress: { score: 20, level: 'calm' }, completion: {}, actions: [], counts: { ...originalCounts } };
    const spy = vi.spyOn(signals, 'gatherSignalsResult').mockResolvedValue({ data: shared, error: null } as never);
    try {
      const guest = await storedProactive('guest');
      expect(guest.saved.counts).not.toHaveProperty('homeworkDueSoon');
      expect(shared.counts).toEqual(originalCounts);
      const parent = await storedProactive('parent');
      expect(parent.saved.counts).toEqual(originalCounts);
      expect(shared.counts).toEqual(originalCounts);
    } finally { spy.mockRestore(); }
  });

  it('keeps unavailable source counts null instead of claiming an empty household', async () => {
    const signals = await import('@/lib/family/signals');
    const spy = vi.spyOn(signals, 'gatherSignalsResult').mockResolvedValue({ data: null, error: 'Synthetic count read unavailable' } as never);
    try {
      const result = await storedProactive('guest');
      expect(result.returned.counts).toBeNull();
      expect(result.saved.counts).toBeNull();
      expect(result.bundle.text).not.toContain('Today by the numbers');
    } finally { spy.mockRestore(); }
  });
  it('redacts the returned structured counts when no snapshot persistence was requested', async () => {
    const built = await buildContext(scopeFor('guest'), { intent: 'daily_brief', slices: ['proactive'] });
    if (!built.ok) throw new Error(built.error);
    const data = built.data.slices.proactive as ProactiveCountsView;
    expect(data.counts).not.toHaveProperty('homeworkDueSoon');
    expect(data.counts).not.toHaveProperty('sportsThisWeek');
    expect(data.counts?.plannedMeals).toBe(5);
    expect(db.table('ai_request_context')).toEqual([]);
  });

});
