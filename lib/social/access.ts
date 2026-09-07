// lib/social/access.ts
// Server-side resolution of the caller's social role + permission guards. Mirrors
// the SQL helper public.social_has_permission (migration 0034). Use these in
// server actions / route handlers BEFORE any privileged write; RLS is the backstop.
import 'server-only';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import {
  ROLE_PERMISSIONS, defaultSocialRoleForMember, isSocialRole,
  type SocialRole, type SocialPermission,
} from './roles';

export type SocialAccess = {
  familyId: string;
  userId: string;
  role: SocialRole;
  permissions: SocialPermission[];
  can: (permission: SocialPermission) => boolean;
};

/**
 * Resolve the caller's effective social role for a family: an explicit
 * social_access_permissions row wins; otherwise we fall back to a sensible
 * default derived from their household member role.
 */
export async function getSocialAccess(familyId: string): Promise<SocialAccess | null> {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const [{ data: explicit }, { data: member }] = await settleAll([
    supabase
      .from('social_access_permissions')
      .select('social_role, status')
      .eq('family_id', familyId)
      .eq('user_id', auth.user.id)
      .eq('status', 'active')
      .maybeSingle(),
    supabase
      .from('family_members')
      .select('role')
      .eq('family_id', familyId)
      .eq('user_id', auth.user.id)
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  // Not a member of this family at all → no access (RLS would block anyway).
  if (!member && !explicit) return null;

  const role: SocialRole = isSocialRole(explicit?.social_role)
    ? explicit!.social_role
    : defaultSocialRoleForMember(member?.role);

  const permissions = ROLE_PERMISSIONS[role] ?? [];
  return {
    familyId,
    userId: auth.user.id,
    role,
    permissions,
    can: (permission) => permissions.includes(permission),
  };
}

export class SocialAccessError extends Error {
  constructor(public permission: SocialPermission) {
    super(`Missing social permission: ${permission}`);
    this.name = 'SocialAccessError';
  }
}

/** Throws SocialAccessError when the caller lacks the permission. */
export async function requireSocialPermission(
  familyId: string,
  permission: SocialPermission,
): Promise<SocialAccess> {
  const access = await getSocialAccess(familyId);
  if (!access || !access.can(permission)) {
    throw new SocialAccessError(permission);
  }
  return access;
}
