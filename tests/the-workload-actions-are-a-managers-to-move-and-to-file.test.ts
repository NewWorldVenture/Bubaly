// Call-level role tests for app/(app)/dashboard/workload/actions.ts.
//
// The intended policy, from the sources rather than from the action:
//   - moveAssignmentAction moves an open chore (and the points it earns) to
//     another member. lib/constants/roles.ts: "Managers can ... approve chores";
//     the action's own comment and 0374's header ("rebalancing" runs as a
//     manager) say a parent or adult only. 0374's UPDATE policy lets anyone else
//     touch only their own assignment, so a teen moving a sibling's chore is the
//     very thing it was written to stop.
//   - saveWorkloadSnapshotAction files this ISO week's loads. The action's own
//     docstring: "only a parent or adult's view writes it: the history is the
//     household's record". Everyone else is answered ok and writes nothing (the
//     page calls it on every view, so a refusal would toast every child).
//   - Neither page is plan-gated or in manager-only navigation, and the guest
//     scope does not name it; the gates are role and family.
//
// The REAL actions run against the in-memory PostgREST fake; only the session
// (requireUserContext), the client factory and the translator's request seam are
// stubbed. A kid login is a `child` member row, so the `child` case covers it.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(MESSAGES, key, params),
}));

import { moveAssignmentAction, saveWorkloadSnapshotAction } from '@/app/(app)/dashboard/workload/actions';

// Typed out, so a missing catalogue entry fails rather than matching its key.
const NO_LONGER_OPEN = 'That chore is no longer open — refresh and try again.';
const MEMBER_NOT_FOUND = 'That family member was not found.';

const FAM_A = '00000000-0000-4000-8000-0000000000a0';
const FAM_B = '00000000-0000-4000-8000-0000000000b0';
const A = {
  parent: '00000000-0000-4000-8000-0000000000a1',
  adult: '00000000-0000-4000-8000-0000000000a2',
  teen: '00000000-0000-4000-8000-0000000000a3',
  child: '00000000-0000-4000-8000-0000000000a4',
  caregiver: '00000000-0000-4000-8000-0000000000a5',
  guest: '00000000-0000-4000-8000-0000000000a6',
} as const;
type Role = keyof typeof A;
const ROLES = Object.keys(A) as Role[];
const B_PARENT = '00000000-0000-4000-8000-0000000000b1';
const B_TEEN = '00000000-0000-4000-8000-0000000000b2';

const CHORE_A = '00000000-0000-4000-8000-0000000000c1';
const CHORE_B = '00000000-0000-4000-8000-0000000000c2';
const OPEN_A = '00000000-0000-4000-8000-0000000000d1';      // the teen's open chore
const APPROVED_A = '00000000-0000-4000-8000-0000000000d2';  // the child's settled chore
const LAST_WEEK_A = '00000000-0000-4000-8000-0000000000d3'; // before this ISO week
const OPEN_B = '00000000-0000-4000-8000-0000000000d4';      // another family's open chore
const MISFILED_B = '00000000-0000-4000-8000-0000000000d5';  // family B's row naming an A member
const TODO_A = '00000000-0000-4000-8000-0000000000e1';
const SNAP_B = '00000000-0000-4000-8000-0000000000f1';

