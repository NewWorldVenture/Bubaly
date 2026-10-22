// The Food & Nutrition hub says when a card could not be read.
//
// Each card's read goes through makeDegradeRead, which logs a failure and
// answers `data: null`. Only the Grocery card told that apart from an empty
// result; every other card rendered its healthy empty state and a footer of 0
// over a read that failed — "Nothing expiring soon" and "0 expiring soon" when
// the pantry could not be read, "No dinners planned yet" when the plan could
// not. Each now says the card could not be loaded and names its page instead
// of a count nobody read.
//
// The real page, rendered against an in-memory database with faults.
import { cloneElement, createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ours';
const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'me' }, memberships: [],
    active: { familyId: 'ours', role: 'parent', member: { id: 'member' }, family: { id: 'ours', name: 'Synthetic', timezone: 'America/New_York' } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr, getMessages } = await import('@/lib/i18n/messages');
  const { DEFAULT_LOCALE, localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault(DEFAULT_LOCALE), source: 'default', messages: getMessages(DEFAULT_LOCALE) }),
  };
});
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));

const { default: FoodPage } = await import('@/app/(app)/dashboard/food/page');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-09T16:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mocks.db = db;
  db.seed('grocery_lists', [{ id: 'l-open', family_id: FAMILY, name: 'Groceries', is_archived: false, archived_at: null }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Render a server tree, awaiting its async components (the hub's cards are). */
async function settle(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    return settle(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  if (element.props?.children === undefined) return element;
  return cloneElement(element, undefined, await settle(element.props.children));
}
const html = async () => renderToStaticMarkup(await settle(await FoodPage()) as ReactElement);
/** One card: from its title to the next card's index. */
const card = (page: string, title: string) => {
  const start = page.indexOf(`>${title}</h2>`);
  const next = page.indexOf('</section>', start);
  return page.slice(start, next);
};

describe('a card whose read failed says so', () => {
  it.each([
    ['meal_plans', 'dashboardFood.mealPlanner', 'dashboardFood.noDinnersPlannedYet', 'dashboardFood.count.dinnersPlannedThisWeek'],
    ['pantry_items', 'dashboardFood.pantryInventory', 'dashboardFood.nothingExpiringSoon', 'dashboardFood.count.expiringSoon'],
    ['family_food_scores', 'dashboardFood.nutritionTracker', 'dashboardFood.noNutritionSnapshotYet', 'dashboardFood.count.familyFoodScore'],
    ['dining_out', 'dashboardFood.diningOut', 'dashboardFood.noDiningSpotsSavedYet', 'dashboardFood.count.savedPlaces'],
  ])('%s', async (table, title, empty, countLabel) => {
    mocks.db = withFaults(db, (name) => (name === table ? { message: `synthetic ${table} read failure` } : null));

    const section = card(await html(), t(title));

    expect(section).toContain(t('dashboardFood.cardUnavailable'));
    expect(section).not.toContain(t(empty));
    expect(section).not.toContain(`0 ${t(countLabel)}`);
  });

  it('the recipes and favorites cards, when their table could not be read', async () => {
    mocks.db = withFaults(db, (name) => (name === 'family_recipes' ? { message: 'synthetic recipes read failure' } : null));

    const page = await html();

    for (const [title, empty] of [['dashboardFood.recipes', 'dashboardFood.noRecipesYet'], ['dashboardFood.familyFavorites', 'dashboardFood.noFavoritesYet']]) {
      const section = card(page, t(title));
      expect(section).toContain(t('dashboardFood.cardUnavailable'));
      expect(section).not.toContain(t(empty));
    }
  });

  it('control: reads that worked and found nothing still say nothing is there', async () => {
    const page = await html();

    expect(page).not.toContain(t('dashboardFood.cardUnavailable'));
    expect(card(page, t('dashboardFood.pantryInventory'))).toContain(t('dashboardFood.nothingExpiringSoon'));
    expect(card(page, t('dashboardFood.pantryInventory'))).toContain(`0 ${t('dashboardFood.count.expiringSoon')}`);
  });
});
