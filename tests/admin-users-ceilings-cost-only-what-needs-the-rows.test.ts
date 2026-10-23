import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';
import { at, bodyOf } from './helpers/source-order';

// /admin/users read every family, every subscription, every invite and every
// member on every tab, each paged to a 25,000-row ceiling with reaching it an
// error (16211cf8f). The base page read them unbounded and rendered. Past the
// ceiling:
//   - families: the Add-user family picker was empty, every member's Family
//     column read "—", the search by family name found nobody and every invite
//     read "a family" (review R5-SIB-USERS-FAMILIES-LABEL-CEILING);
//   - subscriptions: every member and family read Free;
//   - invites: the All tab's rail said "No invites yet";
//   - members: every tab, Roles and Invitations included, was the read-error state.
// Each tab now reads what it lists, a label is read by the ids a tab names, and
// a ceiling costs only what needs those rows. Driven against the real page over
// a fake that caps a response at 1,000 rows, as PostgREST does.
const CAP = 1000;
const CEILING = 25_000;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown, exported: null as Record<string, string>[] | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
// The toolbar is a client component that reaches for the router; it stands in
// as a marker of the families its Add-user picker is handed, and keeps the rows
// its Export is handed: the CSV holds exactly those (downloadCsv(exportRows)).
vi.mock('@/components/admin/users-toolbar', () => ({
  UsersToolbar: ({ families, exportRows }: { families: { id: string; name: string }[]; exportRows: Record<string, string>[] }) => {
    h.exported = exportRows;
    return createElement('div', {
      'data-picker-count': families.length,
      'data-picker-first': families[0]?.id ?? '',
      'data-picker-last': families.at(-1)?.id ?? '',
      'data-picker-has-owner': String(families.some((f) => f.id === 'fam-zz-000000')),
    });
  },
}));
vi.mock('@/components/admin/member-row-actions', () => ({ MemberRowActions: () => null }));
vi.mock('@/components/admin/invite-row-actions', () => ({ InviteRowActions: () => null }));
vi.mock('@/components/admin/set-plan-control', () => ({
  SetPlanControl: ({ familyName, currentPlan }: { familyName: string; currentPlan: string }) =>
    createElement('span', { 'data-plan-of': familyName }, currentPlan),
}));
vi.mock('@/components/admin/super-admin-toggle', () => ({ SuperAdminToggle: () => null }));
vi.mock('@/components/admin/role-donut', () => ({
  RoleDonut: ({ total }: { total: number }) => createElement('div', { 'data-role-donut-total': total }),
}));

/** The family that owns every member and invite; it sorts after the 25,001 empty ones. */
const OWNER = 'fam-zz-000000';
const MEMBERS = 12;

let db: InMemorySupabase;

function seedOwner() {
  db.seed('family_members', Array.from({ length: MEMBERS }, (_, i) => ({
    id: `mem-${pad(i)}`, family_id: OWNER, user_id: null, role: 'parent', display_name: `Member ${i}`,
    is_active: true, created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
  })));
  db.seed('subscriptions', [{ id: 'sub-owner', family_id: OWNER, plan: 'plus', status: 'active' }]);
  db.seed('invites', [{
    id: 'inv-owner', family_id: OWNER, email: 'guest@example.com', role: 'adult', status: 'pending',
    created_at: '2026-10-20T00:00:00Z', expires_at: '2026-11-20T00:00:00Z',
  }]);
  for (const table of ['profiles', 'roles', 'permissions', 'super_admins']) db.seed(table, []);
}

