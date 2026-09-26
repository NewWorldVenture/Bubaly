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
const { submitProofAction } = await import('@/app/(app)/missions/actions');
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
