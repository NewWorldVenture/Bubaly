// The chores board writes through the service.
//
// The sharpest case here is not a duplicate: it is that the board's own status
// setter always wrote `submitted`, while `completeChoreAssignment` reads the
// chore's `requires_approval` and settles on `done` when no parent is needed. A
// family who turned approval OFF for "make your bed" still had every bed-making
// sit in a queue waiting for a decision nobody owed them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { makeKey } from '@/lib/services/idempotency';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  createChoreAction, deleteChoreAssignmentAction, setChoreStatusAction,
} from '@/app/(app)/dashboard/chores/actions';

const FAMILY = 'family-1';
const OTHER = 'family-2';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const assignments = (familyId = FAMILY) => db.table('chore_assignments').filter((r) => r.family_id === familyId);
const chores = (familyId = FAMILY) => db.table('chores').filter((r) => r.family_id === familyId);

/** Seed a chore and its assignment; `requiresApproval` is the point of most cases. */
function seedChore(opts: { requiresApproval: boolean; familyId?: string; id?: string }) {
  const familyId = opts.familyId ?? FAMILY;
  const choreId = `${opts.id ?? 'chore'}-c`;
  db.seed('chores', [{ id: choreId, family_id: familyId, title: 'Make your bed', points: 5, requires_approval: opts.requiresApproval }]);
  db.seed('chore_assignments', [{ id: opts.id ?? 'assign-1', family_id: familyId, chore_id: choreId, member_id: 'member-1', status: 'in_progress' }]);
  return opts.id ?? 'assign-1';
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      chores: { description: null, points: 10, priority: 'medium', recurrence: 'none', due_at: null, requires_approval: true, icon: null, is_active: true },
      chore_assignments: { status: 'todo', due_at: null, submitted_at: null, approved_at: null, approved_by: null, points_awarded: null, ai_score: null, cash_awarded_cents: null, idempotency_key: null, disputed: false },
    },
    // 0256's PARTIAL unique index. The helper skips a unique set when any of its
    // columns is null, which is what "partial" means here: unkeyed rows are free
    // to repeat, keyed ones are not.
    uniques: { chore_assignments: [['family_id', 'idempotency_key']] },
  });
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('submitting a chore honours whether it needs a parent', () => {
  it('settles on done when the chore needs no approval', async () => {
    const id = seedChore({ requiresApproval: false });
    const result = await setChoreStatusAction(id, 'submitted');

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(result.ok && result.status).toBe('done');
    expect(assignments()[0]!.status).toBe('done');
  });

  it('settles on submitted when it does', async () => {
    const id = seedChore({ requiresApproval: true });
    const result = await setChoreStatusAction(id, 'submitted');
    expect(result.ok && result.status).toBe('submitted');
    expect(assignments()[0]!.status).toBe('submitted');
  });

  it('reports the settled status, so the toast cannot claim the wrong one', async () => {
    // The board said "Submitted for approval!" from its own argument. On a chore
    // needing no approval that sentence was simply untrue.
    const id = seedChore({ requiresApproval: false });
    const result = await setChoreStatusAction(id, 'submitted');
    expect(result.ok && result.status).not.toBe('submitted');
  });
});

describe('the statuses a member drives', () => {
  it('picks a chore up', async () => {
    const id = seedChore({ requiresApproval: true });
    db.table('chore_assignments')[0]!.status = 'todo';
    const result = await setChoreStatusAction(id, 'in_progress');
    expect(result.ok && result.status).toBe('in_progress');
  });

  it('puts it back, clearing the trail of it having been finished', async () => {
    const id = seedChore({ requiresApproval: true });
    Object.assign(db.table('chore_assignments')[0]!, {
      status: 'submitted', submitted_at: '2026-09-01T00:00:00.000Z', approved_at: '2026-09-02T00:00:00.000Z',
    });

    await setChoreStatusAction(id, 'todo');
    const row = assignments()[0]!;
    expect(row.status).toBe('todo');
    // Otherwise the board shows it as awaiting a decision that is no longer due.
    expect(row.submitted_at).toBeNull();
    expect(row.approved_at).toBeNull();
  });
});

describe('another household’s chore', () => {
  it('cannot be moved', async () => {
    const id = seedChore({ requiresApproval: true, familyId: OTHER, id: 'theirs' });
    const result = await setChoreStatusAction(id, 'in_progress');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/could not be found/i);
    expect(assignments(OTHER)[0]!.status).toBe('in_progress');
  });

  it('cannot be deleted — the client filtered id alone and left tenancy to RLS', async () => {
    seedChore({ requiresApproval: true, familyId: OTHER, id: 'theirs' });
    const result = await deleteChoreAssignmentAction('theirs');
    expect(result.ok).toBe(false);
    expect(assignments(OTHER)).toHaveLength(1);
  });
});

