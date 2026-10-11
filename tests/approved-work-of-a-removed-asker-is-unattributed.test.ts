import { describe, expect, it } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { scopeForApprovedWork } from '@/lib/services/approvals';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// scopeForApprovedWork's own docs say a roster entry "since removed" resolves
// to unattributed(). Removal is a soft `is_active = false`, and the lookup did
// not filter on it, so a manager approving a request a removed member filed
// ran the work AS that member — first-person tools (an RSVP) answered for
// someone no longer in the family. loadRunActor already refuses that for
// queued runs.

type Row = Parameters<typeof scopeForApprovedWork>[1];
const row = { requested_by_kind: 'ai', requested_by_member_id: 'member-b' } as unknown as Row;

function scopeWith(isActive: boolean): ServiceScope {
  const db = createInMemorySupabase();
  db.seed('family_members', [{ id: 'member-b', family_id: 'fam', user_id: 'auth-b', is_active: isActive }]);
  return { db, familyId: 'fam', userId: 'auth-parent', memberId: 'member-parent', role: 'parent', actorKind: 'member', tz: 'UTC' } as unknown as ServiceScope;
}

describe('approved AI work filed by a since-removed member', () => {
  it('runs unattributed, not as the removed member', async () => {
    const scope = await scopeForApprovedWork(scopeWith(false), row);
    expect(scope.memberId).toBeNull();
    expect(scope.userId).toBe('auth-parent');
    expect(scope.actorKind).toBe('ai');
  });

  it('still runs as an active asker (control)', async () => {
    const scope = await scopeForApprovedWork(scopeWith(true), row);
    expect(scope.memberId).toBe('member-b');
    expect(scope.userId).toBe('auth-b');
  });
});
