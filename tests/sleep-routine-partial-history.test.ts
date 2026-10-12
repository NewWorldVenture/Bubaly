import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { FAMILY, HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { allByName, byName, click, form, has, render, submit } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Real SleepModule/effects/handlers/helpers. The hook and React slots model
// the explicit returned screen, without a DOM, live RLS or provider calls.
const h = await vi.hoisted(async () => ({ ...(await import('./helpers/module-state')).createModuleState(), role: 'caregiver' }));
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ ...h.app, role: h.role }) }));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
const { SleepModule } = await import('@/components/modules/sleep-module');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;
const ward = { id: 'synthetic-ward', display_name: 'Synthetic ward', user_id: null, birthday: '2015-06-04', is_active: true };
const self = { id: 'synthetic-self', display_name: 'Synthetic caregiver', user_id: 'synthetic-viewer', birthday: '1990-01-01', is_active: true };
const night = (id: string, date: string, author: string, member = ward.id) => ({ id, member_id: member, sleep_date: date, bedtime: date + 'T00:00:00Z', wake_time: date + 'T08:00:00Z', duration_min: 480, created_by: author });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-10T15:00:00Z')); resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS }); h.db = db;
  Object.assign(h.app, { familyId: FAMILY, userId: 'synthetic-viewer', members: [ward, self], selfMember: ward }); h.role = 'caregiver';
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null; h.confirmAnswer = true; h.timeZone = 'UTC'; h.toasts = { success: [], error: [] };
  db.seed('sleep_logs', [night('synthetic-own', '2026-10-09', 'synthetic-viewer'), night('synthetic-other', '2026-10-08', 'synthetic-other'), night('synthetic-self-other', '2026-10-07', 'synthetic-other', self.id)]);
  db.seed('sleep_checkins', [{ id: 'synthetic-checkin-own', member_id: ward.id, checkin_date: '2026-10-09', created_by: 'synthetic-viewer' }, { id: 'synthetic-checkin-other', member_id: ward.id, checkin_date: '2026-10-08', created_by: 'synthetic-other' }]);
  db.seed('bedtime_routines', [{ id: 'synthetic-routine', member_id: ward.id, name: 'Synthetic shared bedtime plan', steps: ['Synthetic shared teeth step', 'Synthetic shared story step'], created_by: 'synthetic-other' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const screen = () => render(h.hooks, createElement(SleepModule));
const routineEdit = () => t('dialogTitle.editRoutine');
const routineRetire = () => t('sleep.retireRoutine');
const count = (tree: ReactNode, name: string) => allByName(tree, name).length;
function partialRecord(tree: ReactNode) {
  expect(has(tree, t('sleepModule.onlyTheNightsYouLogged', { name: ward.display_name }))).toBe(true);
  expect(count(tree, t('sleep.deleteNight', { date: '2026-10-09' }))).toBe(1);
  expect(count(tree, t('sleep.deleteNight', { date: '2026-10-08' }))).toBe(0);
  expect(has(tree, t('sleep.lastNight'))).toBe(false); expect(has(tree, t('sleep.thisWeeksProgramFor'))).toBe(false); expect(has(tree, t('sleep.whatYourOwnNightsSay'))).toBe(false);
}
describe('a shared bedtime plan remains usable beside a partial sleep record', () => {
  it.each(['caregiver', 'teen', 'child', 'guest'])('%s retains the existing shared plan and controls while seeing only authored ward nights', role => {
    h.role = role; const tree = screen(); partialRecord(tree);
    expect(has(tree, 'Synthetic shared bedtime plan')).toBe(true); expect(has(tree, 'Synthetic shared teeth step')).toBe(true);
    expect(count(tree, routineEdit())).toBe(1); expect(count(tree, routineRetire())).toBe(1);
  });
  it.each(['parent', 'adult'])('%s retains the whole record, summary, program and original routine controls', role => {
    h.role = role; const tree = screen(); expect(has(tree, t('sleep.lastNight'))).toBe(true); expect(has(tree, t('sleep.thisWeeksProgramFor'))).toBe(true);
    expect(has(tree, t('sleepModule.onlyTheNightsYouLogged', { name: ward.display_name }))).toBe(false); expect(count(tree, t('sleep.deleteNight', { date: '2026-10-08' }))).toBe(1); expect(count(tree, routineEdit())).toBe(1);
  });
  it.each(['caregiver', 'teen', 'child', 'guest'])('%s retains full summaries for their actual own member record', role => {
    h.role = role; h.app.selfMember = self; const tree = screen(); expect(has(tree, t('sleep.lastNight'))).toBe(true); expect(has(tree, t('sleep.thisWeeksProgramFor'))).toBe(true);
    expect(count(tree, t('sleep.deleteNight', { date: '2026-10-07' }))).toBe(1); expect(count(tree, t('sleep.deleteNight', { date: '2026-10-09' }))).toBe(0);
  });
  it('a manager becoming a caregiver hides the ward program immediately but keeps the shared routine', () => {
    h.role = 'parent'; expect(has(screen(), t('sleep.thisWeeksProgramFor'))).toBe(true); h.role = 'caregiver'; const tree = screen(); partialRecord(tree); expect(count(tree, routineEdit())).toBe(1);
  });
  it('changing the selected member shows only that member routine while respecting own-record scope', async () => {
    db.table('bedtime_routines').splice(0); db.seed('bedtime_routines', [{ id: 'synthetic-routine', member_id: ward.id, name: 'Synthetic ward plan' }, { id: 'synthetic-self-routine', member_id: self.id, name: 'Synthetic own plan' }]);
    const before = screen(); expect(has(before, 'Synthetic ward plan')).toBe(true); expect(has(before, 'Synthetic own plan')).toBe(false);
    await click(byName(before, /^Synthetic caregiver/, 'button')); const after = screen(); expect(has(after, 'Synthetic own plan')).toBe(true); expect(has(after, 'Synthetic ward plan')).toBe(false); expect(has(after, t('sleep.thisWeeksProgramFor'))).toBe(true);
  });
  it('an empty authored history remains honestly limited with a routine, not a fabricated full program', () => {
    db.table('sleep_logs').splice(0); db.table('sleep_checkins').splice(0); const tree = screen(); expect(has(tree, t('sleep.noNightsLogged'))).toBe(true); expect(has(tree, t('sleep.thisWeeksProgramFor'))).toBe(false); expect(has(tree, 'Synthetic shared bedtime plan')).toBe(true);
  });
  it('an absent routine still offers the existing setup action alongside a limited record', () => {
    db.table('bedtime_routines').splice(0); const tree = screen(); partialRecord(tree); expect(has(tree, t('sleep.noRoutineYetFor'))).toBe(true); expect(count(tree, t('sleep.setOneUp'))).toBe(1); expect(count(tree, routineRetire())).toBe(0);
  });
  it('a caregiver can open and save the existing create form for a ward with unchanged family/author payload', async () => {
    db.table('bedtime_routines').splice(0); await click(byName(screen(), t('sleep.setOneUp'))); await submit(form(screen()), { name: 'Synthetic new ward plan', steps: 'Synthetic teeth\nSynthetic story' });
    const saved = db.table('bedtime_routines')[0]; expect(saved.family_id).toBe(FAMILY); expect(saved.member_id).toBe(ward.id); expect(saved.created_by).toBe('synthetic-viewer'); expect(saved.steps).toEqual(['Synthetic teeth', 'Synthetic story']); expect(h.toasts.success).toContain(t('sleepModule.routineSaved'));
  });
  it('a caregiver can open and save an existing ward plan without changing its original author', async () => {
    await click(byName(screen(), routineEdit())); await submit(form(screen()), { name: 'Synthetic edited ward plan' }); const saved = db.table('bedtime_routines')[0]; expect(saved.name).toBe('Synthetic edited ward plan'); expect(saved.created_by).toBe('synthetic-other'); expect(saved.member_id).toBe(ward.id); expect(h.toasts.success).toContain(t('sleepModule.routineSaved'));
  });
  it('declining the original retire confirmation performs no write or success toast', async () => {
    h.confirmAnswer = false; await click(byName(screen(), routineRetire())); expect(db.table('bedtime_routines')[0].is_active).toBe(true); expect(h.calls).toHaveLength(0); expect(h.toasts.success).toHaveLength(0);
  });
  it('a filtered-out retire remains visibly unsaved instead of reporting success', async () => {
    const tree = screen(); db.table('bedtime_routines').splice(0); await click(byName(tree, routineRetire())); expect(h.toasts.error).toContain(t('errors.thatChangeWasNotSaved')); expect(h.toasts.success).toHaveLength(0);
  });
  it('a refused retire preserves the routine and reports the original database error', async () => {
    h.fault = table => table === 'bedtime_routines' ? { message: 'Synthetic retire refused' } : null; await click(byName(screen(), routineRetire())); expect(db.table('bedtime_routines')[0].is_active).toBe(true); expect(h.toasts.error.length).toBe(1); expect(h.toasts.success).toHaveLength(0);
  });
  it('the confirmed retire uses the unchanged update/id/select handler and reports its existing result', async () => {
    await click(byName(screen(), routineRetire())); expect(db.table('bedtime_routines')[0].is_active).toBe(false); expect(h.calls).toEqual([{ table: 'bedtime_routines', calls: ['update', 'eq', 'select'] }]); expect(h.toasts.success).toContain(t('sleepModule.routineRetired'));
  });
  it('a failed sleep-source read keeps the existing error state and never opens routine controls', () => {
    h.readErrors.sleep_logs = 'Synthetic sleep read refused'; const tree = screen(); expect(has(tree, t('sleepModule.couldNotLoadSleepData'))).toBe(true); expect(count(tree, routineEdit())).toBe(0); expect(count(tree, routineRetire())).toBe(0);
  });
  it('an edit that matches no stored row still reports unsaved without success', async () => {
    await click(byName(screen(), routineEdit())); const current = form(screen()); db.table('bedtime_routines').splice(0); await submit(current, { name: 'Synthetic unsaved edit' }); expect(h.toasts.error).toContain(t('errors.thatChangeWasNotSaved')); expect(h.toasts.success).toHaveLength(0);
  });
  it('a refused routine edit keeps the existing row and failure toast', async () => {
    await click(byName(screen(), routineEdit())); h.fault = table => table === 'bedtime_routines' ? { message: 'Synthetic routine edit refused' } : null; await submit(form(screen()), { name: 'Synthetic refused edit' }); expect(db.table('bedtime_routines')[0].name).toBe('Synthetic shared bedtime plan'); expect(h.toasts.error.length).toBe(1); expect(h.toasts.success).toHaveLength(0);
  });
});
