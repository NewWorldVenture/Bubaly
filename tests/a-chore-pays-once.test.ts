import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A chore pays its completion rewards once. (DATA-016)
 *
 * Measured live, the real action as a real parent session on the local stack:
 *
 *   one submission approved three times        XP 20 -> 40 -> 60
 *   four different chores approved together    XP +20, not +80
 *
 * The first because nothing made approval one-way: `finalizeApproval` wrote the
 * assignment approved and paid, every time. The second because
 * `applyCompletionRewards` read `kid_progress` and wrote back "that plus mine",
 * so concurrent approvals for one child overwrote each other.
 *
 * The double below honours every filter against the row as it is when the
 * write runs, and resolves each call on a later macrotask so concurrent calls
 * interleave the way PostgREST requests do. A double that ignored filters is
 * how the existing reward tests passed through both defects.
 */

type Row = Record<string, unknown> & { id: string };
type Filter = { column: string; op: 'eq' | 'is' | 'not-is'; value: unknown };

const db = vi.hoisted(() => ({ tables: new Map<string, Array<Record<string, unknown>>>() }));
const later = <T>(value: () => T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value()), 0));

function table(name: string) {
  const filters: Filter[] = [];
  let patch: Record<string, unknown> | null = null;
  let insert: Record<string, unknown> | null = null;
  const rows = () => db.tables.get(name) ?? [];
  const match = (row: Record<string, unknown>) => filters.every(({ column, op, value }) =>
    op === 'eq' ? row[column] === value : op === 'is' ? row[column] === value : row[column] !== value);
  const run = () => {
    if (insert) {
      const list = rows();
      if (name === 'kid_progress' && list.some((r) => r.member_id === insert!.member_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      const row = { id: `${name}-${list.length + 1}`, xp: 0, level: 1, current_streak: 0, longest_streak: 0, last_activity: null, ...insert };
      db.tables.set(name, [...list, row]);
      return { data: { ...row }, error: null };
    }
    const hits = rows().filter(match);
    if (patch) {
      for (const row of hits) Object.assign(row, patch);
      return { data: hits[0] ? { id: hits[0].id } : null, error: null };
    }
    return { data: hits[0] ? { ...hits[0] } : null, error: null, count: hits.length };
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    order: () => chain,
    eq: (column: string, value: unknown) => { filters.push({ column, op: 'eq', value }); return chain; },
    is: (column: string, value: unknown) => { filters.push({ column, op: 'is', value }); return chain; },
    not: (column: string, _op: string, value: unknown) => { filters.push({ column, op: 'not-is', value }); return chain; },
    update: (value: Record<string, unknown>) => { patch = value; return chain; },
    insert: (value: Record<string, unknown>) => { insert = value; return chain; },
    upsert: () => ({ select: () => later(() => ({ data: [], error: null })) }),
    maybeSingle: () => later(run),
    single: () => later(run),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => later(run).then(resolve, reject),
  };
  return chain;
}
const client = { from: (name: string) => table(name) };

const ctx = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx.value }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client, createServiceClient: () => client }));

import * as rewards from '@/lib/chores/server';
import { approveSubmissionAction } from '@/app/(app)/missions/actions';

const FAMILY = 'family-1';
const seed = () => {
  db.tables.clear();
  db.tables.set('kid_progress', [{ id: 'progress-1', family_id: FAMILY, member_id: 'kid-1', xp: 20, level: 1, current_streak: 1, longest_streak: 1, last_activity: null }]);
  db.tables.set('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Dishes', difficulty: 'medium' }]);
  db.tables.set('chore_assignments', [{ id: 'asg-1', family_id: FAMILY, chore_id: 'chore-1', member_id: 'kid-1', status: 'done', approved_at: null, approved_by: null, points_awarded: null, cash_awarded_cents: null }]);
  db.tables.set('chore_submissions', [{ id: 'sub-1', family_id: FAMILY, assignment_id: 'asg-1', chore_id: 'chore-1', member_id: 'kid-1', status: 'pending' }]);
  db.tables.set('chore_disputes', []);
  db.tables.set('member_badges', []);
};
const xp = () => (db.tables.get('kid_progress')![0].xp as number);
const approve = () => { const form = new FormData(); form.set('submission_id', 'sub-1'); return approveSubmissionAction(form); };

beforeEach(() => {
  seed();
  ctx.value = { user: { id: 'parent-user' }, active: { familyId: FAMILY, role: 'parent', member: { id: 'parent-1' } } };
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('an assignment is paid on its first approval only', () => {
  it('control: the first approval pays the chore', async () => {
    await approve();
    expect(xp()).toBe(40);
    expect(db.tables.get('chore_assignments')![0]).toMatchObject({ status: 'approved', approved_by: 'parent-1' });
  });

  it('pays nothing more when the same submission is approved again', async () => {
    await approve();
    await approve();
    await approve();
    expect(xp()).toBe(40);
    expect(db.tables.get('chore_assignments')![0].status).toBe('approved');
  });

  it('pays once when two approvals of it arrive together', async () => {
    await Promise.all([approve(), approve()]);
    expect(xp()).toBe(40);
  });

  it('puts a re-submitted, already-paid chore back to approved without paying it again', async () => {
    await approve();
    // A new proof for a finished chore moves the assignment back to `submitted`.
    Object.assign(db.tables.get('chore_assignments')![0], { status: 'submitted' });
    db.tables.get('chore_submissions')!.push({ id: 'sub-2', family_id: FAMILY, assignment_id: 'asg-1', chore_id: 'chore-1', member_id: 'kid-1', status: 'pending' });
    const form = new FormData(); form.set('submission_id', 'sub-2');
    await approveSubmissionAction(form);
    expect(xp()).toBe(40);
    expect(db.tables.get('chore_assignments')![0].status).toBe('approved');
  });
});

describe('an approval that saved nothing is not an approval', () => {
  it('rolls the submission back when the assignment is not this family\'s', async () => {
    // The assignment is read by id alone; both approval writes filter on the
    // family, so here neither can match and the submission must not stay approved.
    Object.assign(db.tables.get('chore_assignments')![0], { family_id: 'family-2', approved_at: '2026-09-01T00:00:00Z' });
    await approve();
    expect(xp()).toBe(20);
    expect(db.tables.get('chore_submissions')![0].status).toBe('pending');
    expect(db.tables.get('chore_assignments')![0].status).toBe('done');
  });
});

describe('one child\'s XP is not a last-writer-wins value', () => {
  it('adds every one of four concurrent awards', async () => {
    await Promise.all([1, 2, 3, 4].map(() => rewards.applyCompletionRewards(client as never, {
      familyId: FAMILY, memberId: 'kid-1', difficulty: 'medium', qualityScore: 90,
    })));
    expect(xp()).toBe(20 + 4 * 20);
  });

  it('creates the progress row once when two first awards race for it', async () => {
    db.tables.set('kid_progress', []);
    await Promise.all([1, 2].map(() => rewards.applyCompletionRewards(client as never, {
      familyId: FAMILY, memberId: 'kid-1', difficulty: 'easy', qualityScore: 90,
    })));
    expect(db.tables.get('kid_progress')).toHaveLength(1);
    expect(xp()).toBe(20);
  });
});
