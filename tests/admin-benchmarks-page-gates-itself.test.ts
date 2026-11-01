// N5 — /admin/benchmarks had no gate of its own.
//
// The super-admin and step-up checks live in app/(app)/admin/layout.tsx, and a
// layout is not a gate for its pages: on an RSC navigation Next renders from
// the first segment that differs from the router state tree the request
// names, so a request claiming to come from another /admin page is rendered
// from the `benchmarks` segment down and the layout never runs. middleware.ts
// asks only that a session exists. Any signed-in member — a teen, a kid login,
// a guest — could read the page's service-role data: every cohort's
// aggregates (also while unpublished), the contributor and opted-in counts and
// the publication flag.
//
// The page is called here the way that request reaches it: on its own, with
// no layout in front.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

const h = vi.hoisted(() => ({
  user: { id: 'u-1', email: 'teen@example.test' } as { id: string; email: string } | null,
  superAdmin: false,
  assurance: { ok: true } as { ok: boolean },
  serviceClientCalls: 0,
}));

function emptyRead() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'range', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
  return chain;
}

vi.mock('@/lib/supabase/auth', () => ({ getUser: async () => h.user, isSuperAdmin: async () => h.superAdmin }));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => h.assurance,
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { h.serviceClientCalls += 1; return { from: () => emptyRead() }; },
  createServer: async () => ({}),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { default: AdminBenchmarksPage } = await import('@/app/(app)/admin/benchmarks/page');

beforeEach(() => {
  h.user = { id: 'u-1', email: 'teen@example.test' };
  h.superAdmin = false;
  h.assurance = { ok: true };
  h.serviceClientCalls = 0;
});

describe('/admin/benchmarks asks for super-admin itself, before any service-role read', () => {
  it('turns a signed-in member who is not a super-admin back to the family dashboard', async () => {
    await expect(AdminBenchmarksPage()).rejects.toThrow('REDIRECT:/dashboard');
    expect(h.serviceClientCalls).toBe(0);
  });

  it('sends a visitor with no session to sign in', async () => {
    h.user = null;
    await expect(AdminBenchmarksPage()).rejects.toThrow('REDIRECT:/login?redirect=/admin');
    expect(h.serviceClientCalls).toBe(0);
  });

  it('sends a super-admin who owes the authenticator code to step-up', async () => {
    h.superAdmin = true;
    h.assurance = { ok: false };
    await expect(AdminBenchmarksPage()).rejects.toThrow('REDIRECT:/auth/step-up?next=%2Fadmin');
    expect(h.serviceClientCalls).toBe(0);
  });

  it('control: a stepped-up super-admin gets the report', async () => {
    h.superAdmin = true;
    const page = await AdminBenchmarksPage();
    expect(page).toBeTruthy();
    expect(h.serviceClientCalls).toBe(1);
  });
});
