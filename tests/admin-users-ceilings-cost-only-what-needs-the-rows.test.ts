import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';

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

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
// The toolbar is a client component that reaches for the router; it stands in
// as a marker of the families its Add-user picker is handed.
vi.mock('@/components/admin/users-toolbar', () => ({
  UsersToolbar: ({ families }: { families: { id: string; name: string }[] }) =>
    createElement('div', {
      'data-picker-count': families.length,
      'data-picker-first': families[0]?.id ?? '',
      'data-picker-last': families.at(-1)?.id ?? '',
      'data-picker-has-owner': String(families.some((f) => f.id === 'fam-zz-000000')),
    }),
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

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
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

    for (const tab of ['invitations', 'roles']) expect(await render({ tab })).not.toContain(readError);
  });

  it('a member read that FAILS is still the read-error state', async () => {
    seedFamilies();
    seedOwner();
    h.db = withFaults(db, (table, calls) => (table === 'family_members' && calls.some((c) => c.method === 'select' && c.args[0] === '*') ? { message: 'family_members unavailable' } : null));
    const html = await render();
    expect(html).toContain(readError);
    expect(html).not.toContain(SOURCE_MESSAGES['adminUsers.totalMembers']);
  });
});
