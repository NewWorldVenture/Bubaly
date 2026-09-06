// An approved action is Bubaly's work, done for the person who asked.
//
// `decideApproval` builds its scope from whoever is DECIDING, so replaying a
// tool under it made Bubaly's work look like the approver's:
//
//   * a note the teen asked for was stamped `created_by` = the parent, and the
//     activity page renders `created_by` as who "added note" — so it read
//     "Mum added note";
//   * an RSVP would have been recorded for the parent and, because
//     `event_rsvps_once` makes the write an upsert, replaced their own reply.
//     That is why `rsvp_to_event` had no registry tool at all;
//   * and NO approved write reached the family activity feed, because
//     `recordActivity` returns early for `actorKind === 'member'`.
//
// One fix addresses all three: the replay runs under a scope that says Bubaly
// did it, for the asker. These call `scopeForApprovedWork` directly and assert
// on the IDS it produces — the property is about which id reaches the write, and
// driving the whole `decide` orchestration through a hand-rolled fake would test
// the fake more than the rule.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { scopeForApprovedWork } from '@/lib/services/approvals';

const APPROVER = { memberId: 'member-parent', userId: 'auth-parent' };
const ASKER = { memberId: 'member-teen', userId: 'auth-teen' };

type Row = Parameters<typeof scopeForApprovedWork>[1];

/** Just the roster lookup the helper makes, with its family filter captured. */
function makeDb(asker: { id: string; user_id: string | null } | null, error: unknown = null) {
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    eq: (column: string, value: unknown) => { filters[column] = value; return b; },
    maybeSingle: () => Promise.resolve({ data: asker, error }),
  });
  return { db: { from: () => b } as unknown as SupabaseClient<Database>, filters };
}

const approverScope = (db: SupabaseClient<Database>): ServiceScope => ({
  db, familyId: 'fam-1',
  userId: APPROVER.userId, memberId: APPROVER.memberId,
  role: 'parent', actorKind: 'member', tz: 'UTC',
} as ServiceScope);

const aiRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  requested_by_kind: 'ai',
  requested_by_member_id: ASKER.memberId,
  ...overrides,
} as unknown as Row);

describe('an approved AI action is attributed to whoever asked for it', () => {
  it('replays as the asker, not the parent who released it', async () => {
    const { db, filters } = makeDb({ id: ASKER.memberId, user_id: ASKER.userId });
    const scope = await scopeForApprovedWork(approverScope(db), aiRow());

    // Both ids move: memberId for member-scoped columns (event_rsvps.member_id),
    // userId for the `created_by` columns that reference auth.users.
    expect(scope.memberId).toBe(ASKER.memberId);
    expect(scope.userId).toBe(ASKER.userId);
    expect(scope.memberId).not.toBe(APPROVER.memberId);
    // The asker is resolved WITHIN the family, so a stale id from another
    // household cannot be adopted.
    expect(filters.family_id).toBe('fam-1');
  });

  it('marks the work as Bubaly\u2019s, which is also what restores the activity line', async () => {
    // recordActivity returns early for actorKind 'member', so while the replay
    // wore the approver's scope NO approved write reached the family feed.
    const { db } = makeDb({ id: ASKER.memberId, user_id: ASKER.userId });
    expect((await scopeForApprovedWork(approverScope(db), aiRow())).actorKind).toBe('ai');
  });

  it('keeps the approver\u2019s auth id when the asker has no login of their own', async () => {
    // A managed child profile has a family_members row and no user_id. The
    // member-scoped attribution still moves; created_by falls back rather than
    // writing null into a column the row may need.
    const { db } = makeDb({ id: ASKER.memberId, user_id: null });
    const scope = await scopeForApprovedWork(approverScope(db), aiRow());
    expect(scope.memberId).toBe(ASKER.memberId);
    expect(scope.userId).toBe(APPROVER.userId);
  });

  it('clears the member id when no asker was recorded, rather than falling back to the approver', async () => {
    // A row filed before the asker was recorded. Falling back to the decider is
    // how an RSVP answers for the wrong person and, on event_rsvps_once,
    // overwrites their reply — so first-person tools must refuse instead.
    // `rsvpToEvent`'s own guard fires on a null memberId.
    const { db } = makeDb(null);
    const scope = await scopeForApprovedWork(approverScope(db), aiRow({ requested_by_member_id: null }));
    expect(scope.memberId).toBeNull();
    expect(scope.actorKind).toBe('ai');
  });

  it('clears it too when the roster lookup fails or the member is gone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const { db } of [makeDb(null), makeDb(null, { message: 'boom' })]) {
      const scope = await scopeForApprovedWork(approverScope(db), aiRow());
      expect(scope.memberId).toBeNull();
    }
  });

  it('leaves a MEMBER-filed row under the decider, whose gate is re-evaluated', async () => {
    // executeTool is given skipTrust only for AI rows; a member-filed row is
    // re-gated under the approver's authority, so relabelling the actor as 'ai'
    // would change that evaluation and not merely its attribution.
    const { db } = makeDb({ id: ASKER.memberId, user_id: ASKER.userId });
    const scope = await scopeForApprovedWork(
      approverScope(db),
      aiRow({ requested_by_kind: 'member' }),
    );
    expect(scope.actorKind).toBe('member');
    expect(scope.memberId).toBe(APPROVER.memberId);
    expect(scope.userId).toBe(APPROVER.userId);
  });
});
