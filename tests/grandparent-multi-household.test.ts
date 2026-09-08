import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderHouseholds } from '@/lib/grandparent/digest';
import { GUEST_LANDING_PATH, landingPathForRole } from '@/lib/auth/landing';
import { INVITE_PRESETS } from '@/components/family/invite-form';
import { INVITABLE_ROLES } from '@/lib/constants/roles';
import { expectSays } from './helpers/translated';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', async () => {
  // The page is invoked directly, outside a request scope, so cookies() is
  // unavailable. Resolve through the real catalogue so the assertions keep
  // checking the words a grandparent sees.
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

import GrandparentPortalPage from '@/app/(app)/dashboard/grandparent-portal/page';

const callback = readFileSync('app/auth/callback/route.ts', 'utf8');
const authActions = readFileSync('app/(auth)/actions.ts', 'utf8');

type Rows = Record<string, unknown>[];
const FAMILIES: Record<string, { name: string; members: Rows; photos: Rows; milestones: Rows; announcements: Rows; dates: Rows }> = {
  'fam-rivera': {
    name: 'Rivera',
    members: [
      { id: 'm1', display_name: 'Ada Rivera', birthday: '1980-05-04', color: '#f00', role: 'parent', is_active: true },
      { id: 'm2', display_name: 'Bo Rivera', birthday: null, color: null, role: 'child', is_active: true },
    ],
    photos: [{ url: 'https://example.test/1.jpg', caption: 'Beach day', created_at: '2026-09-01T00:00:00Z' }],
    milestones: [{ id: 'ms1', title: 'Bo lost a tooth', description: null, milestone_date: '2026-08-20', member_id: 'm2' }],
    announcements: [{ id: 'an1', title: 'Recital on Friday', body: null, author_member_id: 'm1', created_at: '2026-09-02T00:00:00Z' }],
    dates: [],
  },
  'fam-chen': {
    name: 'Chen',
    members: [{ id: 'm3', display_name: 'Cy Chen', birthday: null, color: null, role: 'adult', is_active: true }],
    photos: [],
    milestones: [],
    announcements: [],
    dates: [],
  },
};

let failingFamilies: Set<string>;

function fakeClient() {
  return {
    from(table: string) {
      let familyId = '';
      const query: Record<string, unknown> = {};
      Object.assign(query, {
        select: () => query,
        eq: (column: string, value: string) => { if (column === 'family_id') familyId = value; return query; },
        order: () => query,
        limit: () => query,
        then: (resolve: (value: unknown) => unknown) => {
          if (table === 'family_members' && failingFamilies.has(familyId)) {
            return Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } }).then(resolve);
          }
          const family = FAMILIES[familyId];
          const data =
            table === 'family_members' ? family?.members
            : table === 'family_photos' ? family?.photos
            : table === 'family_milestones' ? family?.milestones
            : table === 'family_announcements' ? family?.announcements
            : family?.dates;
          return Promise.resolve({ data: data ?? [], error: null }).then(resolve);
        },
      });
      return query;
    },
  };
}

function context(familyIds: string[], activeFamilyId = familyIds[0]) {
  return {
    user: { id: 'user-1', email: 'grandma@example.test' },
    memberships: familyIds.map((familyId) => ({
      familyId,
      family: { id: familyId, name: FAMILIES[familyId].name },
      role: 'guest',
      member: { id: `self-${familyId}` },
    })),
    active: {
      familyId: activeFamilyId,
      family: { id: activeFamilyId, name: FAMILIES[activeFamilyId].name },
      role: 'guest',
      member: { id: `self-${activeFamilyId}` },
    },
  };
}

const render = async () => renderToStaticMarkup(await GrandparentPortalPage());

beforeEach(() => {
  failingFamilies = new Set();
  mocks.createServer.mockResolvedValue(fakeClient());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ordering the households', () => {
  it('puts the active family first and the rest alphabetically', () => {
    const ordered = orderHouseholds(
      [
        { familyId: 'b', familyName: 'Zimmer' },
        { familyId: 'a', familyName: 'Rivera' },
        { familyId: 'c', familyName: 'Chen' },
      ],
      'b',
    );
    expect(ordered.map((h) => h.familyId)).toEqual(['b', 'c', 'a']);
  });

  it('collapses a family that appears twice', () => {
    const ordered = orderHouseholds(
      [{ familyId: 'a', familyName: 'Rivera' }, { familyId: 'a', familyName: 'Rivera' }],
      'a',
    );
    expect(ordered).toHaveLength(1);
  });
});