/** 25,001 families without a member, sorting first by id, and the owner family after them. */
function seedPastTheFamilyCeiling() {
  db.seed('families', [
    ...Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Empty family ${i}`, created_at: '2025-01-01T00:00:00Z' })),
    { id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' },
  ]);
  seedOwner();
}

async function render(params: { tab?: string; q?: string } = {}): Promise<string> {
  const { default: AdminUsersPage } = await import('@/app/(app)/admin/users/page');
  return renderServerPage(await AdminUsersPage({ searchParams: Promise.resolve(params) }));
}

const picker = (html: string) => {
  const match = /data-picker-count="(\d+)" data-picker-first="([^"]*)" data-picker-last="([^"]*)" data-picker-has-owner="(true|false)"/.exec(html);
  if (!match) throw new Error('the users toolbar is not on the page');
  return { count: Number(match[1]), first: match[2], last: match[3], hasOwner: match[4] === 'true' };
};
const bannerTitled = (html: string, title: string): string[] | null => {
  const at = html.indexOf(`<p class="text-sm font-semibold text-danger">${title}</p>`);
  if (at < 0) return null;
  return [...html.slice(at, html.indexOf('</ul>', at)).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
};
const offeredTitle = () => translate(SOURCE_MESSAGES, 'adminCeiling.offeredInPart', { n: CEILING.toLocaleString() });
const notShownTitle = () => translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: CEILING.toLocaleString() });
const familyCell = (name: string) => `<td class="px-3 py-2.5 text-muted">${name}</td>`;
const readError = SOURCE_MESSAGES['users.couldNotLoadUsersAnd'];
/** The words of the Families tab's heading, its count included when it shows one. */
const familiesHeading = (html: string): string | null => {
  const match = new RegExp(`<h2 class="mb-4 text-base font-semibold">${SOURCE_MESSAGES['adminUsers.allFamilies']}[^]*?</h2>`).exec(html);
  return match ? textOf(match[0]) : null;
};
/** Page one of the All tab's list, oldest first, as its Export writes it. */
const exportedFirstPage = Array.from({ length: 10 }, (_, i) => ({
  name: `Member ${i}`, email: '', family: 'Owner family', role: 'parent', plan: 'plus', status: 'no_account',
  joined: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
}));

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  h.exported = null;
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/admin/users past 25,000 families', () => {
  it('every member names its family, and the Add-user picker offers the first 25,000 and says so', async () => {
    seedPastTheFamilyCeiling();
    const html = await render();
    expect(html).not.toContain(readError);
    expect(html.split(familyCell('Owner family'))).toHaveLength(Math.min(MEMBERS, 10) + 1);
    expect(picker(html)).toEqual({ count: CEILING, first: 'fam-000000', last: `fam-${pad(CEILING - 1)}`, hasOwner: false });
    expect(bannerTitled(html, offeredTitle())).toEqual([SOURCE_MESSAGES['adminUsers.addUserFamilyPicker']]);
    // Only a cut-short list says so; nothing failed.
    expect(html).not.toContain(SOURCE_MESSAGES['adminUsers.someDataCouldntBeLoadedFrom']);
    // The newest invite is named after its family in the rail, and every member is listed and paged.
    expect(textOf(html)).toContain('Invited to Owner family');
    expect(textOf(html)).toContain(`of ${MEMBERS} members`);
  });

  it('the search by family name finds the members of a family past the 25,000th', async () => {
    seedPastTheFamilyCeiling();
    const html = await render({ q: 'owner family' });
    expect(textOf(html)).toContain(`of ${MEMBERS} members`);
    expect(html).toContain('<p class="font-medium">Member 0</p>');
  });

  it('the Invitations tab names each invite\'s family', async () => {
    seedPastTheFamilyCeiling();
    const html = await render({ tab: 'invitations' });
    expect(html).not.toContain(readError);
    expect(html).toContain(familyCell('Owner family'));
    expect(html).toContain('guest@example.com');
  });

  it('the Families tab, which lists every family, is its own error state; the picker and the other tabs stay', async () => {
    seedPastTheFamilyCeiling();
    const html = await render({ tab: 'families' });
    expect(html).toContain(readError);
    expect(html).not.toContain('Empty family 0<');
    expect(picker(html).count).toBe(CEILING);
    expect(textOf(html)).toContain(`there are more than ${CEILING.toLocaleString()}, and the Families tab lists none rather than part of them`);
  });

  it('a families read that FAILS is the Families tab\'s read-error state too, not "No families yet" (review R6-USERS-FAMILIES-TAB-FAILED-READ-IS-EMPTY-STATE)', async () => {
    db.seed('families', [{ id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' }]);
    seedOwner();
    // The listed read fails; the names read by the listed rows' ids does not.
    h.db = withFaults(db, (table, calls) => (table === 'families' && !calls.some((c) => c.method === 'in') ? { message: 'families unavailable' } : null));
    const html = await render({ tab: 'families' });
    expect(html).toContain(readError);
    expect(html).not.toContain(SOURCE_MESSAGES['adminUsers.noFamiliesYet']);
    // No count of none beside it, as on the Invitations tab.
    expect(familiesHeading(html)).toBe(SOURCE_MESSAGES['adminUsers.allFamilies']);
    expect(textOf(html)).toContain('Could not load “families”: families unavailable');
  });

  it('the control: a families read that succeeds lists the families and counts them', async () => {
    db.seed('families', [{ id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' }]);
    seedOwner();
    const html = await render({ tab: 'families' });
    expect(html).not.toContain(readError);
    expect(familiesHeading(html)).toBe(`${SOURCE_MESSAGES['adminUsers.allFamilies']} (1)`);
    expect(html).toContain('<td class="px-3 py-2.5 font-medium">Owner family</td>');
  });

  it('a family name read that FAILS is still named in the banner, not passed off as "—"', async () => {
    seedPastTheFamilyCeiling();
    h.db = withFaults(db, (table, calls) => (table === 'families' && calls.some((c) => c.method === 'in') ? { message: 'families unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['adminUsers.someDataCouldntBeLoadedFrom']);
    expect(textOf(html)).toContain('Could not load “families (names)”: families unavailable');
  });

  it('the control: under the ceiling the picker offers every family and says nothing is missing', async () => {
    db.seed('families', [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Empty family ${i}`, created_at: '2025-01-01T00:00:00Z' })),
      { id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' },
    ]);
    seedOwner();
    const html = await render();
    expect(picker(html)).toEqual({ count: 4, first: 'fam-000000', last: OWNER, hasOwner: true });
    expect(bannerTitled(html, offeredTitle())).toBeNull();
    expect(html).toContain(familyCell('Owner family'));
  });
});

