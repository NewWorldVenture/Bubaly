// The export's members section hands removed members to a manager only.
//
// readSection('members') called getMembers with includeInactive: true for
// EVERY role, so a child's or guest's export carried the birthday, auth user id
// and avatar of every person removed from the family — an ex-partner, a former
// caregiver — while the roster the same child sees reads `is_active = true`
// (app/(app)/family/members/page.tsx). The module's own header promises the
// file is "a view of what the person could already open, written down"; here
// it was more. Removed members now appear only in a parent's or adult's file,
// and the section says which it holds (includesRemovedMembers).
import { describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { ServiceScope } from '@/lib/services/types';
import { buildFamilyExport, type ExportSection } from '@/lib/privacy/export';

vi.mock('@/lib/supabase/auth', () => ({ getUserContext: async () => null }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => null }));

const FAMILY = 'fam-1';
type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver';
type Member = { id: string; displayName: string; isActive: boolean; birthday: string | null; userId: string | null };

function household(): InMemorySupabase {
  const db = createInMemorySupabase({ userId: 'user-parent' });
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', display_name: 'Jordan', role: 'parent', is_active: true, birthday: null, color: null, avatar_url: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'mem-adult', family_id: FAMILY, user_id: 'user-adult', display_name: 'Ana', role: 'adult', is_active: true, birthday: null, color: null, avatar_url: null, created_at: '2026-01-02T00:00:00Z' },
    { id: 'mem-teen', family_id: FAMILY, user_id: 'user-teen', display_name: 'Sam', role: 'teen', is_active: true, birthday: '2011-04-02', color: null, avatar_url: null, created_at: '2026-01-03T00:00:00Z' },
    { id: 'mem-child', family_id: FAMILY, user_id: 'user-child', display_name: 'Mia', role: 'child', is_active: true, birthday: '2017-09-12', color: null, avatar_url: null, created_at: '2026-01-04T00:00:00Z' },
    { id: 'mem-carer', family_id: FAMILY, user_id: 'user-carer', display_name: 'Kim', role: 'caregiver', is_active: true, birthday: null, color: null, avatar_url: null, created_at: '2026-01-05T00:00:00Z' },
    // Removed: an ex-partner, with the birthday, account and photo the roster no longer shows anyone.
    { id: 'mem-ex', family_id: FAMILY, user_id: 'user-ex', display_name: 'Ex', role: 'guest', is_active: false, birthday: '1985-02-14', color: null, avatar_url: 'https://cdn.example/avatars/user-ex/x.png', created_at: '2026-01-06T00:00:00Z' },
  ]);
  return db;
}

const scopeFor = (db: InMemorySupabase, role: Role): ServiceScope => ({
  db: db as unknown as ServiceScope['db'], familyId: FAMILY, userId: `user-${role}`, memberId: `mem-${role === 'caregiver' ? 'carer' : role}`,
  role, actorKind: 'member', tz: 'UTC',
});

async function membersSection(role: Role): Promise<ExportSection & { data: Member[] }> {
  const built = await buildFamilyExport(scopeFor(household(), role));
  expect(built.ok, role).toBe(true);
  if (!built.ok) throw new Error('unreachable');
  return built.data.sections.find((s) => s.key === 'members') as ExportSection & { data: Member[] };
}

describe('the members section of the export', () => {
  it.each(['teen', 'child', 'caregiver'] as const)('carries no removed member for a %s, and says so', async (role) => {
    const section = await membersSection(role);
    expect(section.includesRemovedMembers).toBe(false);
    expect(section.data.some((m) => !m.isActive)).toBe(false);
    expect(section.data.some((m) => m.id === 'mem-ex' || m.userId === 'user-ex' || m.birthday === '1985-02-14')).toBe(false);
    // The active roster is still whole.
    expect(section.data.map((m) => m.id).sort()).toEqual(['mem-adult', 'mem-carer', 'mem-child', 'mem-parent', 'mem-teen']);
    expect(section.count).toBe(5);
  });

  it.each(['parent', 'adult'] as const)('carries removed members for a %s — the roles that manage removals — and says so', async (role) => {
    const section = await membersSection(role);
    expect(section.includesRemovedMembers).toBe(true);
    expect(section.data.find((m) => m.id === 'mem-ex')).toMatchObject({ isActive: false, birthday: '1985-02-14' });
    expect(section.count).toBe(6);
  });

  it('no other section claims the flag', async () => {
    const built = await buildFamilyExport(scopeFor(household(), 'parent'));
    if (!built.ok) throw new Error('unreachable');
    expect(built.data.sections.filter((s) => s.key !== 'members').every((s) => s.includesRemovedMembers === undefined)).toBe(true);
  });
});
