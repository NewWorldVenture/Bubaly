import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';
import { bodyOf } from './helpers/source-order';

// /admin/users turned a read that failed into a value the operator saw and
// acted on, while only the banner said the read had failed (reviews
// R7C-USERS-PLAN-FILTER-OVER-UNREAD-PLAN-IS-NO-MATCH,
// R7C-USERS-FAILED-PROFILES-OR-SUPER-ADMINS-READ-IS-A-VALUE and
// R7C-USERS-FAILED-COUNT-READS-ZERO):
//   - a plan, status or search filter over a column whose read failed said
//     "No members match these filters" and exported nothing;
//   - a failed profiles read showed every member with a login as "No account"
//     with no email, and exported them so;
//   - a failed super_admins read showed every DB super-admin's toggle as off,
//     and clicking it granted access again and wrote a 'grant' audit row;
//   - a failed head count read 0 on its tile, and the role donut drew 0 (0.0%).
// The REAL page, over the in-memory database with PostgREST's 1,000-row cap.
const CAP = 1000;

const h = vi.hoisted(() => ({ db: null as unknown, exported: null as Record<string, string>[] | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
// Client controls stand in as markers of exactly what the page hands them.
vi.mock('@/components/admin/users-toolbar', () => ({
  UsersToolbar: ({ exportRows }: { exportRows: Record<string, string>[] }) => {
    h.exported = exportRows;
    return null;
  },
}));
vi.mock('@/components/admin/member-row-actions', () => ({ MemberRowActions: () => null }));
vi.mock('@/components/admin/invite-row-actions', () => ({ InviteRowActions: () => null }));
vi.mock('@/components/admin/set-plan-control', () => ({ SetPlanControl: () => null }));
vi.mock('@/components/admin/super-admin-toggle', () => ({
  SuperAdminToggle: ({ email, isAdmin, locked }: { email: string; isAdmin: boolean; locked: boolean }) =>
    createElement('span', { 'data-toggle-of': email, 'data-is-admin': String(isAdmin), 'data-locked': String(locked) }),
}));
vi.mock('@/components/admin/role-donut', () => ({
  RoleDonut: ({ total }: { total: number }) => createElement('div', { 'data-role-donut-total': total }),
}));

const OWNER = 'fam-owner';
const SECOND = 'fam-second';
const CODE_ADMIN = 'code-admin@example.com';
let db: InMemorySupabase;

/**
 * Two families: the owner family on Family+ with a member who has a login
 * (real@example.com, a DB super-admin), one whose login is a code admin, and
 * two without one; the second family on Free with one member without a login.
 */
function seed() {
  db.seed('families', [
    { id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' },
    { id: SECOND, name: 'Second family', created_at: '2025-01-01T00:00:00Z' },
  ]);
  const member = (id: string, family: string, userId: string | null, role: string, name: string, day: number) => ({
    id, family_id: family, user_id: userId, role, display_name: name, is_active: true,
    created_at: new Date(Date.UTC(2026, 0, day, 12)).toISOString(),
  });
  db.seed('family_members', [
    member('mem-1', OWNER, 'usr-real', 'parent', 'Real parent', 1),
    member('mem-2', OWNER, 'usr-code', 'parent', 'Code parent', 2),
    member('mem-3', OWNER, null, 'child', 'Kid one', 3),
    member('mem-4', OWNER, null, 'child', 'Kid two', 4),
    member('mem-5', SECOND, null, 'parent', 'Second parent', 5),
  ]);
  db.seed('profiles', [
    { id: 'usr-real', full_name: 'Real Person', email: 'real@example.com', created_at: '2026-01-01T00:00:00Z' },
    { id: 'usr-code', full_name: 'Code Person', email: CODE_ADMIN, created_at: '2026-01-02T00:00:00Z' },
  ]);
  db.seed('subscriptions', [{ id: 'sub-owner', family_id: OWNER, plan: 'plus', status: 'active' }]);
  db.seed('super_admins', [{ email: 'real@example.com' }]);
  for (const table of ['invites', 'roles', 'permissions']) db.seed(table, []);
}

async function render(params: Record<string, string> = {}): Promise<string> {
  const { default: AdminUsersPage } = await import('@/app/(app)/admin/users/page');
  return renderServerPage(await AdminUsersPage({ searchParams: Promise.resolve(params) }));
}

/** Fault exactly the reads `failing` picks out of `table`, and count them. */
function fault(table: string, failing: (calls: FaultCall[]) => boolean = () => true) {
  const faulted = { n: 0 };
  h.db = withFaults(db, (name, calls) => {
    if (name !== table || !failing(calls)) return null;
    faulted.n += 1;
    return { message: `${table} unavailable` };
  });
  return faulted;
}

const readError = SOURCE_MESSAGES['users.couldNotLoadUsersAnd'];
const noMatch = SOURCE_MESSAGES['adminUsers.noMembersMatchTheseFilters'];
const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];
/** The listed row of the member named `name`, as words. */
const rowOf = (html: string, name: string) => textOf(bodyOf(html, `<p class="font-medium">${name}</p>`, '</tr>'));
const listed = (html: string) => [...html.matchAll(/<tr><td class="px-3 py-2\.5"><p class="font-medium">([^<]*)<\/p>/g)].map((m) => m[1]);

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  h.exported = null;
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPER_ADMIN_EMAILS', CODE_ADMIN);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/admin/users: a filter over a column whose read FAILED is the read-error state, not "no match"', () => {
  const subscriptionsRead = (calls: FaultCall[]) => calls.some((c) => c.method === 'in' && c.args[0] === 'family_id');
  const profilesRead = (calls: FaultCall[]) => calls.some((c) => c.method === 'in');
  const familyNamesRead = (calls: FaultCall[]) => calls.some((c) => c.method === 'in');

  it.each([
    ['?plan=plus with the subscriptions read failed', 'subscriptions', subscriptionsRead, { plan: 'plus' }],
    ['?plan=free with the subscriptions read failed', 'subscriptions', subscriptionsRead, { plan: 'free' }],
    ['?status=active with the profiles read failed', 'profiles', profilesRead, { status: 'active' }],
    ['?status=no_account with the profiles read failed', 'profiles', profilesRead, { status: 'no_account' }],
    ['a search with the profiles read failed', 'profiles', profilesRead, { q: 'real' }],
    ['a search with the family name read failed', 'families', familyNamesRead, { q: 'owner family' }],
  ] as const)('%s', async (_, table, failing, params) => {
    seed();
    const faulted = fault(table, failing);
    const html = await render(params);
    expect(faulted.n).toBeGreaterThan(0);
    expect(html).toContain(readError);
    expect(html).not.toContain(noMatch);
    expect(listed(html)).toEqual([]);
    expect(textOf(html)).not.toContain('of 0 members');
    expect(h.exported).toEqual([]);
  });

  it('the control: each filter whose read succeeded lists the members it matches, and says when none do', async () => {
    seed();
    expect(listed(await render({ plan: 'plus' }))).toEqual(['Real Person', 'Code Person', 'Kid one', 'Kid two']);
    expect(listed(await render({ plan: 'free' }))).toEqual(['Second parent']);
    expect(listed(await render({ status: 'active' }))).toEqual(['Real Person', 'Code Person']);
    expect(listed(await render({ status: 'no_account' }))).toEqual(['Kid one', 'Kid two', 'Second parent']);
    expect(listed(await render({ q: 'real' }))).toEqual(['Real Person']);
    expect(listed(await render({ q: 'second family' }))).toEqual(['Second parent']);
    const none = await render({ plan: 'family' });
    expect(none).toContain(noMatch);
    expect(none).not.toContain(readError);
  });
});

describe('/admin/users: a profiles read that FAILS is not "No account"', () => {
  it('a member with a login reads Unavailable, offers no toggle and exports no status; a member without one is still "No account"', async () => {
    seed();
    fault('profiles');
    const html = await render();
    expect(html).not.toContain(readError);
    expect(rowOf(html, 'Real parent')).toBe(`Real parent ${unavailable} Owner family Parent / Admin Family+ ${unavailable} ${unavailable} Jan 1, 2026`);
    expect(html).not.toContain('data-toggle-of="real@example.com"');
    expect(rowOf(html, 'Kid one')).toContain(`${SOURCE_MESSAGES['users.noLoginAccount']} Owner family Child Family+ No account —`);
    const real = h.exported?.find((row) => row.name === 'Real parent');
    expect(real).toMatchObject({ email: '', status: '' });
    expect(h.exported?.find((row) => row.name === 'Kid one')).toMatchObject({ email: '', status: 'no_account' });
    expect(textOf(html)).toContain('Could not load “profiles”: profiles unavailable');
  });

  it('the control: a profiles read that succeeds is each member\'s email, status and toggle', async () => {
    seed();
    const html = await render();
    expect(rowOf(html, 'Real Person')).toBe('Real Person real@example.com Owner family Parent / Admin Family+ Active Jan 1, 2026');
    expect(html).toContain('data-toggle-of="real@example.com" data-is-admin="true" data-locked="false"');
    expect(h.exported?.find((row) => row.name === 'Real Person')).toMatchObject({ email: 'real@example.com', status: 'active' });
    expect(html).not.toContain(unavailable);
  });
});

describe('/admin/users: a super_admins read that FAILS is not "not an admin"', () => {
  it('a DB super-admin\'s toggle is not offered (no grant from a state it could not read); a code admin stays locked', async () => {
    seed();
    const faulted = fault('super_admins');
    const html = await render();
    expect(faulted.n).toBe(1);
    expect(html).not.toContain('data-toggle-of="real@example.com"');
    expect(rowOf(html, 'Real Person')).toBe(`Real Person real@example.com Owner family Parent / Admin Family+ Active ${unavailable} Jan 1, 2026`);
    expect(html).toContain(`data-toggle-of="${CODE_ADMIN}" data-is-admin="true" data-locked="true"`);
    expect(textOf(html)).toContain('Could not load “super_admins”: super_admins unavailable');
  });

  it('the control: a super_admins read that succeeds offers the toggle in its real state', async () => {
    seed();
    const on = await render();
    expect(on).toContain('data-toggle-of="real@example.com" data-is-admin="true" data-locked="false"');
    db.replace('super_admins', []);
    const off = await render();
    expect(off).toContain('data-toggle-of="real@example.com" data-is-admin="false" data-locked="false"');
    expect(off).toContain(`data-toggle-of="${CODE_ADMIN}" data-is-admin="true" data-locked="true"`);
  });
});

describe('/admin/users: a head count that FAILS is Unavailable, not 0', () => {
  const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);
  const has = (calls: FaultCall[], method: string, column?: string) => calls.some((c) => c.method === method && (column === undefined || c.args[0] === column));
  const total = (calls: FaultCall[]) => head(calls) && !has(calls, 'not') && !has(calls, 'gte') && !has(calls, 'eq', 'role');
  const withAccount = (calls: FaultCall[]) => head(calls) && has(calls, 'not');
  const newThisMonth = (calls: FaultCall[]) => head(calls) && has(calls, 'gte');
  const parents = (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[0] === 'role' && c.args[1] === 'parent');
  const children = (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[0] === 'role' && c.args[1] === 'child');
  const tiles = ['adminUsers.totalMembers', 'adminUsers.withAccount', 'adminUsers.newThisMonth', 'adminUsers.noAccount', 'adminUsers.parents'] as const;

  it.each([
    ['the total', total, ['adminUsers.totalMembers', 'adminUsers.noAccount'], false],
    ['the with-account count', withAccount, ['adminUsers.withAccount', 'adminUsers.noAccount'], true],
    ['the new-this-month count', newThisMonth, ['adminUsers.newThisMonth'], true],
    ['the parents\' count', parents, ['adminUsers.parents'], false],
    ['another role\'s count', children, [], false],
  ] as const)('%s', async (_, failing, unread, donutDrawn) => {
    seed();
    const faulted = fault('family_members', failing);
    const html = await render();
    expect(faulted.n).toBe(1);
    for (const key of tiles) {
      const value = statCardValue(html, SOURCE_MESSAGES[key]);
      if ((unread as readonly string[]).includes(key)) expect(value, key).toBe(unavailable);
      else expect(value, key).toMatch(/^\d+$/);
    }
    expect(html.includes('data-role-donut-total="5"')).toBe(donutDrawn);
    // The list does not need the counts: every member is still listed.
    expect(listed(html)).toHaveLength(5);
  });

  it('the control: every count read is its figure, and the donut is drawn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-20T12:00:00Z'));
    try {
      seed();
      const html = await render();
      expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.totalMembers'])).toBe('5');
      expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.withAccount'])).toBe('2');
      expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.newThisMonth'])).toBe('5');
      expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.noAccount'])).toBe('3');
      expect(statCardValue(html, SOURCE_MESSAGES['adminUsers.parents'])).toBe('3');
      expect(html).toContain('data-role-donut-total="5"');
      expect(html).not.toContain(unavailable);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/admin/users: a family name read that FAILS is Unavailable, not "no family"', () => {
  it('the All tab\'s and the Invitations tab\'s Family columns', async () => {
    seed();
    db.replace('invites', [{
      id: 'inv-1', family_id: OWNER, email: 'guest@example.com', role: 'adult', status: 'pending',
      created_at: '2026-01-10T00:00:00Z', expires_at: '2026-02-10T00:00:00Z',
    }]);
    fault('families', (calls) => calls.some((c) => c.method === 'in'));
    const all = await render();
    expect(rowOf(all, 'Kid one')).toContain(`Kid one ${SOURCE_MESSAGES['users.noLoginAccount']} ${unavailable} Child`);
    const invitations = await render({ tab: 'invitations' });
    expect(invitations).toContain(`<td class="px-3 py-2.5 font-medium">guest@example.com</td><td class="px-3 py-2.5 text-muted">${unavailable}</td>`);
  });

  // The All tab's Recent invites rail still read "Invited to a family" for the
  // same failure (review R9-UNREAD-COUNT-FAILURE-COPY).
  it('the All tab\'s Recent invites rail says Unavailable, as the Invitations tab does, not "a family"', async () => {
    seed();
    db.replace('invites', [{
      id: 'inv-1', family_id: OWNER, email: 'guest@example.com', role: 'adult', status: 'pending',
      created_at: '2026-01-10T00:00:00Z', expires_at: '2026-02-10T00:00:00Z',
    }]);
    const faulted = fault('families', (calls) => calls.some((c) => c.method === 'in'));
    const all = textOf(await render());
    expect(faulted.n).toBe(1);
    expect(all).toContain(`guest@example.com Invited to ${unavailable} ·`);
    expect(all).not.toContain('Invited to a family');
  });

  it('the control: the rail names the family a read that succeeds returned', async () => {
    seed();
    db.replace('invites', [{
      id: 'inv-1', family_id: OWNER, email: 'guest@example.com', role: 'adult', status: 'pending',
      created_at: '2026-01-10T00:00:00Z', expires_at: '2026-02-10T00:00:00Z',
    }]);
    expect(textOf(await render())).toContain('guest@example.com Invited to Owner family ·');
  });

  it('the control: a family name read that succeeds names each row\'s family', async () => {
    seed();
    const all = await render();
    expect(rowOf(all, 'Kid one')).toContain(`Kid one ${SOURCE_MESSAGES['users.noLoginAccount']} Owner family Child`);
    expect(all).not.toContain(unavailable);
  });
});
