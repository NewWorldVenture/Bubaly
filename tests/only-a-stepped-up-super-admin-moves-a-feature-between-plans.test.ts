// Call-level role tests for the Tier & Features admin actions
// (app/(app)/admin/tier-features/actions.ts), Register B ACTION-8B8E0B6A7AA6
// (setFeatureTierAction) and ACTION-04A8A8C1AE2F (resetFeatureTiersAction).
//
// THE POLICY. Feature tiers are platform-wide: one `app_settings` row
// (key 'feature_tiers') decides which plan unlocks each feature for EVERY
// family. Only a super admin whose session has proved its authenticator may
// change it (lib/auth/super-admin-gate.ts). app_settings has no write policy at
// all for `authenticated` (0276_app_settings_feature_tiers_read.sql:30-33), so
// the action writes with the service client and the gate is the only boundary.
// A family's own roles — a parent included — are not super admins.
//
// WHAT IS ASSERTED: the real actions, driven against an in-memory app_settings
// and audit_logs, write the override (or clear them) and one audit row for an
// allowed super admin, and for a non-admin parent, a signed-out caller and a
// super admin who has not stepped up they answer the gate's refusal, never
// open the service client, and write nothing.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  superAdmin: false,
  assurance: true,
  db: null as unknown,
  serviceClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: h.assurance }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => h.user,
  isSuperAdmin: async () => h.superAdmin,
  requireUserContext: async () => { throw new Error('not used by the admin actions'); },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { h.serviceClient(); return h.db; },
  createServer: async () => { throw new Error('the admin actions write with the service client only'); },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }));

const { setFeatureTierAction, resetFeatureTiersAction } = await import('@/app/(app)/admin/tier-features/actions');

const ADMIN = { id: '00000000-0000-4000-8000-0000000000a1', email: 'admin@example.com' };
const PARENT = { id: '00000000-0000-4000-8000-0000000000b1', email: 'parent@example.com' };
const STAMP = '2026-01-01T00:00:00.000Z';

let db: InMemorySupabase;

const settings = () => structuredClone(db.table('app_settings'));
const audits = () => structuredClone(db.table('audit_logs'));

function as(who: 'super-admin' | 'super-admin-no-step-up' | 'parent' | 'signed-out') {
  h.user = who === 'signed-out' ? null : who === 'parent' ? PARENT : ADMIN;
  h.superAdmin = who === 'super-admin' || who === 'super-admin-no-step-up';
  h.assurance = who !== 'super-admin-no-step-up';
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase({ uniques: { app_settings: [['key']] } });
  h.db = db;
  db.seed('app_settings', [{ key: 'feature_tiers', value: { calendar: 'basic' }, updated_at: STAMP }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const REFUSALS = [
  ['a non-admin parent', 'parent', EN_US['actions.notAuthorized']],
  ['a signed-out caller', 'signed-out', EN_US['actions.notAuthorized']],
  ['a super admin who has not stepped up', 'super-admin-no-step-up', EN_US['actions.adminConsoleNeedsYourCode']],
] as const;

describe('setFeatureTierAction', () => {
  it('ACTION-8B8E0B6A7AA6 a stepped-up super admin moves a feature to another plan, and it is audited', async () => {
    as('super-admin');
    expect(await setFeatureTierAction('meals', 'plus')).toEqual({ ok: true });

    expect(db.table('app_settings')).toHaveLength(1);
    expect(db.table('app_settings')[0]).toMatchObject({
      key: 'feature_tiers', value: { calendar: 'basic', meals: 'plus' }, updated_by: ADMIN.id,
    });
    expect(db.table('app_settings')[0].updated_at).not.toBe(STAMP);
    expect(db.table('audit_logs')).toHaveLength(1);
    expect(db.table('audit_logs')[0]).toMatchObject({
      family_id: null, actor_id: ADMIN.id, action: 'update', resource: 'feature_tiers',
      metadata: { key: 'meals', previous_tier: 'free', tier: 'plus', via: 'site_admin' },
    });
    expect(h.revalidatePath).toHaveBeenCalledWith('/admin/tier-features');
  });

  it.each(REFUSALS)('ACTION-8B8E0B6A7AA6 %s is refused, the service client is never opened, and nothing is written', async (_who, role, error) => {
    as(role);
    const before = { settings: settings(), audits: audits() };

    expect(await setFeatureTierAction('meals', 'plus')).toEqual({ ok: false, error });

    expect(h.serviceClient).not.toHaveBeenCalled();
    expect({ settings: settings(), audits: audits() }).toEqual(before);
    expect(db.table('app_settings')[0].value).toEqual({ calendar: 'basic' });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-8B8E0B6A7AA6 a super admin cannot write a key outside the catalogue or a tier that does not exist', async () => {
    as('super-admin');
    const before = settings();
    expect(await setFeatureTierAction('not-a-feature', 'plus')).toEqual({ ok: false, error: EN_US['actions.chooseAValidFeature'] });
    expect(await setFeatureTierAction('meals', 'platinum')).toEqual({ ok: false, error: EN_US['actions.chooseAValidTier'] });
    expect(settings()).toEqual(before);
    expect(db.table('audit_logs')).toEqual([]);
  });
});

describe('resetFeatureTiersAction', () => {
  it('ACTION-04A8A8C1AE2F a stepped-up super admin clears every override, and the cleared set is audited', async () => {
    as('super-admin');
    expect(await resetFeatureTiersAction()).toEqual({ ok: true });

    expect(db.table('app_settings')).toHaveLength(1);
    expect(db.table('app_settings')[0]).toMatchObject({ key: 'feature_tiers', value: {}, updated_by: ADMIN.id });
    expect(db.table('audit_logs')).toHaveLength(1);
    expect(db.table('audit_logs')[0]).toMatchObject({
      family_id: null, actor_id: ADMIN.id, action: 'reset', resource: 'feature_tiers',
      metadata: { setting_key: 'feature_tiers', previous_overrides: { calendar: 'basic' }, via: 'site_admin' },
    });
  });

  it.each(REFUSALS)('ACTION-04A8A8C1AE2F %s is refused, the service client is never opened, and the overrides stay', async (_who, role, error) => {
    as(role);
    const before = { settings: settings(), audits: audits() };

    expect(await resetFeatureTiersAction()).toEqual({ ok: false, error });

    expect(h.serviceClient).not.toHaveBeenCalled();
    expect({ settings: settings(), audits: audits() }).toEqual(before);
    expect(db.table('app_settings')[0].value).toEqual({ calendar: 'basic' });
  });
});
