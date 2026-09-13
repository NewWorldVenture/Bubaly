import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({
  member: { id: 'required-membership', updated_at: '2026-09-12T12:00:00Z' },
  role: 'parent',
  contextError: false,
  rosterError: false,
  captured: null as null | { membershipId: string; membershipUpdatedAt: string; value: Record<string, unknown>; initialMembers: unknown[] },
}));

vi.mock('next/cache', () => ({ unstable_noStore: () => {} }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (state.contextError) throw new Error('Required membership read unavailable');
    return {
      user: { id: 'user-1', email: null },
      active: { familyId: 'family-1', family: { id: 'family-1', name: 'Family' }, role: state.role, member: state.member },
      memberships: [],
    };
  },
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/server/feature-tiers', () => ({ getFeatureTiersByHref: async () => ({ '/calendar': 1 }) }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    from: (table: string) => {
      const result = () => table === 'family_members'
        ? { data: state.rosterError ? null : [{ id: 'stale-roster-membership', user_id: 'user-1', role: 'owner', updated_at: 'old-revision' }], error: state.rosterError ? { message: 'Roster unavailable' } : null }
        : { data: null, count: 0, error: null };
      const chain: Record<string, unknown> = new Proxy({}, {
        get: (_target, property) => property === 'then'
          ? (resolve: (value: ReturnType<typeof result>) => void) => Promise.resolve(result()).then(resolve)
          : () => chain,
      });
      return chain;
    },
  }),
}));
vi.mock('@/components/app/app-context', () => ({
  AppProvider: (props: NonNullable<typeof state.captured>) => { state.captured = props; return null; },
}));
vi.mock('@/components/app/app-shell', () => ({ AppShell: () => null }));
vi.mock('@/components/pwa/register-sw', () => ({ RegisterSW: () => null }));
vi.mock('@/components/native/native-bootstrap', () => ({ NativeBootstrap: () => null }));
vi.mock('@/components/native/push-registrar', () => ({ PushRegistrar: () => null }));

const frames = [
  ['shared app frame', async () => (await import('@/components/app/app-frame')).AppFrame],
  ['family layout', async () => (await import('@/app/(app)/family/layout')).default],
  ['capture layout', async () => (await import('@/app/(app)/capture/layout')).default],
] as const;

for (const [name, load] of frames) {
  describe(`${name} supplies verified cache membership`, () => {
    beforeEach(() => {
      state.member = { id: 'required-membership', updated_at: '2026-09-12T12:00:00Z' };
      state.role = 'parent'; state.contextError = false; state.rosterError = false; state.captured = null;
    });

    async function render() {
      const Frame = await load();
      renderToStaticMarkup(await Frame({ children: null }));
    }

    it('uses the required membership even when the optional roster contains stale privileges', async () => {
      await render();
      expect(state.captured).toMatchObject({
        membershipId: 'required-membership', membershipUpdatedAt: '2026-09-12T12:00:00Z',
        value: { userId: 'user-1', familyId: 'family-1', role: 'parent', isSuperAdmin: false, planLevel: 1, featureTiers: { '/calendar': 1 } },
      });
      expect(state.captured?.initialMembers).toEqual([expect.objectContaining({ role: 'owner' })]);
    });

    it('retains verified membership when the optional roster fails and passes a new access revision on refresh', async () => {
      state.rosterError = true;
      await render();
      expect(state.captured).toMatchObject({ membershipId: 'required-membership', initialMembers: [] });
      state.role = 'guest';
      state.member = { id: 'required-membership', updated_at: '2026-09-12T13:00:00Z' };
      await render();
      expect(state.captured).toMatchObject({ membershipUpdatedAt: '2026-09-12T13:00:00Z', value: { role: 'guest' } });
    });

    it('never constructs a cache authority after the required membership read fails', async () => {
      state.contextError = true;
      await expect(render()).rejects.toThrow('Required membership read unavailable');
      expect(state.captured).toBeNull();
    });
  });
}
