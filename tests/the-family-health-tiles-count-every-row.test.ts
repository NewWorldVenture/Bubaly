// The Family Health tiles are totals, and a cut list says it is cut (N12).
//
// The page read 8 appointments, 12 active medications and 8 providers and
// printed those lengths as the "Appts (30d)", "Active meds" and "Providers"
// totals; the medication list showed whichever 12 rows came back, with no
// "+N more". A family of five with fifteen active medications read 12, and
// three medicines were absent from the caregiver summary — on a page whose own
// comment calls this data safety-critical.
//
// Driven through the real page against an in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam';
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', member: 'member-parent' as string | null }));

vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => ({
    user: { id: 'user-viewer' },
    memberships: [],
    active: { familyId: 'fam', role: harness.role, member: harness.member ? { id: harness.member, family_id: 'fam' } : null, family: { id: 'fam', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtDateTime: (value: string) => value }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/family-health', useRouter: () => ({ refresh: () => {} }) }));

const FamilyHealthPage = (await import('@/app/(app)/dashboard/family-health/page')).default;
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');
const { localeOrDefault } = await import('@/lib/i18n/locales');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

let db: InMemorySupabase;
const pad = (n: number) => String(n).padStart(2, '0');

beforeEach(() => {
  db = createInMemorySupabase();
  harness.db = db; harness.role = 'parent'; harness.member = 'member-parent';
  db.seed('family_members', [{ id: 'member-parent', family_id: FAMILY, display_name: 'Parent', is_active: true }]);
});

async function page(): Promise<string> {
  const tree = await FamilyHealthPage();
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    tree as React.ReactElement,
  )).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}
/** The number a tile prints before its label. */
const tile = (text: string, label: string) => text.match(new RegExp(`(\\d+) ${translate(SOURCE_MESSAGES, label).replace(/[()]/g, '\\$&')} `))?.[1];

describe('the Family Health tiles', () => {
  it('count all fifteen active medications, and the list says the rest are in Medical', async () => {
    db.seed('medications', Array.from({ length: 15 }, (_, i) => ({
      id: `med-${pad(i)}`, family_id: FAMILY, member_id: 'member-parent', is_active: true, name: `Medicine ${pad(i)}`, dosage: '1 tab',
    })));
    const text = await page();
    expect(tile(text, 'dashboardFamilyHealth.activeMeds')).toBe('15');
    expect(text.match(/Medicine \d\d/g)).toHaveLength(12);
    expect(text).toContain(translate(SOURCE_MESSAGES, 'familyHealth.moreInMedical', { count: 3 }));
  });

  it('count every provider and every appointment in the next thirty days', async () => {
    db.seed('health_providers', Array.from({ length: 11 }, (_, i) => ({ id: `prov-${pad(i)}`, family_id: FAMILY, name: `Dr ${pad(i)}`, specialty: null, phone: null })));
    db.seed('appointments', Array.from({ length: 10 }, (_, i) => ({
      id: `appt-${pad(i)}`, family_id: FAMILY, member_id: null, title: `Visit ${pad(i)}`, provider: null,
      starts_at: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(),
    })));
    const text = await page();
    expect(tile(text, 'dashboardFamilyHealth.providers')).toBe('11');
    expect(tile(text, 'dashboardFamilyHealth.appts30d')).toBe('10');
    expect(text.match(/Visit \d\d/g)).toHaveLength(8);
    expect(text).toContain(translate(SOURCE_MESSAGES, 'familyHealth.moreInMedical', { count: 2 }));
  });

  it('a short list says nothing more', async () => {
    db.seed('medications', [{ id: 'med-1', family_id: FAMILY, member_id: 'member-parent', is_active: true, name: 'Only one', dosage: null }]);
    const text = await page();
    expect(tile(text, 'dashboardFamilyHealth.activeMeds')).toBe('1');
    expect(text).not.toContain('more in Medical');
  });
});
