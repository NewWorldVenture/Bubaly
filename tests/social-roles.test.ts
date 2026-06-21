import { describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS, hasPermission, isSocialRole, defaultSocialRoleForMember,
  SOCIAL_ROLES, SOCIAL_PERMISSIONS,
} from '@/lib/social/roles';

describe('social access control matrix', () => {
  it('owner and admin can publish; analyst and read_only cannot', () => {
    expect(hasPermission('owner', 'publish_posts')).toBe(true);
    expect(hasPermission('admin', 'publish_posts')).toBe(true);
    expect(hasPermission('analyst', 'publish_posts')).toBe(false);
    expect(hasPermission('read_only', 'publish_posts')).toBe(false);
  });

  it('content creators can draft + generate but not publish', () => {
    expect(hasPermission('content_creator', 'create_drafts')).toBe(true);
    expect(hasPermission('content_creator', 'generate_ai')).toBe(true);
    expect(hasPermission('content_creator', 'publish_posts')).toBe(false);
  });

  it('only owner manages access', () => {
    expect(hasPermission('owner', 'manage_access')).toBe(true);
    expect(hasPermission('admin', 'manage_access')).toBe(false);
    expect(hasPermission('marketing_manager', 'manage_access')).toBe(false);
  });

  it('every role grants at least view_feed', () => {
    for (const r of SOCIAL_ROLES) {
      expect(hasPermission(r, 'view_feed')).toBe(true);
    }
  });

  it('permissions reference only known permission keys', () => {
    for (const r of SOCIAL_ROLES) {
      for (const p of ROLE_PERMISSIONS[r]) {
        expect(SOCIAL_PERMISSIONS).toContain(p);
      }
    }
  });

  it('maps household member roles to sensible defaults', () => {
    expect(defaultSocialRoleForMember('parent')).toBe('admin');
    expect(defaultSocialRoleForMember('adult')).toBe('marketing_manager');
    expect(defaultSocialRoleForMember('teen')).toBe('content_creator');
    expect(defaultSocialRoleForMember('child')).toBe('read_only');
    expect(defaultSocialRoleForMember(null)).toBe('read_only');
  });

  it('isSocialRole guards unknown values', () => {
    expect(isSocialRole('owner')).toBe(true);
    expect(isSocialRole('superuser')).toBe(false);
    expect(hasPermission(null, 'view_feed')).toBe(false);
  });
});
