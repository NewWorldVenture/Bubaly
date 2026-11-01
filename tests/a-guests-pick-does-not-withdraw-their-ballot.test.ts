// N14 — on the meal planner's family vote, a guest's pick ran the panel's
// two steps: clear the member's ballots for the vote, then insert the new one.
// 0481 refuses a guest's INSERT and UPDATE on meal_vote_ballots
// (meal_vote_ballots_not_a_guest) and not their DELETE, so the clear committed
// and the insert was refused: a guest who held a ballot from before 0481 (or
// from before becoming a guest) lost it, the tally changed, and the screen
// showed only a permission error. A guest is refused before the clear now, and
// the vote's options are not offered to them as buttons that do something.
//
// Driven through the REAL MealsModule (tests/helpers/module-harness.tsx); the
// refused insert is answered the way RLS answers it (42501).
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { FAMILY, HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { click, has, nodes, render, settle, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

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

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: ReturnType<typeof createInMemorySupabase>;

function as(role: string) {
  const self = { id: 'member-1', family_id: FAMILY, display_name: 'Grandma', role, is_active: true, color: null, birthday: null };
  h.app = { ...h.app, members: [self], selfMember: self };
  (h.app as unknown as { role: string }).role = role;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
  db.seed('meal_votes', [{ id: 'vote-1', family_id: FAMILY, title: 'What’s for Friday?', status: 'open', meal_date: null, meal_type: 'dinner', deadline: null, allow_maybe: true, winner_option_id: null, created_by: null }]);
  db.seed('meal_vote_options', [
    { id: 'opt-tacos', vote_id: 'vote-1', family_id: FAMILY, recipe_id: null, label: 'Tacos', photo_url: null },
    { id: 'opt-pizza', vote_id: 'vote-1', family_id: FAMILY, recipe_id: null, label: 'Pizza', photo_url: null },
  ]);
  // The ballot this member cast before they were a guest.
  db.seed('meal_vote_ballots', [{ id: 'ballot-1', vote_id: 'vote-1', option_id: 'opt-tacos', family_id: FAMILY, member_id: 'member-1', choice: 'yes' }]);
  // What 0481 answers a guest's ballot insert.
  h.fault = (table, calls) => (table === 'meal_vote_ballots' && calls.includes('insert') && (h.app as unknown as { role: string }).role === 'guest'
    ? { code: '42501', message: 'new row violates row-level security policy "meal_vote_ballots_not_a_guest" for table "meal_vote_ballots"' } : null);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function mounted(): Promise<ReactNode> {
  render(h.hooks, createElement(MealsModule));
  await settle();
  return render(h.hooks, createElement(MealsModule));
}
const option = (tree: ReactNode, label: string): Node => {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node).includes(label));
  if (!found) throw new Error(`no vote option ${label}`);
  return found;
};
const ballots = () => db.table('meal_vote_ballots').filter((b) => b.member_id === 'member-1');
const wrote = (method: string) => h.calls.some((c) => c.table === 'meal_vote_ballots' && c.calls.includes(method));

describe('a guest on the family vote', () => {
  it('keeps the ballot they already hold when they pick another option', async () => {
    as('guest');
    const tree = await mounted();

    await click(option(tree, 'Pizza'));

    expect(ballots()).toEqual([expect.objectContaining({ id: 'ballot-1', option_id: 'opt-tacos' })]);
    expect(wrote('delete')).toBe(false);
    expect(h.toasts.error).toEqual([t('mealsModule.guestsSeeTheVoteOnly')]);
    expect(h.toasts.success).toEqual([]);
  });

  it('is shown the vote with its options disabled, and told why', async () => {
    as('guest');
    const tree = await mounted();

    expect(option(tree, 'Pizza').props.disabled).toBe(true);
    expect(option(tree, 'Tacos').props.disabled).toBe(true);
    expect(has(tree, t('mealsModule.guestsSeeTheVoteOnly'))).toBe(true);
  });
});

describe('control: a parent', () => {
  it('moves their ballot to the option they pick', async () => {
    as('parent');
    const tree = await mounted();
    expect(option(tree, 'Pizza').props.disabled).toBe(false);

    await click(option(tree, 'Pizza'));

    expect(ballots()).toEqual([expect.objectContaining({ option_id: 'opt-pizza' })]);
    expect(h.toasts.success).toEqual([t('mealsModule.voteRecorded')]);
    expect(has(await mounted(), t('mealsModule.guestsSeeTheVoteOnly'))).toBe(false);
  });
});
