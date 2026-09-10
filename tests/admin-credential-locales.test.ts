import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { LOCALES } from '@/lib/i18n/locales';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ locale: 'en-US', user: vi.fn(), admin: vi.fn(), createClient: vi.fn(), db: null as unknown }));
vi.mock('@supabase/supabase-js', () => ({ createClient: state.createClient }));
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ getUser: state.user, isSuperAdmin: state.admin }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (key: string) => key === 'bubaly-locale' ? { value: state.locale } : undefined }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); }, usePathname: () => '/admin' }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), cache: <T>(fn: T) => fn }));

const { default: SiteAdminLayout } = await import('@/app/(app)/admin/layout');
const { describeConfiguredServiceKey, serviceKeyRemedy } = await import('@/lib/supabase/server');
const SYNTHETIC_SECRET = 'sb_secret_dummy';
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.locale = 'en-US';
  state.user.mockResolvedValue({ id: 'admin-user', email: 'operator@example.test' });
  state.admin.mockResolvedValue(true);
  db = createInMemorySupabase();
  state.db = db;
  state.createClient.mockImplementation(() => state.db);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SYNTHETIC_SECRET);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://projectfixture.supabase.co');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function failReads(message: string) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((table: string) => {
    const query = from(table);
    vi.spyOn(query, 'maybeSingle').mockResolvedValue({ data: null, error: { message } } as never);
    query.then = ((resolve: (reply: unknown) => unknown) => Promise.resolve(resolve({ data: null, count: null, error: { message } }))) as typeof query.then;
    return query;
  }) as typeof db.from);
}

describe('admin credential guidance', () => {
  it.each(LOCALES.map((locale) => locale.code))('uses the request locale %s for the shared diagnosis and read warnings', async (locale) => {
    state.locale = locale;
    failReads('Unregistered API key');
    const result = await SiteAdminLayout({ children: null });
    const messages = getMessages(locale);
    expect(result.props.credentialFault).toContain(messages['adminCredential.secret']);
    expect(result.props.credentialFault).toContain(translate(messages, 'adminCredential.remedyProject', { project: 'projectfixture', url: 'https://supabase.com/dashboard/project/projectfixture/settings/api-keys' }));
    expect(result.props.credentialFault).not.toContain(SYNTHETIC_SECRET);
    expect(result.props.dataWarnings).toEqual(['profileUnavailable', 'invitesUnavailable', 'notificationsUnavailable'].map((key) => messages[`adminCredential.${key}`]));
  });

  it('does not render key guidance for an ordinary table error', async () => {
    failReads('relation does not exist');
    expect((await SiteAdminLayout({ children: null })).props.credentialFault).toBeNull();
  });

  it.each([false, true])('enforces authentication and super-admin checks before service reads (signedIn=%s)', async (signedIn) => {
    state.user.mockResolvedValue(signedIn ? { id: 'ordinary-user' } : null);
    state.admin.mockResolvedValue(false);
    await expect(SiteAdminLayout({ children: null })).rejects.toThrow(signedIn ? 'redirect:/dashboard' : 'redirect:/login');
    expect(state.createClient).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(0);
  });

  it('does not infer a hosted project from a lookalike host or custom endpoint', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://projectfixture.supabase.co.attacker.test');
    expect(serviceKeyRemedy()).toBe(getMessages('en-US')['adminCredential.remedyGeneric']);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    expect(serviceKeyRemedy()).not.toContain('/dashboard/project/');
  });

  it('identifies a value that becomes empty after trimming wrapper quotes', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ' "   " ');
    expect(describeConfiguredServiceKey()).toBe(getMessages('en-US')['adminCredential.empty']);
  });
});
