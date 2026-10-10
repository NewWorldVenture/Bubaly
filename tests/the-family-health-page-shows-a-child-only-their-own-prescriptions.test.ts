// The Family Health page shows a child, teen, caregiver or guest only their
// OWN prescriptions.
//
// THE DEFECT. `app/(app)/dashboard/family-health/page.tsx` read every active
// `medications` row in the family, for any role, and listed each one's name,
// dosage and member. The page has no role gate (only the plan's), and its own
// comment says health data is "surfaced only to managers in summary form here".
//
// The product rule is F-G09: a non-manager sees the medicines prescribed to
// THEM. Migration 0465 would make the database say so, but it is a branch
// candidate, not on main — until an operator applies it, a child's read of
// `medications` returns every member's rows. So the rule lives in app code:
// `components/modules/medications-module.tsx` asks only for the reader's own
// rows, and so does the AI health coach
// (tests/the-health-coach-tells-a-child-only-their-own-health.test.ts). This
// page was the one that did not, so a babysitter opening "Health Coordinator"
// read "SiblingSertraline 50mg · Sibling" and "ParentStatin 10mg · Parent".
//
// WHAT IS ASSERTED, on the page as rendered: the fake database returns every
// family row to any member, as it does before 0465. A child sees their own
// prescription and no one else's, and the Active Meds tile counts theirs; a
// caregiver or guest, who is prescribed nothing here, sees none; a member with
// no member row matches nothing rather than everything. A parent or adult
// still sees the whole family's.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam';
const KID = 'member-kid';
const SIBLING = 'member-sibling';
const PARENT = 'member-parent';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'child',
  member: 'member-kid' as string | null,
}));

vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => ({
    user: { id: 'user-viewer' },
    memberships: [],
    active: {
      familyId: 'fam', role: harness.role,
      member: harness.member ? { id: harness.member, family_id: 'fam' } : null,
      family: { id: 'fam', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtDateTime: (value: string) => value }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/family-health', useRouter: () => ({ refresh: () => {} }) }));

const FamilyHealthPage = (await import('@/app/(app)/dashboard/family-health/page')).default;
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');
const { localeOrDefault } = await import('@/lib/i18n/locales');

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase();
  harness.db = db;
  harness.role = 'child';
  harness.member = KID;
  db.seed('family_members', [
    { id: KID, family_id: FAMILY, display_name: 'Kid', is_active: true },
    { id: SIBLING, family_id: FAMILY, display_name: 'Sibling', is_active: true },
    { id: PARENT, family_id: FAMILY, display_name: 'Parent', is_active: true },
  ]);
  // Every row comes back to every member: the database before 0465.
  db.seed('medications', [
    { id: 'med-kid', family_id: FAMILY, member_id: KID, is_active: true, name: 'KidVitamin', dosage: '1 tab' },
    { id: 'med-sibling', family_id: FAMILY, member_id: SIBLING, is_active: true, name: 'SiblingSertraline', dosage: '50mg' },
    { id: 'med-parent', family_id: FAMILY, member_id: PARENT, is_active: true, name: 'ParentStatin', dosage: '10mg' },
    { id: 'med-unassigned', family_id: FAMILY, member_id: null, is_active: true, name: 'WholeFamilyUnassigned', dosage: '5ml' },
    { id: 'med-elsewhere', family_id: 'fam-2', member_id: 'member-x', is_active: true, name: 'OtherFamilyDrug', dosage: '1mg' },
  ]);
});

/** The page as text, the way a phone paints it. */
async function openTheHealthPage(): Promise<string> {
  const tree = await FamilyHealthPage();
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    tree as React.ReactElement,
  )).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

/** The number on the Active Meds tile (the tile prints its value, then its label). */
function activeMedsTile(text: string): string | undefined {
  return text.match(/(\d+) dashboardFamilyHealth\.activeMeds /)?.[1];
}

const EVERYONE_ELSES = ['SiblingSertraline', 'ParentStatin', 'WholeFamilyUnassigned'];

describe('a non-manager on the Family Health page', () => {
  it.each(['child', 'teen'])('a %s sees their own prescription and no one else\'s', async (role) => {
    harness.role = role;
    const page = await openTheHealthPage();
    expect(page).toContain('KidVitamin');
    for (const name of EVERYONE_ELSES) expect(page, name).not.toContain(name);
    expect(page).not.toContain('OtherFamilyDrug');
    expect(activeMedsTile(page)).toBe('1');
  });

  it.each(['caregiver', 'guest'])('a %s, prescribed nothing here, sees no one\'s', async (role) => {
    harness.role = role;
    harness.member = `member-${role}`;
    const page = await openTheHealthPage();
    for (const name of ['KidVitamin', ...EVERYONE_ELSES]) expect(page, name).not.toContain(name);
    expect(activeMedsTile(page)).toBe('0');
    expect(page).toContain('familyHealth.noActiveMedications');
  });

  it('a member with no member row matches nothing, never everything', async () => {
    harness.member = null;
    const page = await openTheHealthPage();
    for (const name of ['KidVitamin', ...EVERYONE_ELSES]) expect(page, name).not.toContain(name);
    expect(activeMedsTile(page)).toBe('0');
  });
});

describe('a manager on the Family Health page', () => {
  it.each(['parent', 'adult'])('a %s still sees the whole family\'s prescriptions', async (role) => {
    harness.role = role;
    harness.member = PARENT;
    const page = await openTheHealthPage();
    for (const name of ['KidVitamin', ...EVERYONE_ELSES]) expect(page, name).toContain(name);
    expect(page).not.toContain('OtherFamilyDrug');
    expect(activeMedsTile(page)).toBe('4');
  });
});
