import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { at, between } from './helpers/source-order';

// ROLE-SCOPE-001, decided by the account holder: a guest stops reading the
// household's most sensitive areas (locations, money and cards, medical and
// insurance, Guardian and the household inbox), a caregiver is unchanged, and
// the copy stops promising what nothing enforced. The held 0509 refuses a
// guest the rows; lib/auth/guest-scope.ts sends a guest away from the pages.

const redirect = vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); });
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const { GUEST_LANDING, GUEST_WITHHELD_PREFIXES, isWithheldFromGuest, refuseGuest } = await import('@/lib/auth/guest-scope');

const MIGRATION = 'supabase/reserved/0509_a_guest_does_not_read_the_households_most_sensitive_areas.sql';
const PROBE = 'docs/audit/reserved/a-guest-does-not-read-the-households-most-sensitive-areas-check.sql';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const read = (p: string) => readFileSync(p, 'utf8');

/** The route a page file serves, without its dynamic segments. */
function routeOf(file: string): string {
  const segs = file.replace(/^app\/\(app\)\//, '').split('/').slice(0, -1).filter((s) => !s.startsWith('['));
  return `/${segs.join('/')}`;
}

describe('a guest does not reach the household\'s most sensitive pages', () => {
  const pages = globSync('app/(app)/**/page.tsx').filter((f) => isWithheldFromGuest(routeOf(f)));

  it('finds the pages it claims to cover', () => {
    expect(pages.length).toBeGreaterThanOrEqual(30);
    for (const prefix of GUEST_WITHHELD_PREFIXES) {
      expect(pages.some((f) => routeOf(f) === prefix || routeOf(f).startsWith(`${prefix}/`)), prefix).toBe(true);
    }
  });

  it.each(globSync('app/(app)/**/page.tsx').filter((f) => isWithheldFromGuest(routeOf(f))))('%s refuses a guest', (file) => {
    const src = read(file);
    const viaFeature = [...src.matchAll(/requireFeature\('([^']+)'\)/g)].some((m) => isWithheldFromGuest(m[1]));
    const direct = new RegExp(`refuseGuest\\((?:ctx|await requireUserContext\\(\\)), '${routeOf(file).replace(/\//g, '\\/')}'\\)`).test(src);
    expect(viaFeature || direct, 'calls requireFeature with a withheld key, or refuseGuest with its own route').toBe(true);
  });

  it('requireFeature asks before anything else is decided', () => {
    const body = between(read('lib/supabase/auth.ts'), 'export async function requireFeature(key: string)', 'resolveFeatureEntitlement(');
    expect(body).toContain('const ctx = await requireUserContext();');
    expect(body).toContain('refuseGuest(ctx, key);');
    expect(at(body, 'refuseGuest(ctx, key);')).toBeLessThan(at(body, 'isSuperAdmin()'));
  });

  it('matches a withheld page and the pages below it, and nothing that only starts the same way', () => {
    expect(isWithheldFromGuest('/wallet')).toBe(true);
    expect(isWithheldFromGuest('/wallet/children')).toBe(true);
    expect(isWithheldFromGuest('/dashboard/health')).toBe(true);
    expect(isWithheldFromGuest('/dashboard/healthy-recipes')).toBe(false);
    expect(isWithheldFromGuest('/wallets')).toBe(false);
    expect(isWithheldFromGuest('/dashboard/calendar')).toBe(false);
    expect(isWithheldFromGuest('/dashboard/emergency')).toBe(false);
    expect(isWithheldFromGuest(GUEST_LANDING)).toBe(false);
  });

  it('sends a guest to their landing page, and nobody else', () => {
    const as = (role: string) => ({ active: { role } }) as Parameters<typeof refuseGuest>[0];
    redirect.mockClear();
    expect(() => refuseGuest(as('guest'), '/dashboard/locator')).toThrow(`NEXT_REDIRECT ${GUEST_LANDING}`);
    for (const role of ['parent', 'adult', 'teen', 'child', 'caregiver']) {
      expect(() => refuseGuest(as(role), '/dashboard/locator'), role).not.toThrow();
    }
    expect(() => refuseGuest(as('guest'), '/dashboard/calendar')).not.toThrow();
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});

describe('the database half is the same 59 tables in the migration and its probe', () => {
  const list = (src: string, anchor: RegExp) => [...(anchor.exec(src)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  it('names 59 tables, the same in both', () => {
    const inMigration = list(read(MIGRATION), /guest_withheld constant text\[\] := array\[([\s\S]*?)\];/);
    const inProbe = list(read(PROBE), /select unnest\(array\[([\s\S]*?)\]\);/);
    expect(inMigration).toHaveLength(59);
    expect(inProbe).toEqual(inMigration);
  });

  it('leaves the shared areas to a guest', () => {
    const sql = read(MIGRATION);
    for (const kept of ["'family_messages'", "'calendar_events'", "'currency_transactions'", "'subscriptions'", "'family_emergency_contacts'", "'gift_links'", "'rides'"]) {
      expect(between(sql, 'guest_withheld constant text[] := array[', '];')).not.toContain(kept);
    }
  });
});

describe('the copy says what each role sees', () => {
  it('describes a guest as viewing the shared areas and a caregiver as seeing the household', () => {
    for (const locale of LOCALES) {
      const m = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      for (const key of ['roleDescription.caregiver', 'roleDescription.guest', 'faq.absolutelyInviteThemAsA', 'faq.thereAreSixRolesParent', 'permissions.theAccessModelBehindYour']) {
        expect(m[key], `${locale} ${key}`).toBeTruthy();
      }
    }
    const en = JSON.parse(read('lib/i18n/messages/en-US.json')) as Record<string, string>;
    expect(en['roleDescription.guest']).toMatch(/^View the shared calendar, lists and plans\. Never sees locations, money, health records/);
    expect(en['faq.absolutelyInviteThemAsA']).not.toMatch(/assigned areas|limited shared events|You control exactly what they can see/);
    expect(en['faq.thereAreSixRolesParent']).not.toMatch(/assigned areas|limited shared events/);
    expect(en['permissions.theAccessModelBehindYour']).not.toMatch(/enforced by database row-level security\.$/);
    expect(en['permissions.theAccessModelBehindYour']).toContain('The guest row is enforced by the database');
  });
});

describe('a guest is not offered the links it would be sent away from', () => {
  it('hides every withheld page from a guest, and from nobody else', async () => {
    const { isNavItemVisibleToRole } = await import('@/lib/constants/navigation');
    const item = (href: string) => ({ href, label: href, icon: (() => null) as never });
    for (const href of ['/dashboard/locator', '/wallet', '/wallet/cards', '/guardian', '/dashboard/medical', '/dashboard/bills']) {
      expect(isNavItemVisibleToRole(item(href), { isManager: false, isGuest: true }), href).toBe(false);
      expect(isNavItemVisibleToRole(item(href), { isManager: false, isGuest: false }), `${href} caregiver`).toBe(true);
      expect(isNavItemVisibleToRole(item(href), { isManager: true }), `${href} parent`).toBe(true);
      expect(isNavItemVisibleToRole(item(href), { isManager: false, isGuest: true, isSuperAdmin: true }), `${href} super admin`).toBe(true);
    }
    expect(isNavItemVisibleToRole(item('/dashboard/calendar'), { isManager: false, isGuest: true })).toBe(true);
  });

  it('every sidebar that asks the role rule tells it about a guest', () => {
    for (const file of ['components/app/free-tier-sidebar.tsx', 'components/settings/navigation-choices.tsx']) {
      const src = read(file);
      const calls = src.match(/isNavItemVisibleToRole\([^)]*\)/g) ?? [];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call, file).toContain("isGuest: role === 'guest'");
    }
    for (const file of ['components/app/free-tier-sidebar.tsx', 'components/app/app-shell.tsx']) {
      const calls = read(file).match(/resolveItems\([^;]*\);/g) ?? [];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call, file).toContain("role === 'guest'");
    }
  });
});