describe('adding a chore', () => {
  it('creates the chore and its assignment together, keeping the icon', async () => {
    const result = await createChoreAction({
      title: 'Feed the dog', description: 'Morning and evening', points: 15,
      priority: 'high', recurrence: 'daily', icon: '🐕',
      dueAt: '2026-09-10T09:00:00.000Z', assigneeId: 'member-2',
    });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(chores()).toHaveLength(1);
    expect(assignments()).toHaveLength(1);
    // `CreateChoreInput` carried no icon before this tranche, so routing the
    // board through it would have dropped the emoji the family picked.
    expect(chores()[0]!.icon).toBe('🐕');
    expect(chores()[0]!.points).toBe(15);
    expect(assignments()[0]!.member_id).toBe('member-2');
  });

  it('takes family_id and created_by from the session', async () => {
    await createChoreAction({ title: 'Feed the dog', assigneeId: 'member-2' });
    expect(chores()[0]!.family_id).toBe(FAMILY);
    // chores.created_by references auth.users (0002), unlike the todo tables.
    expect(chores()[0]!.created_by).toBe('user-1');
  });

  it('drops a priority or recurrence the column would reject', async () => {
    await createChoreAction({ title: 'Feed the dog', priority: 'catastrophic', recurrence: 'fortnightly', assigneeId: 'member-2' });
    expect(chores()[0]!.priority).toBe('medium');
    expect(chores()[0]!.recurrence).toBe('none');
  });

  it('refuses an empty title and writes nothing', async () => {
    const result = await createChoreAction({ title: '   ', assigneeId: 'member-2' });
    expect(result.ok).toBe(false);
    expect(chores()).toHaveLength(0);
    expect(assignments()).toHaveLength(0);
  });
});

describe('a caller who is not signed in', () => {
  it.each([
    ['status', () => setChoreStatusAction('assign-1', 'in_progress')],
    ['delete', () => deleteChoreAssignmentAction('assign-1')],
    ['create', () => createChoreAction({ title: 'Feed the dog' })],
  ])('is redirected on %s, not handed an error toast', async (_name, call) => {
    mocks.requireUserContext.mockRejectedValueOnce(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' }),
    );
    await expect(call()).rejects.toThrow('NEXT_REDIRECT');
  });
});

// ── The double-tapped Add ───────────────────────────────────────────────────
// `chores` is not one of 0256's keyed tables and `chore_assignments` is, which
// is why this had to key the two-row create as a UNIT. Keying the assignment
// alone would write a second CHORE, then hand back the first ASSIGNMENT, and
// leave a chore nobody is assigned to.
describe('adding the same chore twice', () => {
  const SUBMISSION = '11111111-2222-4333-8444-555555555555';
  const add = () => createChoreAction({
    title: 'Feed the dog', points: 15, assigneeId: 'member-2',
    dueAt: '2026-09-10T09:00:00.000Z', submissionId: SUBMISSION,
  });

  it('adds one chore, and gives the second tap the first one back', async () => {
    const first = await add();
    const second = await add();

    expect(first.ok, first.ok ? '' : first.error).toBe(true);
    expect(second.ok, second.ok ? '' : second.error).toBe(true);
    expect(chores()).toHaveLength(1);
    expect(assignments()).toHaveLength(1);
    // The same rows, not a silent no-op: the surface needs an id to navigate to.
    expect(first.ok && second.ok && first.id === second.id).toBe(true);
  });

  it('leaves no orphan chore when the assignment loses the race', async () => {
    // The race the unit-keying exists for: both attempts probe empty and both
    // insert a chore, then 0256's index refuses the second assignment. Staged by
    // writing the winner's assignment AFTER the loser has already probed.
    const key = makeKey(['tasks.createChore', FAMILY, SUBMISSION]);
    const real = db.from.bind(db);
    let staged = false;
    const from = vi.spyOn(db, 'from').mockImplementation((table: string) => {
      // The first `chores` access is our own insert, so the winner commits
      // between our probe (which saw nothing) and our assignment insert.
      if (table === 'chores' && !staged) {
        staged = true;
        db.seed('chores', [{ id: 'winner-c', family_id: FAMILY, title: 'Feed the dog', points: 15 }]);
        db.seed('chore_assignments', [{ id: 'winner-a', family_id: FAMILY, chore_id: 'winner-c', member_id: 'member-2', idempotency_key: key }]);
      }
      return real(table);
    });

    const result = await add();
    from.mockRestore();

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    // One chore — the winner's. The loser's was rolled back when its assignment
    // was refused, which is the whole point of wrapping the pair.
    expect(chores()).toHaveLength(1);
    expect(chores()[0]!.id).toBe('winner-c');
    expect(assignments()).toHaveLength(1);
  });

  it('still adds two when the family means two', async () => {
    // A different composition is a different id, so "add it again on purpose"
    // is not mistaken for a retry.
    await add();
    await createChoreAction({
      title: 'Feed the dog', points: 15, assigneeId: 'member-2',
      dueAt: '2026-09-10T09:00:00.000Z', submissionId: '99999999-8888-4777-8666-555555555555',
    });
    expect(chores()).toHaveLength(2);
    expect(assignments()).toHaveLength(2);
  });

  it('does not deduplicate without a submission id', async () => {
    await createChoreAction({ title: 'Feed the dog', assigneeId: 'member-2' });
    await createChoreAction({ title: 'Feed the dog', assigneeId: 'member-2' });
    expect(chores()).toHaveLength(2);
  });
});
