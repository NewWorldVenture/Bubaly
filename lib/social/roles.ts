// lib/social/roles.ts
//
// Access control for the Social Media Command Center. A social role is granted
// per family via social_access_permissions; it is INDEPENDENT of (and additive
// to) the household MemberRole. The matrix below is the single source of truth
// used by the UI to hide controls and by server actions to reject calls. The
// database RLS (0024) is the real enforcement boundary; this mirrors it.

export type SocialRole =
  | 'owner'
  | 'admin'
  | 'marketing_manager'
  | 'social_manager'
  | 'content_creator'
  | 'approver'
  | 'analyst'
  | 'read_only';

export const SOCIAL_ROLES: SocialRole[] = [
  'owner', 'admin', 'marketing_manager', 'social_manager',
  'content_creator', 'approver', 'analyst', 'read_only',
];

export type SocialPermission =
  | 'connect_accounts'
  | 'view_feed'
  | 'create_drafts'
  | 'generate_ai'
  | 'upload_media'
  | 'publish_posts'
  | 'schedule_posts'
  | 'approve_posts'
  | 'view_analytics'
  | 'manage_settings'
  | 'manage_access';

export const SOCIAL_PERMISSIONS: SocialPermission[] = [
  'connect_accounts', 'view_feed', 'create_drafts', 'generate_ai', 'upload_media',
  'publish_posts', 'schedule_posts', 'approve_posts', 'view_analytics',
  'manage_settings', 'manage_access',
];

const ALL: SocialPermission[] = [...SOCIAL_PERMISSIONS];

export const ROLE_PERMISSIONS: Record<SocialRole, SocialPermission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== 'manage_access'),
  marketing_manager: [
    'connect_accounts', 'view_feed', 'create_drafts', 'generate_ai', 'upload_media',
    'publish_posts', 'schedule_posts', 'approve_posts', 'view_analytics', 'manage_settings',
  ],
  social_manager: [
    'view_feed', 'create_drafts', 'generate_ai', 'upload_media',
    'publish_posts', 'schedule_posts', 'view_analytics',
  ],
  content_creator: [
    'view_feed', 'create_drafts', 'generate_ai', 'upload_media',
  ],
  approver: [
    'view_feed', 'approve_posts', 'view_analytics',
  ],
  analyst: [
    'view_feed', 'view_analytics',
  ],
  read_only: [
    'view_feed',
  ],
};

export const SOCIAL_ROLE_LABELS: Record<SocialRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  marketing_manager: 'Marketing Manager',
  social_manager: 'Social Media Manager',
  content_creator: 'Content Creator',
  approver: 'Approver',
  analyst: 'Analyst',
  read_only: 'Read Only',
};

export const SOCIAL_ROLE_DESCRIPTIONS: Record<SocialRole, string> = {
  owner: 'Full control including access management and provider settings.',
  admin: 'Full operational control over accounts, content, publishing, and settings.',
  marketing_manager: 'Plan, create, approve, schedule, publish, and analyze; manage settings.',
  social_manager: 'Create, schedule, and publish content; view analytics.',
  content_creator: 'Create drafts, generate AI content, and upload media. Cannot publish.',
  approver: 'Review and approve queued content; view analytics.',
  analyst: 'Read-only access to the feed and analytics.',
  read_only: 'View the unified feed only.',
};

export function hasPermission(role: SocialRole | null | undefined, permission: SocialPermission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function isSocialRole(value: unknown): value is SocialRole {
  return typeof value === 'string' && (SOCIAL_ROLES as string[]).includes(value);
}

/**
 * Map a household MemberRole to a sensible DEFAULT social role for families that
 * have not configured granular social access. Parents/adults manage; teens
 * create; everyone else reads. Explicit social_access_permissions rows override.
 */
export function defaultSocialRoleForMember(memberRole: string | null | undefined): SocialRole {
  switch (memberRole) {
    case 'parent':
      return 'admin';
    case 'adult':
      return 'marketing_manager';
    case 'teen':
      return 'content_creator';
    default:
      return 'read_only';
  }
}