describe('/admin/users past 25,000 subscriptions, invites and members', () => {
  function seedFamilies() {
    db.seed('families', [{ id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' }]);
  }

  it('a member and a family past 25,000 subscriptions still read their own plan', async () => {
    seedFamilies();
    seedOwner();
    // 25,001 subscriptions of other families, sorting after the owner's by id.
    db.seed('subscriptions', Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `sub-x-${pad(i)}`, family_id: `fam-x-${pad(i)}`, plan: 'basic', status: 'active' })));
    const all = await render({ q: 'member 0' });
    expect(all).toContain('<td class="px-3 py-2.5 text-muted">Family+</td>');
    expect(all).not.toContain(SOURCE_MESSAGES['adminUsers.someDataCouldntBeLoadedFrom']);
    const families = await render({ tab: 'families' });
    expect(families).toContain('<span data-plan-of="Owner family">plus</span>');
  });

  it('past 25,000 invites the All tab\'s rail shows the five newest, and the Invitations tab is its own error state', async () => {
    seedFamilies();
    seedOwner();
    db.seed('invites', Array.from({ length: CEILING + 1 }, (_, i) => ({
      id: `inv-${pad(i)}`, family_id: OWNER, email: `old-${pad(i)}@example.com`, role: 'adult', status: 'expired',
      created_at: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString(), expires_at: '2025-12-31T00:00:00Z',
    })));
    const all = await render();
    expect(all).not.toContain(readError);
    expect(all).not.toContain(SOURCE_MESSAGES['adminUsers.noInvitesYet']);
    // The owner's pending invite of 20 October is the newest; then the four newest old ones.
    for (const email of ['guest@example.com', `old-${pad(CEILING)}@example.com`, `old-${pad(CEILING - 3)}@example.com`]) expect(all).toContain(email);
    expect(all).not.toContain(`old-${pad(CEILING - 4)}@example.com`);
    const invitations = await render({ tab: 'invitations' });
    expect(invitations).toContain(readError);
    expect(invitations).not.toContain(SOURCE_MESSAGES['adminUsers.noInvitationsSentYet']);
  });

  it('past 25,000 members the tiles, the rail and the other tabs stay; the list is its own error state and the per-family counts say they are not shown', async () => {
    seedFamilies();
    seedOwner();
    db.seed('family_members', Array.from({ length: CEILING + 1 - MEMBERS }, (_, i) => ({
      id: `mem-x-${pad(i)}`, family_id: OWNER, user_id: null, role: 'child', display_name: `Child ${i}`, is_active: true, created_at: '2025-06-01T00:00:00Z',
    })));
    const all = await render();
    expect(statCardValue(all, SOURCE_MESSAGES['adminUsers.totalMembers'])).toBe((CEILING + 1).toLocaleString());
    expect(statCardValue(all, SOURCE_MESSAGES['adminUsers.parents'])).toBe(String(MEMBERS));
    expect(all).toContain(`data-role-donut-total="${CEILING + 1}"`);
    expect(all).toContain(readError);
    expect(all).not.toContain('<p class="font-medium">Member 0</p>');
    expect(textOf(all)).toContain('Invited to Owner family');

    const families = await render({ tab: 'families' });
    expect(families).toContain(`<td class="px-3 py-2.5 font-medium">Owner family</td><td class="px-3 py-2.5 text-muted">${SOURCE_MESSAGES['strategyMetrics.unavailable']}</td>`);
    expect(bannerTitled(families, notShownTitle())).toEqual([SOURCE_MESSAGES['adminUsers.members']]);

    for (const tab of ['invitations', 'roles']) {
      const html = await render({ tab });
      expect(html).not.toContain(readError);
      // Their Export has no member rows past the ceiling, and the banner names the read that is why.
      expect(h.exported).toEqual([]);
      expect(textOf(html)).toContain('Could not load “family_members”: readAllById reached the caller’s max of 25000 rows');
    }
  });

  // Both tabs that list members, not the All tab alone: the Families tab's
  // member counts are read from the same rows, and a failed read counted every
  // family's members as 0 (review R7A-USERS-FAMILIES-MEMBER-FAIL-GATE-UNPINNED).
  it.each(['all', 'families'])('a member read that FAILS is still the read-error state on the %s tab', async (tab) => {
    seedFamilies();
    seedOwner();
    h.db = withFaults(db, (table, calls) => (table === 'family_members' && calls.some((c) => c.method === 'select' && c.args[0] === '*') ? { message: 'family_members unavailable' } : null));
    const html = await render({ tab });
    expect(html).toContain(readError);
    expect(html).toContain(SOURCE_MESSAGES['users.refreshUsers']);
    expect(html).not.toContain(SOURCE_MESSAGES['adminUsers.totalMembers']);
    expect(familiesHeading(html)).toBeNull();
    expect(html).not.toContain('<td class="px-3 py-2.5 font-medium">Owner family</td>');
  });
});

