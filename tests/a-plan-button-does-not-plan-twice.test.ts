import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, render, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// H13 — the move checklist and the declutter week planner insert rows computed
// from what is ON SCREEN, and neither table has a unique key (move_tasks has no
// (move_id, template_key) index, declutter_missions none at all). Each insert
// returned, re-enabled its button still labelled "Add N-step checklist" /
// "Plan this week (N)" from the stale list, and stayed that way until the
// realtime INSERT event's refetch completed. A second click in that window —
// unbounded whenever realtime lagged or dropped — inserted every row again.
//
// The harness's realtime hook never refetches on its own, which is that window
// held open: these show the second click finds nothing left to plan.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { MovingModule } = await import('@/components/modules/moving-module');
const { DeclutterModule } = await import('@/components/modules/declutter-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = (Component: ComponentType): ReactNode => render(h.hooks, createElement(Component));
/** A person clicks again: only a button the browser would let them press. */
async function clickAgain(button: Node) {
  if (!button.props.disabled) await click(button);
}

describe('a plan button does not plan the same rows twice', () => {
  it('moving: a second "Add the checklist" before the refetch inserts nothing more', async () => {
    db.seed('moves', [{ id: 'move-1', title: 'To Portland', move_date: '2026-12-01', status: 'planning' }]);

    await click(byName(screen(MovingModule), /step checklist$/));
    const first = db.table('move_tasks').length;
    expect(first).toBeGreaterThan(0);
    expect(h.toasts.success).toHaveLength(1);

    await clickAgain(byName(screen(MovingModule), /checklist/i));

    expect(db.table('move_tasks')).toHaveLength(first);
    const keys = db.table('move_tasks').map((row) => row.template_key);
    expect(new Set(keys).size).toBe(keys.length);
    // The steps it added are on the timeline already, not after a reload.
    expect(h.rows.move_tasks).toHaveLength(first);
  });

  it('declutter: a second "Plan this week" before the refetch inserts nothing more', async () => {
    db.seed('declutter_zones', [
      { id: 'zone-1', name: 'Kitchen counter', clutter_score: 4 },
      { id: 'zone-2', name: 'Garage floor', kind: 'garage', clutter_score: 5 },
    ]);

    await click(byName(screen(DeclutterModule), /^Plan this week \(\d+\)$/));
    const first = db.table('declutter_missions').length;
    expect(first).toBe(2);

    await clickAgain(byName(screen(DeclutterModule), /^Plan this week/));

    expect(db.table('declutter_missions')).toHaveLength(first);
    expect(h.toasts.error).toContain(t('declutterModule.everyZoneAlreadyHasA'));
    expect(h.rows.declutter_missions).toHaveLength(first);
  });
});
