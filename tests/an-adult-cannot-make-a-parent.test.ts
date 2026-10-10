import { readFileSync } from 'node:fs';
import { at } from './helpers/source-order';
import { describe, expect, it } from 'vitest';
import {
  REMOVED_MEMBER_PATCH, assignableMemberRoles, canInviteWithRole, canRemoveMember,
} from '@/lib/constants/roles';

// `parent` is the admin tier (is_family_admin: billing, closing the family,
// assistant keys, parentsOnly approvals); `adult` is a manager but not an
// admin. The roster editor offered every role to every manager, so an adult
// could make themselves a parent and demote or remove the parents. The
// database half (a restrictive fm_update / invites policy) is SQL and is
// reported, not shipped, here; these hold the application half.

describe('the roster editor never lets a non-parent grant or take away parent', () => {
  it('offers parent only to a parent', () => {
    expect(assignableMemberRoles('parent', 'child')).toContain('parent');
    expect(assignableMemberRoles('adult', 'child')).not.toContain('parent');
    expect(assignableMemberRoles('adult', 'adult')).not.toContain('parent');
    expect(assignableMemberRoles('adult', null)).not.toContain('parent');
  });

  it("does not let an adult change a parent's role", () => {
    expect(assignableMemberRoles('adult', 'parent')).toEqual(['parent']);
    expect(assignableMemberRoles('parent', 'parent')).toContain('adult');
  });

  it('lets only a parent remove a parent', () => {
    expect(canRemoveMember('adult', 'parent')).toBe(false);
    expect(canRemoveMember('parent', 'parent')).toBe(true);
    expect(canRemoveMember('adult', 'child')).toBe(true);
    expect(canRemoveMember('child', 'guest')).toBe(false);
  });

  it('family-module renders and enforces those options, not the full role list', () => {
    const src = readFileSync('components/modules/family-module.tsx', 'utf8');
    expect(src).not.toContain('ROLE_OPTIONS');
    expect(src).toContain('assignableMemberRoles(actorRole, member?.role ?? null)');
    expect(src).toContain('{roleOptions.map((r) =>');
    expect(src).toContain('if (!roleOptions.includes(mrole))');
    expect(src).toContain('canRemoveMember(role, removeMember.role)');
  });
});

describe('an invite cannot outrank the person sending it', () => {
  it('refuses a parent invite from an adult, and any invite from a non-manager', () => {
    expect(canInviteWithRole('adult', 'parent')).toBe(false);
    expect(canInviteWithRole('parent', 'parent')).toBe(true);
    expect(canInviteWithRole('adult', 'caregiver')).toBe(true);
    expect(canInviteWithRole('child', 'guest')).toBe(false);
    expect(canInviteWithRole('guest', 'adult')).toBe(false);
  });

  it('the invite form checks it before writing the row', () => {
    const src = readFileSync('components/family/invite-form.tsx', 'utf8');
    expect(at(src, 'if (!canInviteWithRole(actorRole, role))')).toBeLessThan(at(src, ".from('invites').insert("));
  });
});

describe('a removed member comes back, if ever, with the least privilege', () => {
  // accept_invite (0136) reactivates the old row on conflict without writing
  // the invite's role, so a removed parent re-invited as a caregiver returned
  // as a parent. Every removal path now drops the row to `guest` as well.
  it('the removal patch deactivates AND drops the role', () => {
    expect(REMOVED_MEMBER_PATCH).toEqual({ is_active: false, role: 'guest' });
  });

  it.each([
    // family-module and settings-module remove through this server action.
    'app/(app)/family/member-actions.ts',
    'app/(app)/admin/actions.ts',
  ])('%s removes with that patch', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('.update(REMOVED_MEMBER_PATCH)');
    expect(src).not.toMatch(/from\('family_members'\)\s*\.update\(\{ is_active: false \}\)/);
  });
});
