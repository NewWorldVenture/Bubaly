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
