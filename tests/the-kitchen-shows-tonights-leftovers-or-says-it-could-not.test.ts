// The Smart Kitchen's leftovers card shows tonight's leftovers, or says it
// could not read them — never "No leftovers logged" over either.
//
// The page read `leftover_inventory` for the family with `.limit(50)` and no
// status filter or order. Eaten, frozen and tossed rows are never deleted, so
// past 50 rows of history the 50 that came back were the oldest — and the card
// said "No leftovers logged" with fresh ones in the fridge. A failed read (a
// timeout, a refused query) rendered the same empty state, and a failed
// nutrition read left a Food Score missing a part that the card still offered
// to save.
//
// The real page renders the real dashboard against an in-memory database.
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr, getMessages } = await import('@/lib/i18n/messages');
  const { DEFAULT_LOCALE, localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault(DEFAULT_LOCALE), source: 'default', messages: getMessages(DEFAULT_LOCALE) }),
  };
});
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { useFamilyTimeZone: () => 'UTC', useTranslations: () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtDate: (d: string) => d }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('next/link', async () => {
  const { createElement: el } = await import('react');
  return { default: ({ children, href, ...props }: ComponentProps<'a'>) => el('a', { href, ...props }, children) };
});
vi.mock('@/app/(app)/dashboard/kitchen/actions', () => ({
  addLeftoverAction: vi.fn(), updateLeftoverStatusAction: vi.fn(), deleteLeftoverAction: vi.fn(), snapshotFoodScoreAction: vi.fn(),
}));

const { default: KitchenPage } = await import('@/app/(app)/dashboard/kitchen/page');
const { KitchenDashboard } = await import('@/components/modules/kitchen-dashboard');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T16:00:00Z'));
  base = createInMemorySupabase<SupabaseClient<Database>>({ defaults: { grocery_lists: { is_archived: false, archived_at: null } } });
  h.db = base;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

type KitchenElement = ReactElement<{ data: ComponentProps<typeof KitchenDashboard>['data'] }>;
const page = async () => (await KitchenPage()) as KitchenElement;
const markup = (element: KitchenElement) => renderToStaticMarkup(createElement(KitchenDashboard, element.props));

describe('the leftovers card', () => {
  it('shows tonight\'s fresh leftovers behind a long history of eaten ones', async () => {
    // Sixty leftovers eaten over the last months, logged before tonight's.
    base.seed('leftover_inventory', Array.from({ length: 60 }, (_, i) => ({
      id: `old-${String(i).padStart(2, '0')}`, family_id: FAMILY, name: `Old ${i}`, source_meal: null,
      quantity: null, use_by: '2026-06-01', location: 'fridge', status: i % 2 ? 'eaten' : 'tossed',
    })));
    base.seed('leftover_inventory', [{ id: 'tonight', family_id: FAMILY, name: 'Chili', source_meal: 'Chili', quantity: null, use_by: '2026-10-15', location: 'fridge', status: 'fresh' }]);

    const element = await page();

    expect(element.props.data.leftovers.map((l) => l.name)).toEqual(['Chili']);
    expect(element.props.data.leftoverNudge).toContain('Chili');
    expect(markup(element)).not.toContain(t('kitchenDashboard.noLeftoversLoggedLogOneAfter'));
  });

  it('says it could not read them when the read fails, not that there are none', async () => {
    h.db = withFaults(base, (table) => (table === 'leftover_inventory' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));

    const html = markup(await page());

    expect(html).toContain(t('kitchenDashboard.leftoversCouldNotBeLoaded'));
    expect(html).not.toContain(t('kitchenDashboard.noLeftoversLoggedLogOneAfter'));
  });

  it('a table that is not migrated yet still reads as tracking-not-on-yet', async () => {
    h.db = withFaults(base, (table) => (table === 'leftover_inventory' ? { code: '42P01', message: 'relation "public.leftover_inventory" does not exist' } : null));

    const html = markup(await page());

    expect(html).toContain(t('kitchenDashboard.leftoverTrackingTurnsOnOnceThe'));
  });
});

describe('the Food Score', () => {
  it('is not offered for saving when the week\'s nutrition could not be read', async () => {
    // Two cache rows for one week: the page's `.maybeSingle()` answers an
    // error (PGRST116) rather than a row — a failed read, not a missing table.
    // (withFaults answers awaited queries; this one ends in maybeSingle.)
    base.seed('meal_nutrition', [1, 2].map((n) => ({
      id: `n-${n}`, family_id: FAMILY, subject_type: 'week', subject_id: '2026-10-12', calories: 2000,
      protein_g: 80, carbs_g: 250, fat_g: 70, fiber_g: 30, sugar_g: 40, sodium_mg: 2000,
    })));

    const html = markup(await page());

    const note = t('kitchenDashboard.nutritionCouldNotBeLoaded');
    expect(html).toContain(note);
    // The save button follows the note, and it is disabled.
    const saveButton = /<button[^>]*>/.exec(html.slice(html.indexOf(note)))?.[0] ?? '';
    expect(saveButton).toContain('disabled=""');
  });

  it('is offered as before when the read worked', async () => {
    const html = markup(await page());

    expect(html).not.toContain(t('kitchenDashboard.nutritionCouldNotBeLoaded'));
  });
});
