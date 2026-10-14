// A routine's steps: an edit never leaves it with none, two saves never leave
// it with both, and applying an edited routine never reports what it did not do.
//
//   N19 — saving a routine deleted every step and then inserted the new ones,
//         so a refused insert (a lost connection, an out-of-range minute)
//         left the routine with no steps; two members saving at once could
//         interleave and leave every step twice.
//   N17 — applying a routine to a week again (same week, same session) after
//         editing it was answered by its batch key with the FIRST apply's rows:
//         "Added N events" with the old count, and none of the change.
//
// The editor is driven through the real RoutinesPanel's own handlers
// (tests/helpers/module-harness.tsx); the apply goes through the real server
// action and service. Both against an in-memory database.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, nodes, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

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
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.app.userId },
    active: { familyId: h.app.familyId, role: 'parent', member: { id: 'member-1' }, family: { name: 'Fixture family', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { RoutinesPanel } = await import('@/components/modules/routines-panel');
const { applyRoutineToCalendarAction } = await import('@/app/(app)/dashboard/calendar/actions');
const { newSubmissionId } = await import('@/lib/utils/submission-id');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
let db: InMemorySupabase;

const panel = () => createElement(RoutinesPanel, { events: [], weekStartMonday: new Date('2026-10-12T00:00:00.000Z'), timeZone: 'UTC', onApplied: () => {} });
const steps = () => db.table('routine_template_items').filter((r) => r.template_id === 'tpl-1').map((r) => r.title).sort();

async function openEditorAndRename(title: string) {
  let tree = render(h.hooks, panel());
  await click(byName(tree, t('routines.editRoutine')));
  tree = render(h.hooks, panel());
  const step = nodes(tree).find((n) => n.type === 'input' && n.props.placeholder === t('routines.eGBreakfast'))!;
  change(step, title);
  tree = render(h.hooks, panel());
  await click(byName(tree, 'Save routine'));
  await settle();
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ uniques: { calendar_events: [['family_id', 'idempotency_key']] }, defaults: { calendar_events: { idempotency_key: null, feed_id: null, external_uid: null } } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  h.timeZone = 'UTC';
  db.seed('routine_templates', [{ id: 'tpl-1', family_id: FAMILY, name: 'School morning', icon: '🔁', weekday_mask: 31, is_active: true, source: 'manual', created_by: 'user-1', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }]);
  db.seed('routine_template_items', [{ id: 'item-1', template_id: 'tpl-1', family_id: FAMILY, title: 'Breakfast', category: 'general', start_minutes: 420, duration_minutes: 30, assignee_id: null, sort_order: 0 }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('saving a routine replaces its steps without ever leaving it empty (N19)', () => {
  it('a refused insert of the new steps keeps the old ones', async () => {
    h.fault = (table, calls) => (table === 'routine_template_items' && calls.includes('insert')
      ? { message: 'new row for relation "routine_template_items" violates check constraint', code: '23514' } : null);
    await openEditorAndRename('Pack lunch');
    expect(h.toasts.error).toHaveLength(1);
    expect(steps()).toEqual(['Breakfast']);
  });

  it('a save another member finished first stands, with no step listed twice, and this one says so', async () => {
    let raced = false;
    h.fault = (table, calls) => {
      if (!raced && table === 'routine_template_items' && calls.includes('delete')) {
        // The other member's save replaced the steps a moment earlier.
        raced = true;
        db.replace('routine_template_items', db.table('routine_template_items').filter((r) => r.id !== 'item-1'));
        db.seed('routine_template_items', [{ id: 'item-other', template_id: 'tpl-1', family_id: FAMILY, title: 'Other step', category: 'general', start_minutes: 400, duration_minutes: 20, assignee_id: null, sort_order: 0 }]);
      }
      return null;
    };
    await openEditorAndRename('Pack lunch');
    expect(steps()).toEqual(['Other step']);
    expect(h.toasts.error).toEqual([t('routinesPanel.routineChangedWhileSaving')]);
  });

  it('an ordinary save replaces the steps', async () => {
    await openEditorAndRename('Pack lunch');
    expect(h.toasts.error).toEqual([]);
    expect(steps()).toEqual(['Pack lunch']);
  });
});

describe('applying an edited routine again is not answered with the old week (N17)', () => {
  const step = (title: string, day: number, hour: number) => ({
    title, startsAt: `2026-10-${String(12 + day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    endsAt: `2026-10-${String(12 + day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:30:00.000Z`, category: 'general', assigneeId: null,
  });

  it('a step added since the first apply is refused, not reported as "Added N events"', async () => {
    const submissionId = newSubmissionId();
    const first = await applyRoutineToCalendarAction({ events: [step('Breakfast', 0, 7), step('Breakfast', 1, 7)], submissionId });
    expect(first.ok).toBe(true);
    const edited = await applyRoutineToCalendarAction({ events: [step('Breakfast', 0, 7), step('Breakfast', 1, 7), step('Pack lunch', 0, 8)], submissionId });
    expect(edited).toEqual({ ok: false, error: t('calendar.routineAlreadyAppliedAsItWas') });
    expect(db.table('calendar_events').map((r) => r.title).sort()).toEqual(['Breakfast', 'Breakfast']);
  });

  it('the same routine applied twice (a double tap) is still one week of events', async () => {
    const submissionId = newSubmissionId();
    const events = [step('Breakfast', 0, 7), step('Breakfast', 1, 7)];
    const first = await applyRoutineToCalendarAction({ events, submissionId });
    const second = await applyRoutineToCalendarAction({ events, submissionId });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect([...second.eventIds].sort()).toEqual([...first.eventIds].sort());
    expect(db.table('calendar_events')).toHaveLength(2);
  });
});
