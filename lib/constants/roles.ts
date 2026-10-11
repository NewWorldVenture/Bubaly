// Role model — mirrors the public.member_role enum and the permission matrix.
// Used for UI gating; the database RLS is the real enforcement boundary.

export type MemberRole = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

export const ROLE_LABELS: Record<MemberRole, string> = {
  parent: 'Parent / Admin',
  adult: 'Adult',
  teen: 'Teen',
  child: 'Child',
  caregiver: 'Caregiver',
  guest: 'Guest',
};

export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  parent: 'Full control: members, billing, and all household data.',
  adult: 'Manage shared household data and approve chores.',
  teen: 'Manage their own tasks, activities, and calendar.',
  child: 'Complete assigned chores and view their items.',
  caregiver: 'View only the areas assigned to them.',
  guest: 'View limited shared events only.',
};

/**
 * Catalogue keys for the two maps above. ROLE_LABELS / ROLE_DESCRIPTIONS are
 * English, for the places that have no reader (the assistant's context); a
 * screen renders `t(ROLE_LABEL_KEYS[role])`. The labels share `trustRole.*`
 * with the trust and invite screens, so a role reads the same everywhere.
 */
export const ROLE_LABEL_KEYS: Record<MemberRole, string> = {
  parent: 'trustRole.parent',
  adult: 'trustRole.adult',
  teen: 'trustRole.teen',
  child: 'trustRole.child',
  caregiver: 'trustRole.caregiver',
  guest: 'trustRole.guest',
};

export const ROLE_DESCRIPTION_KEYS: Record<MemberRole, string> = {
  parent: 'roleDescription.parent',
  adult: 'roleDescription.adult',
  teen: 'roleDescription.teen',
  child: 'roleDescription.child',
  caregiver: 'roleDescription.caregiver',
  guest: 'roleDescription.guest',
};

/** A role's label for a reader, or the raw value for one this build doesn't know. */
export function roleLabel(t: (key: string) => string, role: string | null | undefined): string {
  if (!role) return '';
  return Object.hasOwn(ROLE_LABEL_KEYS, role) ? t(ROLE_LABEL_KEYS[role as MemberRole]) : role;
}

/** Managers can edit shared data and approve chores. */
export const MANAGER_ROLES: MemberRole[] = ['parent', 'adult'];
export const isManager = (role?: string | null) =>
  role === 'parent' || role === 'adult';
export const isAdmin = (role?: string | null) => role === 'parent';

export const ROLE_ORDER: MemberRole[] = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'];

// Roles that can be assigned when inviting (guests/children are typically managed locally).
export const INVITABLE_ROLES: MemberRole[] = ['adult', 'teen', 'caregiver', 'guest'];

/**
 * The roles an actor may give a member row from the roster editor.
 *
 * `parent` is the admin tier (`is_family_admin`: billing, closing the family,
 * assistant keys); `adult` manages but is not an admin. Offering every role to
 * every manager let an adult promote themselves to parent, or demote the
 * parents who founded the family. So only a parent may grant `parent`, and a
 * non-admin cannot change the role of a row that already IS a parent (the only
 * option offered is the one it has). This is UI gating; the database policy is
 * the real boundary.
 */
export function assignableMemberRoles(actorRole?: string | null, currentRole?: string | null): MemberRole[] {
  if (isAdmin(actorRole)) return [...ROLE_ORDER];
  if (currentRole === 'parent') return ['parent'];
  return ROLE_ORDER.filter((r) => r !== 'parent');
}

/**
 * The patch every "remove member" path writes. Removal is a soft delete, and
 * `accept_invite` (0136) reactivates an existing (family_id, user_id) row with
 * `on conflict ... set is_active = true` WITHOUT writing the invite's role. So
 * a removed parent re-invited as a caregiver came back as a parent — and so
 * did anyone holding a second invite issued before their removal. Dropping the
 * row to the lowest role on removal means reactivation can only ever restore
 * the least privilege; the matching SQL fix belongs in accept_invite.
 */
export const REMOVED_MEMBER_PATCH = { is_active: false, role: 'guest' } as const satisfies { is_active: boolean; role: MemberRole };

/** Whether `actorRole` may remove (deactivate) a member whose role is `targetRole`: a parent only by a parent. */
export function canRemoveMember(actorRole?: string | null, targetRole?: string | null): boolean {
  if (!isManager(actorRole)) return false;
  return targetRole !== 'parent' || isAdmin(actorRole);
}

/**
 * Whether `actorRole` may send an invite carrying `inviteRole`: only a manager
 * invites, only a parent may invite a `parent`, and anything else must be one
 * of INVITABLE_ROLES.
 */
export function canInviteWithRole(actorRole?: string | null, inviteRole?: string | null): boolean {
  if (!isManager(actorRole) || !inviteRole) return false;
  if (inviteRole === 'parent') return isAdmin(actorRole);
  return (INVITABLE_ROLES as string[]).includes(inviteRole);
}
