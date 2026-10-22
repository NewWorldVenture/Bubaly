import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { FAMILY, HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, form, nodes, render, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// N18 — the Sleep page's "Log last night" form, the REAL module against an
// in-memory database, for a New York family logged from a device in another
// zone (this file runs under TZ=UTC, America/Los_Angeles and Asia/Tokyo; the
// family is in none of them).
//
// The boxes were filled and read on the DEVICE's clock — `new Date(value)` and
// local getters — while the summary, consistency and adherence read bedtimes,
// and the prefill looked the night up, on the family's. A parent travelling in
// London who logged their New York child's "21:30 to 07:00" stored 21:30 in
// London, which every score then read as 16:30 at home.

const h = await vi.hoisted(async () => ({ ...(await import('./helpers/module-state')).createModuleState(), role: 'parent' }));
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

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: ReturnType<typeof createInMemorySupabase>;
const kid = { id: 'member-kid', display_name: 'Kid', user_id: null, birthday: '2016-03-01', is_active: true };
const screen = () => render(h.hooks, createElement(SleepModule));
const box = (formNode: Node, name: string) => nodes(formNode.props.children as never).find((n) => n.props.name === name)!;
const nights = () => db.table('sleep_logs').filter((row) => row.member_id === kid.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 09:00 on Wednesday 14 October in New York.
  vi.setSystemTime(new Date('2026-10-14T13:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  Object.assign(h.app, { familyId: FAMILY, userId: 'user-parent', members: [kid], selfMember: null });
  h.role = 'parent';
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null; h.confirmAnswer = true;
  h.timeZone = 'America/New_York';
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a night is logged on the family\'s clock', () => {
  it('prefills last night as the family\'s 21:30 to 07:00, and stores those instants under the family\'s day', async () => {
    await click(byName(screen(), t('sleep.logLastNight')));
    const sheet = form(screen());
    expect(box(sheet, 'bedtime').props.defaultValue).toBe('2026-10-13T21:30');
    expect(box(sheet, 'wake_time').props.defaultValue).toBe('2026-10-14T07:00');

    await submit(sheet);
    expect(h.toasts.error).toEqual([]);
    expect(nights()).toHaveLength(1);
    expect(nights()[0]).toMatchObject({
      sleep_date: '2026-10-14',
      bedtime: '2026-10-14T01:30:00.000Z', // 21:30 EDT
      wake_time: '2026-10-14T11:00:00.000Z', // 07:00 EDT
      duration_min: 570,
    });
  });

  it('a typed time means the family\'s wall clock, wherever the phone is', async () => {
    await click(byName(screen(), t('sleep.logLastNight')));
    await submit(form(screen()), { bedtime: '2026-10-13T22:15', wake_time: '2026-10-14T06:45' });
    expect(nights()[0]).toMatchObject({ bedtime: '2026-10-14T02:15:00.000Z', wake_time: '2026-10-14T10:45:00.000Z', sleep_date: '2026-10-14' });
  });

  it('editing tonight\'s entry shows the times the family logged, not the phone\'s reading of them', async () => {
    db.seed('sleep_logs', [{
      id: 'night-1', family_id: FAMILY, member_id: kid.id, sleep_date: '2026-10-14',
      bedtime: '2026-10-14T01:30:00.000Z', wake_time: '2026-10-14T11:00:00.000Z', duration_min: 570,
      quality: 4, awakenings: 0, source: 'manual', notes: null, created_by: 'user-parent',
    }]);
    await click(byName(screen(), t('sleep.logLastNight')));
    const sheet = form(screen());
    expect(box(sheet, 'bedtime').props.defaultValue).toBe('2026-10-13T21:30');
    expect(box(sheet, 'wake_time').props.defaultValue).toBe('2026-10-14T07:00');
    // Saved unchanged, the night stays exactly where it was.
    await submit(sheet);
    expect(nights()).toHaveLength(1);
    expect(nights()[0]).toMatchObject({ bedtime: '2026-10-14T01:30:00.000Z', wake_time: '2026-10-14T11:00:00.000Z', sleep_date: '2026-10-14' });
  });
});
