// requireFeature lets a super administrator through; refuseUnlessEntitled, the
// gate on the endpoints behind those pages, did not. So for a super admin whose
// own family is not on Family+, /dashboard/autopilot and /dashboard/briefing
// rendered and then got 403 from /api/autopilot/scan and /api/ai/briefing
// (2026-09-27 page audit). The endpoint gate now asks the same question, but
// only after the family itself was refused, and a failed lookup stays a refusal.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  entitlement: { allowed: false, reason: 'plan', needLevel: 2, planLevel: 1 } as Record<string, unknown>,
  superAdmin: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/feature-entitlement', () => ({ resolveFeatureEntitlement: async () => h.entitlement }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: () => h.superAdmin() }));

import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';

const db = {} as never;

describe('a feature endpoint and the page in front of it', () => {
  beforeEach(() => {
    h.entitlement = { allowed: false, reason: 'plan', needLevel: 2, planLevel: 1 };
    h.superAdmin.mockReset();
  });

  it('refuses a family below the plan (control)', async () => {
    h.superAdmin.mockResolvedValue(false);
    const res = await refuseUnlessEntitled(db, 'fam', ['/dashboard/autopilot']);
    expect(res?.status).toBe(403);
  });

  it('lets a super administrator through, as the page does', async () => {
    h.superAdmin.mockResolvedValue(true);
    expect(await refuseUnlessEntitled(db, 'fam', ['/dashboard/autopilot'])).toBeNull();
  });

  it('does not ask who the caller is when the family is entitled', async () => {
    h.entitlement = { allowed: true, planLevel: 2 };
    expect(await refuseUnlessEntitled(db, 'fam', ['/dashboard/autopilot'])).toBeNull();
    expect(h.superAdmin).not.toHaveBeenCalled();
  });

  it('treats a failed super-admin lookup as a refusal, never as access', async () => {
    h.superAdmin.mockRejectedValue(new Error('auth unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await refuseUnlessEntitled(db, 'fam', ['/dashboard/autopilot']);
    expect(res?.status).toBe(403);
  });
});