// Wednesday 11 Nov 2026 — the ISO week starts Monday 9 Nov on a UTC clock.
const NOW = new Date('2026-11-11T12:00:00Z');
const WEEK = '2026-11-09';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const ctx = (role: Role) => ({
  user: { id: `00000000-0000-4000-8000-00000000010${ROLES.indexOf(role)}` },
  active: { familyId: FAM_A, role, family: { name: 'Family A', timezone: 'UTC' }, member: { id: A[role] } },
});
const row = (table: string, id: string) => structuredClone(db.table(table).find((r) => r.id === id));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('family_members', [
    ...ROLES.map((role) => ({ id: A[role], family_id: FAM_A, role, display_name: `A ${role}`, user_id: null, is_active: true })),
    { id: B_PARENT, family_id: FAM_B, role: 'parent', display_name: 'B parent', user_id: null, is_active: true },
    { id: B_TEEN, family_id: FAM_B, role: 'teen', display_name: 'B teen', user_id: null, is_active: true },
  ]);
  db.seed('chores', [
    { id: CHORE_A, family_id: FAM_A, title: 'Dishes', est_minutes: 30, points: 10 },
    { id: CHORE_B, family_id: FAM_B, title: 'Lawn', est_minutes: 60, points: 20 },
  ]);
  db.seed('chore_assignments', [
    { id: OPEN_A, family_id: FAM_A, chore_id: CHORE_A, member_id: A.teen, status: 'todo', created_at: '2026-11-10T09:00:00.000Z' },
    { id: APPROVED_A, family_id: FAM_A, chore_id: CHORE_A, member_id: A.child, status: 'approved', created_at: '2026-11-10T10:00:00.000Z' },
    { id: LAST_WEEK_A, family_id: FAM_A, chore_id: CHORE_A, member_id: A.adult, status: 'todo', created_at: '2026-11-08T23:00:00.000Z' },
    { id: OPEN_B, family_id: FAM_B, chore_id: CHORE_B, member_id: B_TEEN, status: 'todo', created_at: '2026-11-10T09:00:00.000Z' },
    { id: MISFILED_B, family_id: FAM_B, chore_id: CHORE_B, member_id: A.guest, status: 'todo', created_at: '2026-11-10T09:00:00.000Z' },
  ]);
  db.seed('todo_items', [
    { id: TODO_A, family_id: FAM_A, assigned_to_id: A.parent, is_done: false, created_at: '2026-11-10T08:00:00.000Z' },
  ]);
  db.seed('calendar_events', []);
  db.seed('workload_snapshots', [
    { id: SNAP_B, family_id: FAM_B, member_id: B_TEEN, week_start: WEEK, share_pct: 100, load_score: 100 },
  ]);
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('moveAssignmentAction — a manager rebalances; nobody else moves a chore', () => {
  it.each(['parent', 'adult'] as const)('ACTION-9D92F62AA5BE a %s moves an open chore to another member of the family and it is audited', async (role) => {
    mocks.requireUserContext.mockResolvedValue(ctx(role));
    expect(await moveAssignmentAction(OPEN_A, A.child)).toEqual({ ok: true });
    expect(row('chore_assignments', OPEN_A)).toMatchObject({ member_id: A.child, status: 'todo', family_id: FAM_A });
    expect(db.table('audit_logs')).toHaveLength(1);
    expect(db.table('audit_logs')[0]).toMatchObject({ family_id: FAM_A, resource_id: OPEN_A, action: 'update' });
    expect(row('chore_assignments', OPEN_B)).toMatchObject({ member_id: B_TEEN });
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('ACTION-9D92F62AA5BE a %s is refused and no assignment moves', async (role) => {
    mocks.requireUserContext.mockResolvedValue(ctx(role));
    const before = structuredClone(db.table('chore_assignments'));
    expect(await moveAssignmentAction(OPEN_A, A[role])).toEqual({ ok: false, error: NO_LONGER_OPEN });
    expect(db.table('chore_assignments')).toEqual(before);
    expect(db.table('audit_logs')).toHaveLength(0);
  });

  it('ACTION-9D92F62AA5BE a signed-out caller is sent away before anything is read or written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT'));
    const before = structuredClone(db.table('chore_assignments'));
    await expect(moveAssignmentAction(OPEN_A, A.child)).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('chore_assignments')).toEqual(before);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('ACTION-9D92F62AA5BE a settled (approved) chore is not moved, even by a parent', async () => {
    mocks.requireUserContext.mockResolvedValue(ctx('parent'));
    expect(await moveAssignmentAction(APPROVED_A, A.teen)).toEqual({ ok: false, error: NO_LONGER_OPEN });
    expect(row('chore_assignments', APPROVED_A)).toMatchObject({ member_id: A.child, status: 'approved' });
    expect(db.table('audit_logs')).toHaveLength(0);
  });

  it("ACTION-9D92F62AA5BE another family's assignment id is answered as not open and neither family changes", async () => {
    mocks.requireUserContext.mockResolvedValue(ctx('parent'));
    const before = structuredClone(db.table('chore_assignments'));
    expect(await moveAssignmentAction(OPEN_B, A.child)).toEqual({ ok: false, error: NO_LONGER_OPEN });
    expect(db.table('chore_assignments')).toEqual(before);
    expect(db.table('audit_logs')).toHaveLength(0);
  });

  it("ACTION-9D92F62AA5BE another family's member is not a target: the chore stays where it was", async () => {
    mocks.requireUserContext.mockResolvedValue(ctx('parent'));
    const before = structuredClone(db.table('chore_assignments'));
    expect(await moveAssignmentAction(OPEN_A, B_PARENT)).toEqual({ ok: false, error: MEMBER_NOT_FOUND });
    expect(db.table('chore_assignments')).toEqual(before);
    expect(db.table('audit_logs')).toHaveLength(0);
  });
});

