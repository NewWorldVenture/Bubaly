import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, nodes, render, settle, submit, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// A trip's Budget tab: a logged expense was listed, but Spent and Remaining
// stayed where they were.
//
// The expense list is a TripCrudSection with its OWN read of
// `vacation_expenses`; the totals above it came from a second read of the same
// table in TripBudget. No `vacation_*` table is realtime-published, so after
// "Log expense" the section re-read its copy and the totals kept theirs: $120
// of dinner in the list, "Spent $0, Remaining $500" at the top, and the
// over-budget warning silent, until a reload. Deleting an expense left it
// counted the same way. The list and the totals now read one source.
//
// The REAL TripBudget, driven through tests/helpers/module-harness.tsx. Its
// stock realtime hook keeps ONE list per table, which would hide the defect, so
// this one keeps a list per hook CALL, as the real hook's state does: each read
// changes only when that caller re-reads it.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
type Fetcher = (client: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const React = await import('react');
  const { clientFor } = await import('./helpers/module-harness');
  return {
    useRealtimeQuery: ({ fetcher }: { fetcher: Fetcher }) => {
      const [entry] = React.useState(() => ({ data: [] as unknown[], loaded: false, started: false, error: null as string | null, fetcher }));
      entry.fetcher = fetcher;
      const reread = async () => {
        const { data, error } = await entry.fetcher(clientFor(h));
        entry.loaded = true;
        entry.error = error ? error.message : null;
        if (!error) entry.data = data ?? [];
        return !error;
      };
      if (!entry.started) { entry.started = true; void reread(); }
      return {
        data: entry.data, loading: !entry.loaded, error: entry.error, stale: false, updatedAt: 0,
        refresh: async () => { await reread(); },
        refreshAndConfirm: async () => ((await reread()) ? { ok: true as const } : { ok: false as const, reason: 'error' as const }),
        setData: (update: unknown[] | ((rows: unknown[]) => unknown[])) => { entry.data = typeof update === 'function' ? update(entry.data) : update; },
      };
    },
  };
});
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => ({ ...(await import('./helpers/module-harness')).ui, LoadingBlock: () => null }));

const { TripBudget } = await import('@/components/vacations/trip-budget');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: { vacation_expenses: { spent_on: '2026-10-26', notes: null, paid_by_member_id: null, member_id: null } } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'America/New_York';
  vi.stubGlobal('confirm', () => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('vacations', [{ id: 'trip-1', family_id: FAMILY, title: 'Lake week', start_date: '2026-11-07', end_date: '2026-11-14' }]);
  db.seed('vacation_budgets', [{ id: 'b-food', family_id: FAMILY, vacation_id: 'trip-1', category: 'food', planned_cents: 50000, notes: null }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const draw = (): ReactNode => render(h.hooks, createElement(TripBudget, { vacationId: 'trip-1' }));
/** The screen once every read it started has answered. */
async function show(): Promise<ReactNode> {
  for (let pass = 0; pass < 4; pass++) { draw(); await settle(); }
  return draw();
}
/** A StatPill reads "<label><value>". */
const pill = (tree: ReactNode, labelKey: string) =>
  nodes(tree).filter((n) => n.type === 'div' && text(n).startsWith(t(labelKey))).map((n) => text(n).slice(t(labelKey).length)).find((v) => v.length < 20);

async function logDinner() {
  await click(byName(await show(), /Log expense/));
  const field = (type: string) => nodes(form(draw())).filter((n): n is Node => n.type === 'input').find((n) => n.props.type === type) as Node;
  change(field('text'), 'Dinner');
  change(field('number'), '120');
  change(nodes(form(draw())).find((n) => n.type === 'select') as Node, 'food');
  await submit(form(draw()));
}

describe('a logged trip expense', () => {
  it('is in Spent and Remaining as soon as it is listed', async () => {
    expect(pill(await show(), 'tripBudget.spent')).toBe('$0');

    await logDinner();

    expect(db.table('vacation_expenses').map((row) => row.amount_cents)).toEqual([12000]);
    const after = await show();
    expect(text(after)).toContain('Dinner');
    expect(pill(after, 'tripBudget.spent')).toBe('$120');
    expect(pill(after, 'tripBudget.remaining')).toBe('$380');
  });

  it('leaves Spent when it is deleted', async () => {
    db.seed('vacation_expenses', [{ id: 'x-1', family_id: FAMILY, vacation_id: 'trip-1', description: 'Dinner', amount_cents: 12000, category: 'food', spent_on: '2026-10-26' }]);
    expect(pill(await show(), 'tripBudget.spent')).toBe('$120');

    await click(byName(await show(), t('a11y.delete')));

    expect(db.table('vacation_expenses')).toEqual([]);
    expect(pill(await show(), 'tripBudget.spent')).toBe('$0');
  });
});
