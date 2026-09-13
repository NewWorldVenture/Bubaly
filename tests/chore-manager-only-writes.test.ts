import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Adding a chore and removing one are the chores board's two manager-only
 * writes — and they were manager-only on the SCREEN.
 *
 * Traced on 2026-09-13. `chores-module.tsx` renders the Add button and the
 * Delete menu item behind `manager &&`, and nothing behind that agreed: the
 * actions took any signed-in member, `createChore` and `deleteChoreAssignment`
 * scope by family and not by role, and the RLS on `chore_assignments` is
 * `is_family_member` for all four operations (migration 0004). So a child could
 * delete any chore on the family's board — including one assigned to them — and
 * mint chores assigned to a sibling.
 *
 * That is the gap left either side of 0222/0223, which closed FORGING a chore's
 * completion as an "accountability/integrity forgery". Deleting the assignment
 * reaches the same end from the other direction: the chore is simply gone, and
 * so is the record that it was ever owed.
 *
 * The board's other two manager-only writes were already defended, which is why
 * these two stood out rather than blending in: approve is guarded by the 0223
 * trigger (`can_manage_family`), and paying a reward by `isManager` in
 * `payChoreRewardAction` plus the manager-only wallet RLS of 0217.
 */

const FAMILY = 'family-1';
const state = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'someone@example.com' },
    memberships: [],
    active: {
      familyId: FAMILY,
      role: state.role,
      member: { id: 'member-1', family_id: FAMILY, user_id: 'user-1' },
      family: { id: FAMILY, name: 'Test household', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});

const { createChoreAction, deleteChoreAssignmentAction } = await import('@/app/(app)/dashboard/chores/actions');

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>({
    defaults: { chore_assignments: { status: 'todo' }, chores: { points: 10, requires_approval: true } },
  });
  db.seed('families', [{ id: FAMILY, name: 'Test household', timezone: 'UTC' }]);
  db.seed('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Empty the dishwasher' }]);
  db.seed('chore_assignments', [
    { id: 'assign-1', family_id: FAMILY, chore_id: 'chore-1', member_id: 'member-child', status: 'todo' },
  ]);
  state.db = db;
  state.role = 'parent';
});

const assignments = () => db.table('chore_assignments');
const chores = () => db.table('chores');

describe('removing a chore is refused to a member who is not a manager', () => {
  it.each(['child', 'teen', 'guest', 'caregiver'])('refuses a %s, and the chore stays on the board', async (role) => {
    state.role = role;

    const result = await deleteChoreAssignmentAction('assign-1');

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/parent\/guardian/i);
    expect(assignments()).toHaveLength(1);
  });

  it.each(['parent', 'adult'])('lets a %s remove it', async (role) => {
    state.role = role;

    const result = await deleteChoreAssignmentAction('assign-1');

    expect(result).toMatchObject({ ok: true });
    expect(assignments()).toHaveLength(0);
  });
});

describe('adding a chore is refused to a member who is not a manager', () => {
  it('refuses a child, and no chore is minted', async () => {
    state.role = 'child';

    const result = await createChoreAction({ title: 'Sibling does the bins', assigneeId: 'member-sibling' });

    expect(result).toMatchObject({ ok: false });
    expect(chores()).toHaveLength(1); // only the seeded one
  });

  it('lets a parent add one', async () => {
    state.role = 'parent';

    const result = await createChoreAction({ title: 'Take the bins out', assigneeId: 'member-child' });

    expect(result).toMatchObject({ ok: true });
    expect(chores()).toHaveLength(2);
  });
});

describe('the screen and the action agree about who may do these', () => {
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (rel: string) => stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));

  it('still renders both controls behind `manager` in the board', () => {
    // The pairing IS the finding: the screen said manager-only and was the only
    // thing saying it. If either of these ever stops being manager-gated in the
    // UI, the server check above becomes the sole rule and this should be
    // revisited deliberately rather than discovered.
    const board = read('components/modules/chores-module.tsx');
    expect(board).toMatch(/manager && <MenuItem danger onClick=\{\(\) => onDelete\(a\)\}/);
    expect(board).toMatch(/manager \?[\s\S]{0,200}setAddOpen\(true\)/);
  });

  it('checks the role in the action, where the money write already checks it', () => {
    const actions = read('app/(app)/dashboard/chores/actions.ts');
    expect(actions).toContain('refuseUnlessManager');
    expect((actions.match(/refuseUnlessManager\(ctx\.active\.role\)/g) ?? [])).toHaveLength(2);
  });
});
