// A grocery list that could not be read is not shown as an empty one.
//
// Counting and listing unchecked groceries now reads the family's open lists
// first (`readOnOpenGroceryLists`, lib/services/groceries), so a failed
// `grocery_lists` read is one more way the grocery read can fail. The helper
// hands the failure back in the shape of a failed read, and three of the
// dashboards it was added to dropped it (owner coordinator finding
// AUD-1037-GROCERY-READ-STATE):
//
//   * FamilyDashboard kept only `data`: the Grocery List card said "Grocery
//     list is empty", and with dinners planned it advised building a list;
//   * AiHomeDashboard read the count as `groceryCount ?? 0`: "You're all
//     caught up" and the getting-started card's "Start a grocery list";
//   * the Food hub's degrade-read answered `data: null`, which the card
//     rendered as "Your list is empty" and "0 items to buy".
//
// Each now says the list could not be loaded, and draws no advice from a
// count nobody read. Successful reads, empty or not, are unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneElement, createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UserContext } from '@/lib/supabase/auth';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ours';
const mocks = vi.hoisted(() => ({ db: null as unknown, brief: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db, createServiceClient: () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = {
    user: { id: 'me', email: 'sam@example.invalid' },
    memberships: [],
    active: {
      familyId: 'ours', role: 'parent',
      member: { id: 'member', role: 'parent', display_name: 'Sam', user_id: 'me' },
      family: { id: 'ours', name: 'Synthetic', timezone: 'America/New_York' },
    },
  };
  return { requireUserContext: async () => ctx, requireFeature: async () => ctx, isSuperAdmin: async () => false };
});
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
  return { useFamilyTimeZone: () => undefined, useTranslations: () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
// AiHomeDashboard's other sources and client islands, as tests/home-calendar-readers.test.ts stubs them.
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/autopilot/engine', () => ({ successProbability: () => 0, autopilotTitleFor: (s: { title: string }) => s.title }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/components/concierge/ask-bubaly', () => ({ AskBubaly: () => null }));
vi.mock('@/components/concierge/working-on', () => ({ WorkingOn: () => null }));
vi.mock('@/components/concierge/completed-by-bubaly', () => ({ CompletedByBubaly: () => null }));
vi.mock('@/components/dashboard/quick-actions', () => ({ DashboardQuickActions: () => null }));
vi.mock('@/components/dashboard/insight-hero', () => ({ InsightHero: ({ insight }: { insight: { title: string } }) => createElement('aside', null, insight.title) }));
vi.mock('@/components/approvals/approval-card', () => ({ ApprovalCard: () => null }));
vi.mock('@/components/dashboard/home-approval-actions', () => ({ HomeApprovalActions: () => null }));
vi.mock('@/components/family/record-actions', () => ({ RecommendationActions: () => null }));
vi.mock('@/components/concierge/needs-you-actions', () => ({ FactSuggestionActions: () => null, InboxMessageActions: () => null }));
vi.mock('@/components/dashboard/dashboard-weather', () => ({ DashboardWeather: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/lib/home/home-brief', async (original) => {
  const actual = await original<typeof import('@/lib/home/home-brief')>();
  return { ...actual, buildHomeBrief: (...args: Parameters<typeof actual.buildHomeBrief>) => { mocks.brief(...args); return actual.buildHomeBrief(...args); } };
});

const { FamilyDashboard } = await import('@/components/dashboard/family-dashboard');
const { AiHomeDashboard } = await import('@/components/dashboard/ai-home-dashboard');
const { default: FoodPage } = await import('@/app/(app)/dashboard/food/page');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const NOW = new Date('2026-09-09T16:00:00Z');
const ctx = {
  user: { id: 'me', email: 'sam@example.invalid' },
  memberships: [],
  active: {
    familyId: FAMILY, role: 'parent',
    member: { id: 'member', role: 'parent', display_name: 'Sam', user_id: 'me' },
    family: { id: FAMILY, name: 'Synthetic', timezone: 'America/New_York' },
  },
} as unknown as UserContext;

let db: InMemorySupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.brief.mockClear();
  db = createInMemorySupabase();
  mocks.db = db;
  db.seed('families', [{ id: FAMILY, timezone: 'America/New_York' }]);
  db.seed('family_members', [{ id: 'member', family_id: FAMILY, display_name: 'Sam', role: 'parent', is_active: true, user_id: 'me' }]);
  db.seed('grocery_lists', [{ id: 'l-open', family_id: FAMILY, name: 'Groceries', is_archived: false, archived_at: null }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** The same database, with every read of `table` answered by an error. */
function failing(table: 'grocery_lists' | 'grocery_items') {
  mocks.db = withFaults(db, (name) => (name === table ? { message: `synthetic ${table} read failure` } : null));
}
const dinnersPlanned = () => db.seed('meal_plans', [{ family_id: FAMILY, meal_type: 'dinner', plan_date: '2026-09-10', meal_id: null }]);

/** Render a server tree, awaiting its async components (the Food hub's cards are). */
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
const html = async (tree: ReactNode | Promise<ReactNode>) => renderToStaticMarkup(await settle(await tree) as ReactElement);

describe('the family dashboard', () => {
  it('says the grocery list could not be loaded when the open-list read fails, and does not call it empty', async () => {
    dinnersPlanned();
    failing('grocery_lists');
    const page = await html(FamilyDashboard({ ctx }));

    expect(page).toContain(t('familyDashboard.groceryListUnavailable'));
    expect(page).not.toContain(t('familyDashboard.groceryListIsEmpty'));
    // No advice drawn from a list nobody read.
    expect(page).not.toContain(t('familyDashboard.mealsNoGroceries'));
    expect(page).not.toContain('0 items');
  });

  it('says the same when the item read itself fails', async () => {
    failing('grocery_items');
    const page = await html(FamilyDashboard({ ctx }));

    expect(page).toContain(t('familyDashboard.groceryListUnavailable'));
    expect(page).not.toContain(t('familyDashboard.groceryListIsEmpty'));
  });

  it('control: an open list that is empty is still empty, with the advice it supports', async () => {
    dinnersPlanned();
    const page = await html(FamilyDashboard({ ctx }));

    expect(page).toContain(t('familyDashboard.groceryListIsEmpty'));
    expect(page).toContain(t('familyDashboard.mealsNoGroceries'));
    expect(page).not.toContain(t('familyDashboard.groceryListUnavailable'));
  });

  it('control: an open list with items lists them', async () => {
    db.seed('grocery_items', [{ id: 'g-milk', family_id: FAMILY, list_id: 'l-open', name: 'Milk', is_checked: false }]);
    const page = await html(FamilyDashboard({ ctx }));

    expect(page).toContain('Milk');
    expect(page).toContain('1 items');
    expect(page).not.toContain(t('familyDashboard.groceryListUnavailable'));
  });
});

describe('the AI home dashboard', () => {
  it('says the grocery list could not be loaded, and neither says all is caught up nor scores the week from a zero', async () => {
    failing('grocery_lists');
    const page = await html(AiHomeDashboard({ ctx }));

    expect(page).toContain(t('aiHomeDashboard.groceryUnavailable'));
    expect(page).not.toMatch(/nothing needs you right now/i);
    // The getting-started outcome ("Start a grocery list") is built from the count; it waits for one.
    expect(mocks.brief).not.toHaveBeenCalled();
  });

  it('control: with the list read, an empty family is told it is caught up and gets its getting-started outcome', async () => {
    const page = await html(AiHomeDashboard({ ctx }));

    expect(page).not.toContain(t('aiHomeDashboard.groceryUnavailable'));
    expect(page).toMatch(/nothing needs you right now/i);
    expect(mocks.brief).toHaveBeenCalledWith(expect.objectContaining({ groceryOpen: 0 }), expect.any(Date));
  });

  it('control: items on the open list still raise the grocery need', async () => {
    db.seed('grocery_items', [{ id: 'g-milk', family_id: FAMILY, list_id: 'l-open', name: 'Milk', is_checked: false }]);
    const page = await html(AiHomeDashboard({ ctx }));

    expect(page).toContain('Grocery list needs updating');
    expect(page).not.toContain(t('aiHomeDashboard.groceryUnavailable'));
  });
});

describe('the Food hub', () => {
  it('says the grocery list could not be loaded, and counts no items it did not read', async () => {
    failing('grocery_lists');
    const page = await html(FoodPage());

    expect(page).toContain(t('dashboardFood.groceryListUnavailable'));
    expect(page).not.toContain(t('dashboardFood.yourListIsEmpty'));
    expect(page).not.toContain(`0 ${t('dashboardFood.count.itemsToBuy')}`);
  });

  it('control: an empty open list is still empty, with its count', async () => {
    const page = await html(FoodPage());

    expect(page).toContain(t('dashboardFood.yourListIsEmpty'));
    expect(page).toContain(`0 ${t('dashboardFood.count.itemsToBuy')}`);
    expect(page).not.toContain(t('dashboardFood.groceryListUnavailable'));
  });

  it('control: an open list with items lists them and counts them', async () => {
    db.seed('grocery_items', [{ id: 'g-milk', family_id: FAMILY, list_id: 'l-open', name: 'Milk', is_checked: false }]);
    const page = await html(FoodPage());

    expect(page).toContain('Milk');
    expect(page).toContain(`1 ${t('dashboardFood.count.itemsToBuy')}`);
  });
});
