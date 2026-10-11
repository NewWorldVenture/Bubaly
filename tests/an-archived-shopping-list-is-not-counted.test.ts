// Items on an archived shopping list are not counted or listed as still needed.
//
// The follow-up to tests/an-archived-shopping-list-is-not-nagged-about.test.ts.
// Archiving a list (`grocery_lists.archived_at`, or 0002's `is_archived`) takes
// it off the shopping page, but eleven readers outside the groceries service
// counted or listed unchecked `grocery_items` across every list:
//
//   * lib/family/signals.ts — `emptyGrocery`, so "your week has meals planned
//     but the grocery list is empty" was never said while an archived list
//     held leftovers;
//   * app/(app)/home/page.tsx — the "N items" badge on the shopping outcome;
//   * components/dashboard/family-dashboard.tsx — the Grocery List card named
//     the archived items;
//   * lib/assistant/tools.ts — `list_pending_decisions` said "Grocery list
//     needs updating";
//   * and seven more pages (ai-home-dashboard, the kitchen display, agents,
//     outcomes, food, kitchen, family-coo), held by the source guard below.
//
// Each now reads only lists the family has not archived
// (`readOnOpenGroceryLists`, lib/services/groceries).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import type { DiscoverySnapshot } from '@/lib/outcomes/discovery';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ours';
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = { user: { id: 'me' }, active: { familyId: 'ours', role: 'parent', member: { id: 'member', role: 'parent', display_name: 'Sam', user_id: 'me' }, family: { id: 'ours', timezone: 'America/New_York' } } };
  return { requireUserContext: async () => ctx, requireFeature: async () => ctx };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr, getMessages } = await import('@/lib/i18n/messages');
  const { DEFAULT_LOCALE, localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault(DEFAULT_LOCALE), source: 'default', messages: getMessages(DEFAULT_LOCALE) }),
  };
});
// Home's other sources, as tests/outcome-discovery-sources.test.ts stubs them.
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/schedule/intelligence-server', () => ({ loadScheduleIntelligence: async () => ({ ok: true, data: { byEvent: {} } }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ loadTimeSaved: async () => ({ show: false }) }));
vi.mock('@/lib/operating-index/server', () => ({ loadOperatingIndex: async () => ({ change: null }) }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/dashboard/dashboard-weather', () => ({ DashboardWeather: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
const { default: Home } = await import('@/app/(app)/home/page');
const { OutcomesStrip } = await import('@/components/outcomes/outcomes-strip');
const { FamilyDashboard } = await import('@/components/dashboard/family-dashboard');
const { gatherSignalsResult } = await import('@/lib/family/signals');
const { buildAssistantTools } = await import('@/lib/assistant/tools');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const NOW = new Date('2026-09-09T16:00:00Z');

let db: InMemorySupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  holder.db = db;
  db.seed('families', [{ id: FAMILY, timezone: 'America/New_York' }]);
  db.seed('family_members', [{ id: 'member', family_id: FAMILY, display_name: 'Sam', role: 'parent', is_active: true, user_id: 'me' }]);
  db.seed('activation_events', [{ id: 'activated', family_id: FAMILY, user_id: 'me', milestone: 'first_outcome_viewed' }]);
  db.seed('grocery_lists', [
    { id: 'l-open', family_id: FAMILY, name: 'Groceries', is_archived: false, archived_at: null },
    { id: 'l-archived', family_id: FAMILY, name: 'Party shop', is_archived: false, archived_at: '2026-09-01T10:00:00Z' },
    { id: 'l-legacy', family_id: FAMILY, name: 'Old list', is_archived: true, archived_at: null },
  ]);
  // Meals planned this week, so "meals planned but the list is empty" can be said.
  db.seed('meal_plans', [{ family_id: FAMILY, meal_type: 'dinner', plan_date: '2026-09-10', meal_id: null }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Leftovers on the two archived lists only; the open list is empty. */
function leftoversOnArchivedLists() {
  db.seed('grocery_items', [
    { id: 'g-hats', family_id: FAMILY, list_id: 'l-archived', name: 'Party hats', is_checked: false },
    { id: 'g-flour', family_id: FAMILY, list_id: 'l-legacy', name: 'Rye flour', is_checked: false },
  ]);
}

function homeSnapshot(node: ReactNode): DiscoverySnapshot | null {
  if (Array.isArray(node)) return node.map(homeSnapshot).find(Boolean) ?? null;
  if (!isValidElement<{ snapshot?: DiscoverySnapshot; children?: ReactNode }>(node)) return null;
  if (node.type === OutcomesStrip) return node.props.snapshot ?? null;
  return homeSnapshot(node.props.children);
}

const dashboardCtx = {
  user: { id: 'me', email: null },
  memberships: [],
  active: { familyId: FAMILY, family: { id: FAMILY, timezone: 'America/New_York' }, role: 'parent', member: { id: 'member', user_id: 'me', display_name: 'Sam' } },
} as unknown as UserContext;

const pendingDecisions = async () => {
  const tool = buildAssistantTools(db as unknown as SupabaseClient<Database>, {
    familyId: FAMILY, userId: 'me', memberId: 'member', members: [{ id: 'member', display_name: 'Sam' }], tz: 'America/New_York',
  }).find((candidate) => candidate.name === 'list_pending_decisions');
  return await tool!.execute({}) as { ok: boolean; items: { title: string }[] };
};

describe('an archived list’s leftovers are not counted', () => {
  it('family signals call the grocery list empty', async () => {
    leftoversOnArchivedLists();
    const result = await gatherSignalsResult(FAMILY, 'America/New_York', NOW);
    expect(result.error).toBeNull();
    expect(result.data?.counts.emptyGrocery).toBe(true);
  });

  it('Home’s shopping outcome counts none', async () => {
    leftoversOnArchivedLists();
    expect(homeSnapshot(await Home())?.openGrocery).toBe(0);
  });

  it('the family dashboard’s grocery card is empty and names none of them', async () => {
    leftoversOnArchivedLists();
    const html = renderToStaticMarkup(await FamilyDashboard({ ctx: dashboardCtx }));
    expect(html).toContain(t('familyDashboard.groceryListIsEmpty'));
    expect(html).not.toContain('Party hats');
    expect(html).not.toContain('Rye flour');
  });

  it('the assistant does not say the grocery list needs updating', async () => {
    leftoversOnArchivedLists();
    const res = await pendingDecisions();
    expect(res.ok).toBe(true);
    expect(res.items.map((item) => item.title)).not.toContain('Grocery list needs updating');
  });
});

describe('an open list’s items still are', () => {
  beforeEach(() => {
    db.seed('grocery_items', [{ id: 'g-milk', family_id: FAMILY, list_id: 'l-open', name: 'Milk', is_checked: false }]);
    leftoversOnArchivedLists();
  });

  it('in the signals, on Home, on the dashboard and for the assistant', async () => {
    expect((await gatherSignalsResult(FAMILY, 'America/New_York', NOW)).data?.counts.emptyGrocery).toBe(false);
    expect(homeSnapshot(await Home())?.openGrocery).toBe(1);
    const html = renderToStaticMarkup(await FamilyDashboard({ ctx: dashboardCtx }));
    expect(html).toContain('Milk');
    expect(html).not.toContain('Party hats');
    expect((await pendingDecisions()).items.map((item) => item.title)).toContain('Grocery list needs updating');
  });
});

describe('readOnOpenGroceryLists', () => {
  it('reports a failed list read as a failed read, and never runs the item read', async () => {
    const { readOnOpenGroceryLists } = await import('@/lib/services/groceries');
    const error = { message: 'connection lost' };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is']) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error }).then(resolve);
    const failing = { from: () => chain } as unknown as SupabaseClient<Database>;
    const read = vi.fn(async () => ({ data: [], count: 0, error: null }));

    const result = await readOnOpenGroceryLists(failing, FAMILY, read);

    expect(result).toEqual({ data: null, count: null, error });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('every unchecked grocery read is scoped to a list', () => {
  // A read of `grocery_items` filtered on `is_checked = false` is "what is
  // still needed", and an archived list's items are not. Scoped means the
  // chain names `list_id`: one list the caller chose, or the open lists.
  it('in app/, lib/ and components/', () => {
    const files = execFileSync('git', ['ls-files', 'app', 'lib', 'components'], { encoding: 'utf8' })
      .split('\n').filter((file) => /\.(ts|tsx)$/.test(file));
    const unscoped: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\('grocery_items'\)/g)) {
        const rest = source.slice(match.index, match.index + 700);
        // The statement ends at `;` or at the `)` that closes an array element.
        const ends = [rest.indexOf(';'), rest.indexOf('),\n') + 1].filter((at) => at > 0);
        const chain = rest.slice(0, ends.length ? Math.min(...ends) : rest.length);
        if (/\.(insert|update|delete|upsert)\(/.test(chain)) continue;
        if (!chain.includes(".eq('is_checked', false)")) continue;
        if (!chain.includes('list_id')) unscoped.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
      }
    }
    expect(unscoped).toEqual([]);
  });
});
