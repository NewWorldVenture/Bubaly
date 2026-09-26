import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Chore proof is submitted by the child the chore is assigned to, or by a
 * manager on their behalf. submitProofAction loaded the assignment by id and
 * never compared its member to the caller, so a sibling could submit proof on
 * someone else's chore - triggering AI verification and possibly an
 * auto-approval with its reward, or a rejection with junk proof.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'member-sib', role: 'child' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'family-1', role: harness.role, member: { id: harness.memberId, family_id: 'family-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { submitProofAction, disputeSubmissionAction } = await import('@/app/(app)/missions/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

describe('submitting chore proof', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
    db.seed('chore_assignments', [{ id: 'assign-1', family_id: 'family-1', chore_id: 'chore-1', member_id: 'member-kid', status: 'pending' }]);
    db.seed('chores', [{ id: 'chore-1', family_id: 'family-1', title: 'Dishes', proof_required: 'none' }]);
  });

  it('refuses a sibling submitting on someone else\'s assignment, writing nothing', async () => {
    harness.memberId = 'member-sib';
    harness.role = 'child';
    const form = new FormData();
    form.set('assignment_id', 'assign-1');
    form.set('note', 'done!');

    const res = await submitProofAction(form);

    expect(res).toEqual({ ok: false, error: translate(SOURCE_MESSAGES, 'actions.choreNotFound') });
    expect(db.table('chore_submissions')).toEqual([]);
    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'pending' });
  });
});

describe('disputing a chore verdict', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
    db.seed('chore_assignments', [{ id: 'assign-1', family_id: 'family-1', chore_id: 'chore-1', member_id: 'member-kid', status: 'approved' }]);
    db.seed('chore_submissions', [
      { id: 'sub-rejected', family_id: 'family-1', assignment_id: 'assign-1', member_id: 'member-kid', status: 'rejected' },
      { id: 'sub-approved', family_id: 'family-1', assignment_id: 'assign-1', member_id: 'member-kid', status: 'approved' },
    ]);
  });

  const dispute = (id: string) => {
    const form = new FormData();
    form.set('submission_id', id);
    form.set('reason', 'unfair');
    return disputeSubmissionAction(form);
  };

  it('refuses a sibling disputing someone else\'s verdict', async () => {
    harness.memberId = 'member-sib';
    harness.role = 'child';
    await dispute('sub-rejected');
    expect(db.table('chore_disputes')).toEqual([]);
    expect(db.table('chore_submissions').find((r) => r.id === 'sub-rejected')).toMatchObject({ status: 'rejected' });
  });

  it('refuses reopening an approved (already paid) submission', async () => {
    harness.memberId = 'member-kid';
    harness.role = 'child';
    await dispute('sub-approved');
    expect(db.table('chore_disputes')).toEqual([]);
    expect(db.table('chore_submissions').find((r) => r.id === 'sub-approved')).toMatchObject({ status: 'approved' });
    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'approved' });
  });
});
