import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';

// /admin/users built its five tiles, its role donut and its member list from
// five unbounded `select('*')` reads. PostgREST answers each with at most
// `db-max-rows` (1,000) and no error, so past a thousand members the tiles
// froze, members beyond the cap never reached the paginated list, and a member
// whose profile was not among the thousand NEWEST profiles was labelled "No
// account" and counted as one — the page's own comment said the stats were
// "computed over the full dataset". admin/reports fixed exactly this for the
// same tables; this sibling had not been.
//
// Driven against the real page over a fake that caps a response at 1,000 the
// way the server does, with 1,300 members who all have a login.
const CAP = 1000;
const MEMBERS = 1300;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
// Row controls reach for the app router and the toast provider, neither of
// which exists in a static render, and carry no number this test reads.
vi.mock('@/components/admin/users-toolbar', () => ({ UsersToolbar: () => null }));
vi.mock('@/components/admin/member-row-actions', () => ({ MemberRowActions: () => null }));
vi.mock('@/components/admin/invite-row-actions', () => ({ InviteRowActions: () => null }));
vi.mock('@/components/admin/set-plan-control', () => ({ SetPlanControl: () => null }));
vi.mock('@/components/admin/super-admin-toggle', () => ({ SuperAdminToggle: () => null }));
// The donut is an async server component; it is stood in for by a marker that
// prints exactly the counts the page hands it, so they can be read back.
vi.mock('@/components/admin/role-donut', () => ({
  RoleDonut: ({ counts, total }: { counts: Map<string, number>; total: number }) =>
    createElement('div', { 'data-role-donut': `${[...counts].map(([r, c]) => `${r}=${c}`).join(' ')} total=${total}` }),
}));

let db: InMemorySupabase;

/** 1,300 active members in five families, every one linked to a profile. */
function seedPlatform() {
  // Members are read oldest first; profiles newest first. The 300 OLDEST
  // members therefore have profiles OUTSIDE the newest-1,000 prefix, which is
  // the mislabel path: real logins shown as "No account".
  const createdAt = (i: number) => (i >= 1100
    ? new Date(Date.UTC(2026, 9, 5) + i * 60_000).toISOString()      // this month (October 2026)
    : new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString());    // last year
  db.seed('families', Array.from({ length: 5 }, (_, f) => ({
    id: `fam-${pad(f)}`, name: `Family ${f}`, timezone: 'UTC', created_at: '2025-01-01T00:00:00Z',
  })));
  db.seed('subscriptions', Array.from({ length: 5 }, (_, f) => ({
    id: `sub-${pad(f)}`, family_id: `fam-${pad(f)}`, plan: 'plus', status: 'active',
  })));
  db.seed('family_members', Array.from({ length: MEMBERS }, (_, i) => ({
    id: `mem-${pad(i)}`, family_id: `fam-${pad(i % 5)}`, user_id: `usr-${pad(i)}`,
    role: i < 600 ? 'child' : 'parent', display_name: `Member ${i}`, is_active: true,
    created_at: createdAt(i), updated_at: createdAt(i),
  })));
  db.seed('profiles', Array.from({ length: MEMBERS }, (_, i) => ({
    id: `usr-${pad(i)}`, full_name: `User ${i}`, email: `user-${pad(i)}@example.com`, created_at: createdAt(i),
  })));
  db.seed('invites', []);
  db.seed('roles', []);
  db.seed('permissions', []);
  db.seed('super_admins', []);
}

async function render(tab?: string): Promise<string> {
  const { default: AdminUsersPage } = await import('@/app/(app)/admin/users/page');
  return renderServerPage(await AdminUsersPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/admin/users counts every member, not the first thousand', () => {
  it('the control: the fake caps an unbounded read at 1,000 and says nothing', async () => {
    seedPlatform();
    const { data, error } = await db.from('family_members').select('*').eq('is_active', true);
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('the tiles are platform totals past the row cap', async () => {
    seedPlatform();
    const html = await render();
    expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.totalMembers'])).toBe('1,300');
    expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.withAccount'])).toBe('1,300');
    expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.noAccount'])).toBe('0');
    // The 200 newest members joined this month, and all 200 sit past the cap.
    expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.newThisMonth'])).toBe('200');
    // 700 parents, 400 of them inside the first thousand.
    expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.parents'])).toBe('700');
    // Nothing failed, so the degraded banner is not what makes these right.
    expect(html).not.toContain(SOURCE_MESSAGES['adminUsers.someDataCouldntBeLoadedFrom']);
  });

  it('the role donut is fed every member', async () => {
    seedPlatform();
    const html = await render();
    expect(html).toContain('data-role-donut="parent=700 child=600 total=1300"');
  });

  it('a member whose profile is not among the newest thousand profiles is not "No account"', async () => {
    seedPlatform();
    const html = await render();
    // Page one is the ten OLDEST members; their profiles are the oldest too, and
    // were cut from a newest-first read of profiles.
    for (let i = 0; i < 10; i += 1) expect(html).toContain(`user-${pad(i)}@example.com`);
    expect(html).not.toContain(SOURCE_MESSAGES['users.noLoginAccount']);
  });

  it('the member list paginates over every member', async () => {
    seedPlatform();
    const html = await render();
    expect(html).toContain(`of ${MEMBERS} members`);
  });
});