describe("saveWorkloadSnapshotAction — a manager's view files this week's loads; nobody else's does", () => {
  /** What A's week holds: the parent's open to-do (10) and the teen's two in-week chores (30 + 30). */
  const EXPECTED_A = [
    { member_id: A.teen, chore_minutes: 30, chore_count: 1, task_count: 0, share_pct: 42.9 },
    { member_id: A.child, chore_minutes: 30, chore_count: 1, task_count: 0, share_pct: 42.9 },
    { member_id: A.parent, chore_minutes: 0, chore_count: 0, task_count: 1, share_pct: 14.3 },
    { member_id: A.adult, chore_minutes: 0, chore_count: 0, task_count: 0, share_pct: 0 },
    { member_id: A.caregiver, chore_minutes: 0, chore_count: 0, task_count: 0, share_pct: 0 },
    { member_id: A.guest, chore_minutes: 0, chore_count: 0, task_count: 0, share_pct: 0 },
  ];
  const familyA = () => db.table('workload_snapshots')
    .filter((r) => r.family_id === FAM_A)
    .map((r) => ({ member_id: r.member_id, chore_minutes: r.chore_minutes, chore_count: r.chore_count, task_count: r.task_count, share_pct: r.share_pct, week_start: r.week_start }))
    .sort((x, y) => String(x.member_id).localeCompare(String(y.member_id)));
  const expected = () => EXPECTED_A.map((r) => ({ ...r, week_start: WEEK }))
    .sort((x, y) => x.member_id.localeCompare(y.member_id));

  it.each(['parent', 'adult'] as const)("ACTION-D91AB2BF25EC a %s's view files one row per active member of their own family, for this ISO week only", async (role) => {
    mocks.requireUserContext.mockResolvedValue(ctx(role));
    const bBefore = structuredClone(db.table('workload_snapshots').filter((r) => r.family_id === FAM_B));
    expect(await saveWorkloadSnapshotAction()).toEqual({ ok: true });
    expect(familyA()).toEqual(expected());
    expect(db.table('workload_snapshots').filter((r) => r.family_id === FAM_B)).toEqual(bBefore);
    expect(db.table('workload_snapshots').some((r) => r.member_id === B_PARENT)).toBe(false);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)("ACTION-D91AB2BF25EC a %s's view is answered ok and writes no history", async (role) => {
    mocks.requireUserContext.mockResolvedValue(ctx(role));
    const before = structuredClone(db.table('workload_snapshots'));
    expect(await saveWorkloadSnapshotAction()).toEqual({ ok: true });
    expect(db.table('workload_snapshots')).toEqual(before);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('ACTION-D91AB2BF25EC a signed-out caller is sent away and nothing is filed', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT'));
    const before = structuredClone(db.table('workload_snapshots'));
    await expect(saveWorkloadSnapshotAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('workload_snapshots')).toEqual(before);
  });

  it("ACTION-D91AB2BF25EC a parent's re-view upserts the same rows rather than adding a second week", async () => {
    mocks.requireUserContext.mockResolvedValue(ctx('parent'));
    expect(await saveWorkloadSnapshotAction()).toEqual({ ok: true });
    expect(await saveWorkloadSnapshotAction()).toEqual({ ok: true });
    expect(familyA()).toEqual(expected());
  });
});
