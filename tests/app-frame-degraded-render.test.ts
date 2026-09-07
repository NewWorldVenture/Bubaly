import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// AppFrame wraps EVERY authenticated route, so a throw here is not one broken
// page — it is the whole signed-in app rendering "This page hit a snag", which
// is the second failure the operator reported (on /dashboard).
//
// The leaf client components are stubbed: they need a Next router/request
// context that has nothing to do with the read boundary under test. What is NOT
// stubbed is the part that can actually fail — the Supabase reads and the two
// access checks — and the assertions are about the values AppFrame hands down
// when those fail.

type Mode = 'ok' | 'resolved-error' | 'reject';
let mode: Mode = 'ok';

/**
 * A thenable that chains like a Postgrest builder and settles like one.
 * A Proxy rather than a fixed method list, so adding a `.not()` or `.range()`
 * to a query never silently turns this test into a false pass.
 */
function builder(table: string): Record<string, unknown> {
  const settle = () => {
    if (mode === 'ok') return Promise.resolve({ data: [], count: 3, error: null });
    if (mode === 'reject') return Promise.reject(new Error(`CONNECT_TIMEOUT reading ${table}`));
    return Promise.resolve({ data: null, count: null, error: { message: `no ${table}` } });
  };
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (...a: unknown[]) => (settle() as Promise<unknown>).then(...(a as []));
      if (prop === 'catch') return (...a: unknown[]) => (settle() as Promise<unknown>).catch(...(a as []));
      if (prop === 'finally') return (...a: unknown[]) => (settle() as Promise<unknown>).finally(...(a as []));
      return () => chain;
    },
  });
  return chain;
}

vi.mock('next/cache', () => ({ unstable_noStore: () => {} }));

// `react` resolves to the react-server build under Next, which exports `cache()`.
// The bare package on React 18.3 does not, and lib/server/feature-tiers imports
// it at module scope — so supply it rather than stubbing the module out, which
// would skip the very fallback under test.
vi.mock('react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('react');
  return { ...actual, cache: <T extends (...a: never[]) => unknown>(fn: T) => fn };
});

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ from: (t: string) => builder(t) }),
}));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u1', email: 'operator@example.com' },
    active: { familyId: 'f1', family: { id: 'f1', name: 'Test Family' }, role: 'owner' },
    memberships: [{ familyId: 'f1', family: { name: 'Test Family' } }],
  }),
  // The access check the frame must fail CLOSED on.
  isSuperAdmin: async () => { if (mode !== 'ok') throw new Error('auth unreachable'); return true; },
}));

vi.mock('@/lib/server/plan', () => ({
  resolveFamilyPlanLevel: async () => { if (mode !== 'ok') throw new Error('plan unreachable'); return 3; },
}));

// Capture what AppFrame hands down, instead of rendering the real shell.
let captured: Record<string, unknown> | null = null;
let capturedMembers: unknown = null;
vi.mock('@/components/app/app-context', () => ({
  AppProvider: (props: { value: Record<string, unknown>; initialMembers: unknown; children: unknown }) => {
    captured = props.value;
    capturedMembers = props.initialMembers;
    return null;
  },
}));
vi.mock('@/components/app/app-shell', () => ({ AppShell: () => null }));
vi.mock('@/components/pwa/register-sw', () => ({ RegisterSW: () => null }));
vi.mock('@/components/native/native-bootstrap', () => ({ NativeBootstrap: () => null }));
vi.mock('@/components/native/push-registrar', () => ({ PushRegistrar: () => null }));

async function render(): Promise<void> {
  const { AppFrame } = await import('@/components/app/app-frame');
  renderToStaticMarkup(await AppFrame({ children: null }));
}

describe('AppFrame survives its reads failing', () => {
  beforeEach(() => { mode = 'ok'; captured = null; capturedMembers = null; });

  it('passes the real values through when everything succeeds', async () => {
    await render();
    expect(captured).toMatchObject({ planLevel: 3, isSuperAdmin: true, unreadMessages: 3 });
  });

  for (const m of ['resolved-error', 'reject'] as const) {
    it(`renders, and fails in the safe direction, when reads ${m}`, async () => {
      mode = m;
      await expect(render()).resolves.toBeUndefined();

      // Fails CLOSED: an unreachable admin check must never read as affirmative.
      expect(captured!.isSuperAdmin).toBe(false);
      // Fails to the FREE tier: fewer features, never more.
      expect(captured!.planLevel).toBe(0);
      // And the rest degrade to empty rather than undefined.
      expect(captured!.unreadMessages).toBe(0);
      expect(capturedMembers).toEqual([]);
      expect(captured!.featureTiers).toBeTypeOf('object');
    });
  }
});
