// The assistant lists removed members to a manager only (N13-S1).
//
// The export's members section hands removed members to a parent or adult
// only. family.listMembers did not: any role that set include_inactive got
// every removed member's name, role and age — an ex-partner, a former
// caregiver — although the roster that same child or guest sees on the family
// page reads active members only. The tool now honours include_inactive for a
// manager and reads the active roster for everyone else. (fm_select's RLS,
// which still lets a member read the rows, is the owner's decision.)
//
// Driven through the real tool and service against the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const { familyTools } = await import('@/lib/ai/tools/family');

const FAMILY = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const listMembers = familyTools.find((t) => t.name === 'family.listMembers') as unknown as {
  execute: (scope: ServiceScope, input: unknown) => Promise<{ ok: boolean; data?: { members: { id: string; name: string }[] } }>;
  input: { parse: (v: unknown) => unknown };
};

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('family_members', [
    { id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', display_name: 'Jordan', role: 'parent', is_active: true, birthday: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'mem-adult', family_id: FAMILY, user_id: 'user-adult', display_name: 'Ana', role: 'adult', is_active: true, birthday: null, created_at: '2026-01-02T00:00:00Z' },
    { id: 'mem-child', family_id: FAMILY, user_id: 'user-child', display_name: 'Mia', role: 'child', is_active: true, birthday: '2017-09-12', created_at: '2026-01-03T00:00:00Z' },
    // Removed: the ex-partner the family page no longer shows anyone.
    { id: 'mem-ex', family_id: FAMILY, user_id: 'user-ex', display_name: 'Ex', role: 'guest', is_active: false, birthday: '1985-02-14', created_at: '2026-01-04T00:00:00Z' },
  ]);
});

const scopeFor = (role: ServiceScope['role']): ServiceScope => ({
  db: db as unknown as ServiceScope['db'], familyId: FAMILY, userId: `user-${role}`, memberId: `mem-${role}`,
  role, actorKind: 'ai', tz: 'UTC', now: new Date('2026-10-10T12:00:00Z'),
});

async function namesListedTo(role: ServiceScope['role'], includeInactive: boolean | undefined) {
  const res = await listMembers.execute(scopeFor(role), listMembers.input.parse(includeInactive === undefined ? {} : { include_inactive: includeInactive }));
  expect(res.ok).toBe(true);
  return res.data!.members.map((m) => m.name);
}

describe('family.listMembers { include_inactive: true }', () => {
  it.each(['parent', 'adult'] as const)('lists removed members to a %s', async (role) => {
    expect(await namesListedTo(role, true)).toEqual(['Jordan', 'Ana', 'Mia', 'Ex']);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('reads only the active roster for a %s', async (role) => {
    expect(await namesListedTo(role, true)).toEqual(['Jordan', 'Ana', 'Mia']);
  });

  it('still leaves removed members out for a manager who does not ask (control)', async () => {
    expect(await namesListedTo('parent', undefined)).toEqual(['Jordan', 'Ana', 'Mia']);
  });
});
