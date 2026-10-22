import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { FAMILY, HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { has, nodes, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// H20 — on the meal planner, a failed read of the family vote's ballots only
// logged, then drew the active vote with `ballots: []`: every option at 0,
// nobody's pick highlighted — a vote nobody had voted on, beside a comment
// promising to "degrade to no panel on failure". The vote read itself already
// did degrade; the detail reads now do the same.
//
// Driven through the REAL MealsModule (tests/helpers/module-harness.tsx); its
// vote panel loads in an effect with the module's own reads against an
// in-memory database.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/hooks/use-dismiss-on-escape', () => ({ useDismissOnEscape: () => {} }));
vi.mock('@/app/(app)/dashboard/meals/actions', () => ({ createMealAction: vi.fn(), planMealAction: vi.fn(), removeMealPlanAction: vi.fn() }));
vi.mock('@/app/(app)/dashboard/grocery/actions', () => ({ addMealPlanToGroceryListAction: vi.fn(), setGroceryItemCheckedAction: vi.fn() }));

const { MealsModule } = await import('@/components/modules/meals-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The day-rollover effect's clock; nothing here depends on it ticking.
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
  db.seed('meal_votes', [{ id: 'vote-1', family_id: FAMILY, title: 'What’s for Friday?', status: 'open', meal_date: null, meal_type: 'dinner', deadline: null, allow_maybe: true, winner_option_id: null, created_by: null }]);
  db.seed('meal_vote_options', [
    { id: 'opt-tacos', vote_id: 'vote-1', family_id: FAMILY, recipe_id: null, label: 'Tacos', photo_url: null },
    { id: 'opt-pizza', vote_id: 'vote-1', family_id: FAMILY, recipe_id: null, label: 'Pizza', photo_url: null },
  ]);
  db.seed('meal_vote_ballots', [{ id: 'ballot-1', vote_id: 'vote-1', option_id: 'opt-tacos', family_id: FAMILY, member_id: 'member-1', choice: 'yes' }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Mount, let the vote panel's effect finish its reads, and show the result. */
async function mounted(): Promise<ReactNode> {
  render(h.hooks, createElement(MealsModule));
  await settle();
  return render(h.hooks, createElement(MealsModule));
}
const panel = (tree: ReactNode) => has(tree, t('meals.familyVote'));
/** The bold vote counts beside each option, in order. */
const counts = (tree: ReactNode) => nodes(tree).filter((node) => node.type === 'span' && node.props.className === 'text-xs font-bold').map((node) => String(node.props.children));

describe('the family vote panel never shows a vote it could not read', () => {
  it('shows the vote with its real count when every read succeeds', async () => {
    const tree = await mounted();
    expect(panel(tree)).toBe(true);
    expect(counts(tree)).toEqual(['1', '0']);
  });

  it('shows no panel — not every option at 0 — when the ballots could not be read', async () => {
    h.fault = (table) => (table === 'meal_vote_ballots' ? { message: 'Fixture read refused' } : null);

    const tree = await mounted();

    expect(panel(tree)).toBe(false);
    expect(has(tree, 'Tacos')).toBe(false);
    expect(console.error).toHaveBeenCalledWith('[meals] vote detail read failed', expect.objectContaining({ ballots: 'Fixture read refused' }));
  });
});
