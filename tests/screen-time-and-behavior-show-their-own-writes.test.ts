import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, has, nodes, render, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The Screen Time and Behavior pages read tables no realtime publication
// carries (screen_time_entries, screen_time_limits, behavior_logs are not in
// lib/realtime/published-tables.ts), so `useRealtimeQuery` opens no channel for
// them and nothing tells either page about its own writes. Neither re-read
// after one, so a parent who:
//
//   - logged 45 minutes for a child saw no entry and an unchanged "today" on
//     the child's card, and the natural second try logged the time twice;
//   - deleted an entry was told "Deleted" beside the entry still on screen;
//   - set a daily limit saw the card go on without one;
//   - logged a behaviour note saw the empty "No behavior logged yet";
//   - deleted a note kept seeing it.
//
// Driven through the REAL modules (tests/helpers/module-harness.tsx): the list
// on screen changes only when the component re-reads, exactly as the real hook
// behaves for an unpublished table.

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
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));

const { ScreenTimeModule } = await import('@/components/modules/screen-time-module');
const { BehaviorModule } = await import('@/components/modules/behavior-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({
    defaults: {
      screen_time_entries: { device: null, note: null, category: 'other' },
      behavior_logs: { note: null, points: 0, category: 'general', kind: 'positive' },
    },
  });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  h.app.members = [
    { id: 'member-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: 'kid', display_name: 'Kit', role: 'child', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  h.app.family = { id: FAMILY, name: 'Fixture family', timezone: 'UTC' };
  (h.app as Record<string, unknown>).role = 'parent';
  vi.stubGlobal('confirm', () => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const fieldsOf = (tree: ReactNode, type: string) => nodes(form(tree).props.children as ReactNode).filter((n) => n.type === type);
/** The per-member card, found by its React key (the member id). */
const cardOf = (tree: ReactNode, memberId: string) => nodes(tree).find((n) => n.key === memberId && n.type === 'div') as Node;

describe('the Screen Time page shows its own writes', () => {
  const screen = () => render(h.hooks, createElement(ScreenTimeModule));

  it('logged time is on the child\'s card and in the list at once, so nobody logs it twice', async () => {
    await click(byName(screen(), new RegExp(t('screenTime.logTime'))));
    change(fieldsOf(screen(), 'select')[0], 'kid');
    change(fieldsOf(screen(), 'input').find((n) => n.props.type === 'number') as Node, '45');
    await submit(form(screen()));

    expect(db.table('screen_time_entries').map((row) => [row.member_id, row.minutes, row.entry_date])).toEqual([['kid', 45, '2026-10-12']]);
    expect(h.toasts.error).toEqual([]);
    const after = screen();
    expect(has(after, '45m · Entertainment · Kit')).toBe(true);
    expect(has(cardOf(after, 'kid'), '45m')).toBe(true);
    expect(has(after, t('screenTime.noScreenTimeLogged'))).toBe(false);
  });

  it('a deleted entry leaves the list', async () => {
    db.seed('screen_time_entries', [{ id: 'e1', family_id: FAMILY, member_id: 'kid', entry_date: '2026-10-12', minutes: 50, category: 'gaming' }]);
    expect(has(screen(), '50m · Gaming · Kit')).toBe(true);

    await click(byName(screen(), t('screenTime.delete')));

    expect(db.table('screen_time_entries')).toEqual([]);
    expect(h.toasts.success).toContain(t('screenTimeModule.deleted'));
    expect(has(screen(), '50m · Gaming · Kit')).toBe(false);
  });

  it('a daily limit, once saved, is on the child\'s card', async () => {
    const settings = nodes(cardOf(screen(), 'kid')).find((n) => n.type === 'button' && n.props.title === t('screenTime.setDailyLimit')) as Node;
    await click(settings);
    change(fieldsOf(screen(), 'input').find((n) => n.props.type === 'number') as Node, '90');
    await submit(form(screen()));

    expect(db.table('screen_time_limits').map((row) => [row.member_id, row.daily_minutes])).toEqual([['kid', 90]]);
    expect(has(cardOf(screen(), 'kid'), 'today / 1h 30m')).toBe(true);
  });
});

describe('the Behavior page shows its own writes', () => {
  const screen = () => render(h.hooks, createElement(BehaviorModule));

  it('a logged note is in the recent log at once', async () => {
    await click(byName(screen(), new RegExp(t('behavior.logBehavior'))));
    change(fieldsOf(screen(), 'select')[0], 'kid');
    change(fieldsOf(screen(), 'textarea')[0], 'Shared the last biscuit');
    await submit(form(screen()));

    expect(db.table('behavior_logs').map((row) => [row.member_id, row.note])).toEqual([['kid', 'Shared the last biscuit']]);
    expect(h.toasts.error).toEqual([]);
    const after = screen();
    expect(has(after, 'Shared the last biscuit')).toBe(true);
    expect(has(after, t('behavior.noBehaviorLoggedYet'))).toBe(false);
  });

  it('a deleted note leaves the log', async () => {
    db.seed('behavior_logs', [{ id: 'b1', family_id: FAMILY, member_id: 'kid', kind: 'concern', category: 'respect', note: 'Slammed the door', points: 0, occurred_at: '2026-10-11T18:00:00Z', logged_by: 'user-1' }]);
    expect(has(screen(), 'Slammed the door')).toBe(true);

    await click(byName(screen(), t('behavior.delete')));

    expect(db.table('behavior_logs')).toEqual([]);
    expect(h.toasts.success).toContain(t('behaviorModule.deleted'));
    expect(has(screen(), 'Slammed the door')).toBe(false);
  });
});