// Round 6 read the members only on the All and Families tabs, while the
// toolbar, whose Export writes the first page of them, is on every tab: on the
// Invitations and Roles tabs the CSV was its header row alone, and nothing said
// so (review R6-USERS-EXPORT-EMPTY-OFF-MEMBER-TABS). Each tab's Export holds the
// same first page again, with each member's family and plan.
describe('/admin/users: Export holds the members\' first page on every tab', () => {
  function seedFamilies() {
    db.seed('families', [{ id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' }]);
  }

  it.each(['all', 'families', 'invitations', 'roles'])('the %s tab', async (tab) => {
    seedFamilies();
    seedOwner();
    const html = await render({ tab });
    expect(h.exported).toEqual(exportedFirstPage);
    expect(html).not.toContain(SOURCE_MESSAGES['adminUsers.someDataCouldntBeLoadedFrom']);
  });

  it('past 25,000 families the Families tab\'s Export still reads each member\'s family and plan', async () => {
    seedPastTheFamilyCeiling();
    await render({ tab: 'families' });
    expect(h.exported).toEqual(exportedFirstPage);
  });

  it('a member read that FAILS costs the Invitations and Roles tabs their Export alone, and the banner names it', async () => {
    seedFamilies();
    seedOwner();
    h.db = withFaults(db, (table, calls) => (table === 'family_members' && calls.some((c) => c.method === 'select' && c.args[0] === '*') ? { message: 'family_members unavailable' } : null));
    for (const tab of ['invitations', 'roles']) {
      const html = await render({ tab });
      expect(html).not.toContain(readError);
      expect(h.exported).toEqual([]);
      expect(textOf(html)).toContain('Could not load “family_members”: family_members unavailable');
    }
    expect(await render({ tab: 'invitations' })).toContain('guest@example.com');
  });
});

// The Invitations and Families tabs became their own read-error state when
// their read failed (R6-USERS-FAMILIES-TAB-FAILED-READ-IS-EMPTY-STATE); the
// All tab's Recent invites rail and the Roles tab still said "No invites yet"
// and "Permission matrix not seeded", with its instruction to run the seed,
// while the banner named the failed read (review R7A-USERS-SIBLING-FAILED-READ-EMPTY-STATES).
describe('/admin/users: a list whose read FAILS is the read-error state, not its empty state', () => {
  function seedFamilies() {
    db.seed('families', [{ id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' }]);
  }
  function seedRoles() {
    db.seed('roles', [
      { role: 'parent', label: 'Parent / Guardian', description: 'Runs the household' },
      { role: 'child', label: 'Child', description: 'Helps with chores' },
    ]);
    db.seed('permissions', [
      { id: 'perm-1', role: 'parent', resource: 'chores', can_create: true, can_read: true, can_update: true, can_delete: true },
      { id: 'perm-2', role: 'child', resource: 'chores', can_create: false, can_read: true, can_update: false, can_delete: false },
    ]);
  }
  /** The All tab's Recent invites card: the last thing on that tab. */
  const railOf = (html: string) => html.slice(at(html, `>${SOURCE_MESSAGES['adminUsers.recentInvites']}</h2>`));
  /** The Roles tab's card, from its heading on. */
  const rolesTabOf = (html: string) => textOf(html.slice(at(html, `>${SOURCE_MESSAGES['adminUsers.roleDefinitions']}</h2>`)));

  it('the All tab\'s Recent invites rail, when its read FAILS', async () => {
    seedFamilies();
    seedOwner();
    h.db = withFaults(db, (table) => (table === 'invites' ? { message: 'invites unavailable' } : null));
    const html = await render();
    expect(railOf(html)).toContain(readError);
    expect(railOf(html)).not.toContain(SOURCE_MESSAGES['adminUsers.noInvitesYet']);
    // The rail alone: the members are still listed, and the banner names the read.
    expect(html).toContain('<p class="font-medium">Member 0</p>');
    expect(textOf(html)).toContain('Could not load “invites (recent)”: invites unavailable');
  });

  it('the control: a Recent invites read that succeeds lists the newest invites, or says there are none', async () => {
    seedFamilies();
    seedOwner();
    const listed = railOf(await render());
    expect(listed).toContain('guest@example.com');
    expect(listed).not.toContain(readError);
    db.replace('invites', []);
    const none = railOf(await render());
    expect(none).toContain(SOURCE_MESSAGES['adminUsers.noInvitesYet']);
    expect(none).not.toContain(readError);
  });

  it.each(['roles', 'permissions'])('the Roles tab, when its %s read FAILS', async (failing) => {
    seedFamilies();
    seedOwner();
    seedRoles();
    h.db = withFaults(db, (table) => (table === failing ? { message: `${failing} unavailable` } : null));
    const html = await render({ tab: 'roles' });
    const rolesTab = rolesTabOf(html);
    expect(rolesTab).toContain(readError);
    expect(rolesTab).not.toContain(SOURCE_MESSAGES['adminUsers.permissionMatrixNotSeeded']);
    expect(rolesTab).not.toContain(SOURCE_MESSAGES['users.runSupabaseSeedSqlAgainst']);
    // Neither half of the grid and the matrix: one is read against the other.
    expect(rolesTab).not.toContain('Runs the household');
    expect(rolesTab).not.toContain('chores');
    expect(textOf(html)).toContain(`Could not load “${failing}”: ${failing} unavailable`);
  });

  it('the control: roles and permissions read are the grid and the matrix, and none seeded still says so', async () => {
    seedFamilies();
    seedOwner();
    seedRoles();
    const seeded = rolesTabOf(await render({ tab: 'roles' }));
    expect(seeded).not.toContain(readError);
    expect(seeded).toContain('Runs the household');
    expect(seeded).toContain('chores CRUD R');
    db.replace('roles', []);
    db.replace('permissions', []);
    const unseeded = rolesTabOf(await render({ tab: 'roles' }));
    expect(unseeded).not.toContain(readError);
    expect(unseeded).toContain(SOURCE_MESSAGES['adminUsers.permissionMatrixNotSeeded']);
  });
});

// A failed subscriptions read was every member's and every family's plan read
// as Free: the All tab's Plan column, the Families tab's SetPlanControl (its
// current plan, which an operator then changes from) and the Export, while the
// banner named the failed read (review R7A-USERS-FAILED-SUBSCRIPTIONS-READ-READS-FREE).
describe('/admin/users: a subscriptions read that FAILS reads no plan, not Free', () => {
  const SECOND = 'fam-zz-000001';
  function seedFamilies() {
    db.seed('families', [
      { id: OWNER, name: 'Owner family', created_at: '2025-01-01T00:00:00Z' },
      { id: SECOND, name: 'Second family', created_at: '2025-01-01T00:00:00Z' },
    ]);
    // A family without a subscription: Free when the read succeeds.
    db.seed('family_members', [{
      id: 'mem-zz-000000', family_id: SECOND, user_id: null, role: 'parent', display_name: 'Second parent',
      is_active: true, created_at: '2026-02-01T00:00:00Z',
    }]);
  }
  const planCell = (plan: string) => `<td class="px-3 py-2.5 text-muted">${plan}</td>`;
  const familyRow = (html: string, name: string) => textOf(bodyOf(html, `<td class="px-3 py-2.5 font-medium">${name}</td>`, '</tr>'));
  const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];
  const failSubscriptions = () => {
    h.db = withFaults(db, (table) => (table === 'subscriptions' ? { message: 'subscriptions unavailable' } : null));
  };

  it('the All tab\'s Plan column and the Export', async () => {
    seedFamilies();
    seedOwner();
    failSubscriptions();
    const html = await render();
    expect(html.split(planCell(unavailable))).toHaveLength(10 + 1);
    for (const plan of ['Bubaly Free', 'Family+']) expect(html).not.toContain(planCell(plan));
    expect(h.exported?.map((row) => row.plan)).toEqual(Array(10).fill(''));
    expect(textOf(html)).toContain('Could not load “subscriptions”: subscriptions unavailable');
  });

  it('the Families tab offers no plan control to change from a plan it could not read', async () => {
    seedFamilies();
    seedOwner();
    failSubscriptions();
    const html = await render({ tab: 'families' });
    expect(html).not.toContain('data-plan-of=');
    expect(familyRow(html, 'Owner family')).toContain(`Owner family ${MEMBERS} ${unavailable} ${unavailable}`);
    expect(familyRow(html, 'Second family')).toContain(`Second family 1 ${unavailable} ${unavailable}`);
    expect(h.exported?.every((row) => row.plan === '')).toBe(true);
  });

  it('the control: a subscriptions read that succeeds is each family\'s plan, and Free where it has none', async () => {
    seedFamilies();
    seedOwner();
    const all = await render();
    expect(all).toContain(planCell('Family+'));
    expect(all).not.toContain(planCell(unavailable));
    expect(h.exported?.[0]?.plan).toBe('plus');
    const families = await render({ tab: 'families' });
    expect(families).toContain('<span data-plan-of="Owner family">plus</span>');
    expect(families).toContain('<span data-plan-of="Second family">free</span>');
    expect(familyRow(families, 'Owner family')).toContain('active');
    expect(families).not.toContain(unavailable);
  });
});