describe('a grandparent in two households', () => {
  it('sees both families on one page', async () => {
    mocks.requireUserContext.mockResolvedValue(context(['fam-rivera', 'fam-chen']));
    const html = await render();

    expect(html).toContain('Rivera');
    expect(html).toContain('Chen');
    expect(html).toContain('Ada Rivera');
    expect(html).toContain('Bo Rivera');
    expect(html).toContain('Cy Chen');
    // Both digests, not one: the Rivera milestone and announcement render too.
    expect(html).toContain('Bo lost a tooth');
    expect(html).toContain('Recital on Friday');
    expect(html).toContain('2 families you are connected to');
  });

  it('keeps the single-household portal a single-household portal', async () => {
    mocks.requireUserContext.mockResolvedValue(context(['fam-rivera']));
    const html = await render();

    expect(html).toContain('Rivera');
    expect(html).not.toContain('families you are connected to');
  });

  it('fails closed for the family that could not be read, and only that one', async () => {
    failingFamilies.add('fam-chen');
    mocks.requireUserContext.mockResolvedValue(context(['fam-rivera', 'fam-chen']));
    const html = await render();

    // The failing household says so — it must not look like a family with
    // nothing to share, which is what an empty digest would say.
    expect(html).toContain('Could not load your family portal from Supabase. Refresh and try again.');
    expect(html).toContain('Chen');
    expect(html).not.toContain('Cy Chen');
    // …and the healthy household still renders in full.
    expect(html).toContain('Ada Rivera');
    expect(html).toContain('Bo lost a tooth');
    expect(console.error).toHaveBeenCalledWith(
      '[dashboard/grandparent-portal] member roster read failed',
      expect.objectContaining({ code: '42501' }),
    );
  });

  it('renders an error card for every household when the reads all fail', async () => {
    failingFamilies.add('fam-rivera');
    failingFamilies.add('fam-chen');
    mocks.requireUserContext.mockResolvedValue(context(['fam-rivera', 'fam-chen']));
    const html = await render();

    const notices = html.split('Could not load your family portal').length - 1;
    expect(notices).toBe(2);
    expect(html).not.toContain('Ada Rivera');
  });
});

describe('extended-family invite presets', () => {
  it('picks the role that gives each person the surface they came for', () => {
    const byKey = Object.fromEntries(INVITE_PRESETS.map((p) => [p.key, p]));
    expect(byKey.grandparent.role).toBe('guest');
    expect(byKey.caregiver.role).toBe('caregiver');
    expect(byKey.adult.role).toBe('adult');
    expect(byKey.teen.role).toBe('teen');
    // Every preset must be reachable through the invite form's own role list,
    // or the tile would write a role the invite cannot carry.
    for (const preset of INVITE_PRESETS) expect(INVITABLE_ROLES).toContain(preset.role);
  });

  it('promises no delegation the invite cannot create', () => {
    const form = readFileSync('components/family/invite-form.tsx', 'utf8');
    // A delegation needs a member row, and an invited person has none until
    // they accept. The form says where the time-limited half is granted rather
    // than claiming it happens by itself.
    expect(form).not.toMatch(/createDelegationAction|createSharingPresetAction/);
    expectSays(form, 'inviteForm.presetCaregiverNote', 'They join as a caregiver. Give them time-limited extras once they accept.');
    expectSays(form, 'inviteForm.timeLimitedAccessIsGranted', 'Time-limited access is granted after they accept, in');
    expect(form).toContain('href="/dashboard/trust"');
  });
});

describe('role-aware landing', () => {
  it('sends a guest to the portal and everyone else to Home', () => {
    expect(landingPathForRole('guest')).toBe(GUEST_LANDING_PATH);
    expect(GUEST_LANDING_PATH).toBe('/dashboard/grandparent-portal');
    for (const role of ['parent', 'adult', 'teen', 'child', 'caregiver', null, undefined]) {
      expect(landingPathForRole(role)).toBe('/home');
    }
  });

  it('is applied by the sign-in path from the membership, not the browser', () => {
    expect(authActions).toContain('return landingPathForRole(ctx.active.role);');
    // A context read that fails must not block a sign-in.
    expect(authActions).toContain('console.error(\'[auth] landing role lookup failed\', error);');
    expect(authActions).toContain('return DEFAULT_LANDING_PATH;');
  });

  it('is applied by the OAuth callback only when every membership is a guest one', () => {
    expect(callback).toContain("if (membership.length === 0) destination = '/onboarding';");
    expect(callback).toContain("else if (membership.every((m) => m.role === 'guest')) {");
    expect(callback).toContain("destination = landingPathForRole('guest');");
  });

  it('changes no sidebar navigation', () => {
    const navigation = readFileSync('lib/constants/navigation.ts', 'utf8');
    // The portal keeps the one nav entry it already had, for everybody.
    expect(navigation.match(/dashboard\/grandparent-portal/g)?.length).toBe(1);
  });
});
