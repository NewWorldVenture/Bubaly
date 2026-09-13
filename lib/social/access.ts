// lib/social/access.ts
// Server-side resolution of the caller's social role + permission guards. Mirrors
// the SQL helper public.social_has_permission (migration 0034). Use these in
// server actions / route handlers BEFORE any privileged write; RLS is the backstop.
import 'server-only';
import { createServer } from '@/lib/supabase/server';
import { settle, settleAll } from '@/lib/supabase/settle';
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

export class SocialAccessUnavailableError extends Error {
  constructor() {
    super('Social access is temporarily unavailable.');
    this.name = 'SocialAccessUnavailableError';
  }
}

function isMissingSession(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const missing = error as { name?: unknown; code?: unknown };
  return missing.name === 'AuthSessionMissingError' || missing.code === 'session_missing';
}

/**
 * Resolve the caller's effective social role for a family: an explicit
 * social_access_permissions row wins; otherwise we fall back to a sensible
 * default derived from their household member role.
 */
export async function getSocialAccess(familyId: string): Promise<SocialAccess | null> {
  const supabase = await createServer();
  const { data: auth, error: authError } = await settle(supabase.auth.getUser());
  if (authError) {
    if (!auth?.user && isMissingSession(authError)) return null;
    throw new SocialAccessUnavailableError();
  }
  if (!auth?.user) return null;

  const [{ data: explicit, error: permissionError }, { data: member, error: memberError }] = await settleAll([
    supabase
      .from('social_access_permissions')
      .select('family_id, user_id, social_role, status')
      .eq('family_id', familyId)
      .eq('user_id', auth.user.id)
      .eq('status', 'active')
      .maybeSingle(),
    supabase
      .from('family_members')
      .select('family_id, user_id, role, is_active')
      .eq('family_id', familyId)
      .eq('user_id', auth.user.id)
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  // An unreadable override is not an absent override. A service-role provider
  // write must never gain the household default by losing a required read.
  if (permissionError || memberError) throw new SocialAccessUnavailableError();
  if (!member) return null;
  if (member.family_id !== familyId || member.user_id !== auth.user.id || member.is_active !== true) {
    throw new SocialAccessUnavailableError();
  }
  if (explicit && (explicit.family_id !== familyId || explicit.user_id !== auth.user.id ||
    explicit.status !== 'active' || !isSocialRole(explicit.social_role))) {
    throw new SocialAccessUnavailableError();
  }

  const role: SocialRole = explicit ? explicit.social_role : defaultSocialRoleForMember(member.role);

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
