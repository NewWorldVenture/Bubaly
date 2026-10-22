import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// Deleting a chore from the board, through the REAL action, against an
// in-memory database that keeps 0256's partial unique index on the respawn key.
//
//   S1  The delete removed only the assignment row. The push-scan sweep
//       (`respawnMissingChoreAssignments`) then found the child with a finished
//       assignment of the recurring chore and nothing open, and recreated the
//       successor under `respawnKeyFor(finished)` — a key the deleted row had
//       held and the delete freed. The board said "Chore removed"; the next
//       cron run put it back. The board's only way to stop a chore for a child
//       did not stop it. Fixed for a chore that is only this child's; one
//       other children share (what /missions/new writes when several kids are
//       ticked) still comes back until the schema has a tombstone the sweep
//       reads, and the board says so — see
//       a-shared-chore-removed-from-one-child-says-it-will-come-back.test.ts.
//   S7  The child's proof photos went with the row in the database (00430:
//       chore_submissions cascade on the assignment) and with nothing in
//       Storage: the objects stayed in the private bucket, referenced by
//       nothing and never removed.

const FAMILY = 'family-1';
const PARENT = 'member-parent';
const KID = 'member-kid';
const SIB = 'member-sib';
const NOW = '2026-10-13T12:00:00.000Z';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  objects: new Set<string>(),
  removed: [] as string[],
  /** RLS refusing the delete (0374: a manager's), with an error. */
  refuseDelete: false,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-parent', email: null },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-parent', family_id: 'family-1' }, family: { id: 'family-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { deleteChoreAssignmentAction } = await import('@/app/(app)/dashboard/chores/actions');
const { respawnMissingChoreAssignments, respawnKeyFor } = await import('@/lib/services/tasks');

type DB = SupabaseClient<Database>;
let db: InMemorySupabase;

/** What PostgREST answers a delete RLS refuses with an error. */
const REFUSED = { data: null, count: null, error: { code: '42501', message: 'permission denied for table chore_assignments', details: null, hint: null } };

/**
 * The database as the action's client sees it: chore_submissions go when their
 * assignment goes (00430's ON DELETE CASCADE), and Storage keeps objects until
 * a remove names them. A claim is an upload that does not overwrite.
 */
function withCascadeAndStorage(base: InMemorySupabase): unknown {
  const bucket = {
    upload: async (path: string) => {
      if (harness.objects.has(path)) return { data: null, error: { statusCode: '409', message: 'The resource already exists' } };
      harness.objects.add(path);
      return { data: { path }, error: null };
    },
    remove: async (paths: string[]) => {
      for (const path of paths) { if (!path.includes('/claims/')) harness.removed.push(path); harness.objects.delete(path); }
      return { data: paths.map((name) => ({ name })), error: null };
    },
  };
  const cascade = <T,>(reply: T): T => {
    const live = new Set(base.table('chore_assignments').map((row) => row.id));
    base.replace('chore_submissions', base.table('chore_submissions').filter((row) => live.has(row.assignment_id as string)));
    return reply;
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'storage') return { from: () => bucket };
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = target.from(table);
        if (table !== 'chore_assignments') return builder;
        let deleting = false;
        const refused = () => deleting && harness.refuseDelete;
        const proxy: object = new Proxy(builder, {
          get(object, key) {
            const value = Reflect.get(object, key);
            if (key === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                (refused() ? Promise.resolve(REFUSED) : object.then(cascade)).then(resolve, reject);
            }
            if (typeof value !== 'function') return value;
            if (key === 'single' || key === 'maybeSingle') {
              return (...args: unknown[]) => (refused() ? Promise.resolve(REFUSED) : (Reflect.apply(value, object, args) as Promise<unknown>).then(cascade));
            }
            return (...args: unknown[]) => {
              if (key === 'delete') deleting = true;
              const result = Reflect.apply(value, object, args);
              return result === object ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  });
}

const sweepScope = (): ServiceScope => ({
  db: db as unknown as DB, familyId: FAMILY, userId: 'system', memberId: null, role: 'system', actorKind: 'system', tz: 'UTC', now: new Date(NOW),
} as ServiceScope);
const openOf = (member: string, chore = 'chore-bed') => db.table('chore_assignments')
  .filter((row) => row.member_id === member && row.chore_id === chore && ['todo', 'in_progress'].includes(row.status as string));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = createInMemorySupabase<DB>({
    defaults: {
      chores: { description: null, points: 10, priority: 'medium', recurrence: 'none', due_at: null, requires_approval: true, icon: null, is_active: true },
      chore_assignments: { status: 'todo', due_at: null, submitted_at: null, approved_at: null, approved_by: null, points_awarded: null, ai_score: null, cash_awarded_cents: null, idempotency_key: null, disputed: false },
    },
    // 0256's PARTIAL unique index: unkeyed rows repeat freely, keyed ones do not.
    uniques: { chore_assignments: [['family_id', 'idempotency_key']] },
  });
  harness.db = withCascadeAndStorage(db);
  harness.objects = new Set();
  harness.removed = [];
  harness.refuseDelete = false;
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, role: 'parent', is_active: true },
    { id: KID, family_id: FAMILY, role: 'child', is_active: true },
    { id: SIB, family_id: FAMILY, role: 'child', is_active: true },
  ]);
  db.seed('chores', [{ id: 'chore-bed', family_id: FAMILY, title: 'Make the bed', recurrence: 'daily', is_active: true }]);
  // Yesterday's, approved; today's, created by the approval under its key.
  db.seed('chore_assignments', [
    { id: 'asg-done', family_id: FAMILY, chore_id: 'chore-bed', member_id: KID, status: 'approved', due_at: '2026-10-12T18:00:00.000Z', approved_at: '2026-10-12T19:00:00.000Z', points_awarded: 10 },
    { id: 'asg-next', family_id: FAMILY, chore_id: 'chore-bed', member_id: KID, status: 'todo', due_at: '2026-10-13T18:00:00.000Z', idempotency_key: respawnKeyFor(FAMILY, 'asg-done') },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('S1 — a recurring chore removed from a child\'s board is not put back by the respawn sweep', () => {
  it('stays off the board after the push-scan sweep runs', async () => {
    const removed = await deleteChoreAssignmentAction('asg-next');
    expect(removed.ok, removed.ok ? '' : removed.error).toBe(true);
    expect(openOf(KID)).toEqual([]);

    const swept = await respawnMissingChoreAssignments(sweepScope());

    expect(swept.ok).toBe(true);
    expect(swept.ok && swept.data.respawned).toBe(0);
    expect(openOf(KID)).toEqual([]);
    // The child's finished history — and its points — are untouched.
    expect(db.table('chore_assignments').find((row) => row.id === 'asg-done')).toMatchObject({ status: 'approved', points_awarded: 10 });
  });

  it('a chore a sibling still has keeps repeating for the sibling', async () => {
    db.seed('chore_assignments', [
      { id: 'asg-sib-done', family_id: FAMILY, chore_id: 'chore-bed', member_id: SIB, status: 'approved', due_at: '2026-10-12T18:00:00.000Z', approved_at: '2026-10-12T19:30:00.000Z', points_awarded: 10 },
    ]);

    expect((await deleteChoreAssignmentAction('asg-next')).ok).toBe(true);
    await respawnMissingChoreAssignments(sweepScope());

    expect(db.table('chores')[0]).toMatchObject({ is_active: true });
    expect(openOf(SIB)).toHaveLength(1);
  });

  it('a refused delete leaves the chore active, as it was', async () => {
    harness.refuseDelete = true;

    const removed = await deleteChoreAssignmentAction('asg-next');

    expect(removed.ok).toBe(false);
    expect(db.table('chores')[0]).toMatchObject({ is_active: true });
    expect(openOf(KID)).toHaveLength(1);
  });
});

describe('S7 — a deleted assignment\'s proof leaves the private bucket with it', () => {
  const photo = `${FAMILY}/${KID}/6f9619ff-8b86-4011-b42d-00c04fc964ff-bed.jpg`;
  const video = `${FAMILY}/${KID}/7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d-bed.mp4`;
  const shared = `${FAMILY}/${KID}/11111111-2222-4333-8444-555555555555-shared.jpg`;

  beforeEach(() => {
    for (const path of [photo, video, shared]) harness.objects.add(path);
    db.seed('chore_submissions', [
      { id: 'sub-1', family_id: FAMILY, assignment_id: 'asg-next', chore_id: 'chore-bed', member_id: KID, kind: 'photo', media_paths: [photo, shared], status: 'parent_review' },
      { id: 'sub-2', family_id: FAMILY, assignment_id: 'asg-next', chore_id: 'chore-bed', member_id: KID, kind: 'video', media_paths: [video], status: 'rejected' },
      // Another submission still holds one of the paths (a replayed path): it stays.
      { id: 'sub-other', family_id: FAMILY, assignment_id: 'asg-done', chore_id: 'chore-bed', member_id: KID, kind: 'photo', media_paths: [shared], status: 'approved' },
    ]);
  });

  it('removes the proof nothing else references, and keeps what another submission still holds', async () => {
    const removed = await deleteChoreAssignmentAction('asg-next');

    expect(removed.ok, removed.ok ? '' : removed.error).toBe(true);
    expect(db.table('chore_submissions').map((row) => row.id)).toEqual(['sub-other']);
    expect(harness.removed.sort()).toEqual([photo, video].sort());
    expect(harness.objects.has(photo)).toBe(false);
    expect(harness.objects.has(video)).toBe(false);
    expect(harness.objects.has(shared)).toBe(true);
  });
});
