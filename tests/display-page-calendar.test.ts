import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { DisplayData } from '@/components/display/display-grid';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { completeReminder, createReminder, snoozeReminder } from '@/lib/services/reminders';
import { nowAndNext } from '@/lib/display/ambient';
import Page from '@/app/(app)/display/page';

const state = vi.hoisted(() => ({ db: null as unknown, timezone: 'UTC' as unknown, failServer: false, viewer: { role: 'child', memberId: 'member-1' } }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: state.viewer.role, member: { id: state.viewer.memberId }, family: { name: 'Fixture family', timezone: state.timezone } } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => { if (state.failServer) throw new Error('Fixture offline'); return state.db; } }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default' }) }));
vi.mock('next/navigation', () => ({ unstable_rethrow: () => {} }));
vi.mock('@/components/display/auto-refresh', () => ({ AutoRefresh: () => null }));
vi.mock('@/components/display/display-shell-client', () => ({ DisplayShellClient: () => null }));

// Every tile's read reported, the meal, grocery and chore reads included (H19),
// and the members (birthdays) and notes reads (U1): a failed read there is
// "unavailable", never an empty kitchen.
const ALL_LOADED = { events: 'ok', upcoming: 'ok', monthEvents: 'ok', reminders: 'ok', meals: 'ok', grocery: 'ok', chores: 'ok', members: 'ok', notes: 'ok' };
const iso = (value: string) => new Date(value).toISOString();
const event = (id: string, start: string, end: string | null, fields: Row = {}): Row => ({
  id, family_id: 'family-1', title: id, starts_at: iso(start), ends_at: end ? iso(end) : null,
  all_day: false, location: null, assignee_id: null, ...fields,
});

function fixture() {
  const db = createInMemorySupabase<SupabaseClient<Database>>();
  const failed = new Set<string>(), thrown = new Set<string>();
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  let calendarIndex = 0;
  const boundary = { from(table: string) {
    // Each calendar window is now two reads issued together — the one-offs and
    // the series (lib/calendar/occurrences.ts) — so a window owns two
    // consecutive calendar_events calls, in the page's order of windows.
    let kind = table === 'calendar_events' ? ['events', 'events', 'upcoming', 'upcoming', 'monthEvents', 'monthEvents'][calendarIndex++ % 6]
      : table === 'family_reminders' ? 'reminders' : table;
    const target = db.from(table);
    const proxy: typeof target = new Proxy(target, { get(object, property) {
      if (property === 'then') return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
        if (thrown.has(kind)) return Promise.reject(new Error('Fixture connection failure')).then(resolve, reject);
        if (failed.has(kind)) return Promise.resolve({ data: null, count: null, error: { message: 'Fixture read failed' } }).then(resolve, reject);
        return object.then(resolve, reject);
      };
      const value = Reflect.get(object, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if ((table === 'family_reminders' || table === 'reminders') && property === 'select'
          && args[0] === 'id, family_id, autopilot_origin, autopilot_card_id') kind = `${table}:origins`;
        calls.push({ table, method: String(property), args });
        const result = Reflect.apply(value, object, args);
        return result === object ? proxy : result;
      };
    } });
    return proxy;
  } };
  state.db = boundary;
  const read = async () => {
    calendarIndex = 0;
    const node = await Page();
    if (vi.mocked(console.error).mock.calls.some(call => String(call[0]).includes('fatal load error')) && !state.failServer) {
      throw vi.mocked(console.error).mock.calls.find(call => String(call[0]).includes('fatal load error'))![1];
    }
    function find(input: ReactNode): DisplayData | undefined {
      if (Array.isArray(input)) return input.map(find).find(Boolean);
      if (!input || typeof input !== 'object' || !('props' in input)) return undefined;
      const props = (input as ReactElement<{ data?: DisplayData; children?: ReactNode }>).props;
      return props.data ?? find(props.children);
    }
    const data = find(node);
    if (!data) throw new Error('Page did not return DisplayShellClient data');
    return data;
  };
  return { db, failed, thrown, calls, read };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T02:00:00Z'));
  state.timezone = 'UTC'; state.failServer = false;
  state.viewer = { role: 'child', memberId: 'member-1' };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('actual kitchen page family-calendar loading', () => {
  it('uses the family day for timed/all-day events, meals, handled count and calendar marks', async () => {
    state.timezone = 'America/Los_Angeles';
    const f = fixture();
    f.db.seed('calendar_events', [
      event('all-day', '2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z', { all_day: true }),
      event('evening', '2026-09-11T23:00:00Z', '2026-09-12T00:00:00Z'),
      event('positive', '2026-09-12T01:00:00Z', '2026-09-12T03:00:00Z'),
      event('tomorrow', '2026-09-12T08:00:00Z', '2026-09-12T09:00:00Z'),
      event('other-family', '2026-09-11T23:00:00Z', '2026-09-12T00:00:00Z', { family_id: 'other' }),
    ]);
    f.db.seed('meal_plans', [{ family_id: 'family-1', plan_date: '2026-09-11', meal_id: 'meal', meal_type: 'dinner' }]);
    f.db.seed('meals', [{ id: 'meal', name: 'Family dinner' }]);
    f.db.seed('family_automation_runs', [
      { id: 'run-1', family_id: 'family-1', state: 'completed', completed_at: iso('2026-09-11T23:00:00Z'), summary: 'Done one' },
      { id: 'run-2', family_id: 'family-1', state: 'completed', completed_at: iso('2026-09-12T01:00:00Z'), summary: 'Done two' },
      { id: 'old', family_id: 'family-1', state: 'completed', completed_at: iso('2026-09-11T06:00:00Z'), summary: 'Previous day' },
    ]);
    const data = await f.read();
    expect(data).toMatchObject({ timezone: 'America/Los_Angeles', dayKey: '2026-09-11', timezoneFallback: false, calendar: { year: 2026, month: 8, today: 11 } });
    expect(data.events.map(item => item.id)).toEqual(['all-day', 'evening', 'positive']);
    expect(data.events.find(item => item.id === 'positive')?.ends_at).toBe(iso('2026-09-12T03:00:00Z'));
    expect(data.upcoming.map(item => item.id)).toEqual(['tomorrow']);
    expect(data.calendar.eventDays).toEqual([11, 12]);
    expect(data.meals).toEqual([{ type: 'dinner', name: 'Family dinner' }]);
    expect(data.handled).toMatchObject({ status: 'ok', count: 2 });
    expect(data.loadStatus).toEqual(ALL_LOADED);
  });

  it('shows this week\'s occurrence of a weekly series on today, next week\'s under upcoming, and marks every week of the month', async () => {
    // Saturdays 14:00Z since 15 August; today is Saturday 12 September (UTC).
    const f = fixture();
    f.db.seed('calendar_events', [event('practice', '2026-08-15T14:00:00Z', '2026-08-15T15:00:00Z', { recurrence: 'weekly', recurrence_until: null })]);
    const data = await f.read();
    expect(data.events.map(item => [item.id, item.starts_at])).toEqual([['practice', iso('2026-09-12T14:00:00Z')]]);
    expect(data.upcoming.map(item => item.starts_at)).toEqual([iso('2026-09-19T14:00:00Z')]);
    expect(data.calendar.eventDays).toEqual([5, 12, 19, 26]);
    expect(data.loadStatus).toEqual(ALL_LOADED);
  });

  it('includes ongoing overnight events, excludes ended/day-end boundaries and uses actual ends for occupancy', async () => {
    vi.setSystemTime(new Date('2026-09-12T00:30:00Z'));
    const f = fixture();
    f.db.seed('calendar_events', [
      event('overnight', '2026-09-11T23:30:00Z', '2026-09-12T02:00:00Z'),
      event('ended-at-midnight', '2026-09-11T23:00:00Z', '2026-09-12T00:00:00Z'),
      event('next-midnight', '2026-09-13T00:00:00Z', '2026-09-13T01:00:00Z'),
      event('same-day', '2026-09-12T03:00:00Z', '2026-09-12T04:00:00Z'),
      event('unknown', '2026-09-12T00:15:00Z', null),
    ]);
    const data = await f.read();
    expect(data.events.map(item => item.id)).toEqual(['overnight', 'unknown', 'same-day']);
    expect(nowAndNext(data.events, new Date()).current?.id).toBe('overnight');
    expect(nowAndNext(data.events, new Date()).next?.id).toBe('same-day');
  });

  it.each([
    ['2026-03-08T16:00:00Z', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01T16:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
  ])('uses DST-correct page reads at %s', async (now, start, end) => {
    state.timezone = 'America/New_York'; vi.setSystemTime(new Date(now));
    const f = fixture();
    f.db.seed('calendar_events', [event('start', start, new Date(Date.parse(start) + 60_000).toISOString()), event('end', end, new Date(Date.parse(end) + 60_000).toISOString())]);
    expect((await f.read()).events.map(item => item.id)).toEqual(['start']);
    expect(f.calls).toEqual(expect.arrayContaining([
      { table: 'family_automation_runs', method: 'gte', args: ['completed_at', iso(start)] },
      { table: 'family_automation_runs', method: 'lt', args: ['completed_at', iso(end)] },
    ]));
  });

  it('keeps family year/month/birthday boundaries and all-day date spans', async () => {
    state.timezone = 'Pacific/Auckland'; vi.setSystemTime(new Date('2026-12-31T12:00:00Z'));
    const f = fixture();
    f.db.seed('family_members', [{ id: 'member', family_id: 'family-1', is_active: true, birthday: '2001-01-01', display_name: 'Ada' }]);
    f.db.seed('calendar_events', [event('holiday', '2026-12-31T00:00:00Z', '2027-01-03T00:00:00Z', { all_day: true })]);
    const data = await f.read();
    expect(data).toMatchObject({ dayKey: '2027-01-01', calendar: { year: 2027, month: 0, today: 1, eventDays: [1, 2] } });
    expect(data.events.map(item => item.id)).toEqual(['holiday']);
    expect(data.birthdays).toEqual([{ name: 'Ada', date: 'Jan 1' }]);
    expect(nowAndNext([...data.events, ...data.upcoming], new Date())).toEqual({ current: null, next: null });
  });

  it.each(['events', 'upcoming', 'monthEvents', 'reminders'])('keeps %s unavailable distinct from successful empty and recovered populated data', async kind => {
    const f = fixture();
    f.failed.add(kind);
    expect((await f.read()).loadStatus).toEqual({ ...ALL_LOADED, [kind]: 'error' });
    f.failed.clear();
    const empty = await f.read();
    expect(empty.loadStatus).toEqual(ALL_LOADED);
    expect(empty.events).toEqual([]); expect(empty.reminders).toEqual([]);
    f.db.seed('calendar_events', [event('today', '2026-09-12T03:00:00Z', '2026-09-12T04:00:00Z'), event('tomorrow', '2026-09-13T03:00:00Z', '2026-09-13T04:00:00Z')]);
    f.db.seed('family_reminders', [{ id: 'reminder', family_id: 'family-1', title: 'Reminder', remind_at: iso('2026-09-12T05:00:00Z'), status: 'active', autopilot_origin: false, autopilot_card_id: null }]);
    const recovered = await f.read();
    expect(recovered.loadStatus).toEqual(empty.loadStatus);
    expect(recovered.events).toHaveLength(1); expect(recovered.upcoming).toHaveLength(1); expect(recovered.reminders).toHaveLength(1);
    expect(recovered.calendar.eventDays).toEqual([12, 13]);
  });

  it('discloses fallback timezone and preserves error status on thrown/fatal loads', async () => {
    state.timezone = 'Invalid/Zone';
    const f = fixture(); f.thrown.add('events');
    expect(await f.read()).toMatchObject({ timezone: 'UTC', timezoneFallback: true, loadStatus: { events: 'error', upcoming: 'ok' } });
    state.failServer = true;
    expect(await f.read()).toMatchObject({ timezone: 'UTC', dayKey: '2026-09-12', loadStatus: { events: 'error', upcoming: 'error', monthEvents: 'error', reminders: 'error' } });
  });

  it.each([
    ['family_reminders:origins', 'failed'], ['reminders:origins', 'failed'], ['autopilot_suggestions', 'failed'],
    ['family_reminders:origins', 'thrown'], ['reminders:origins', 'thrown'], ['autopilot_suggestions', 'thrown'],
  ] as const)('marks a %s %s lookup unavailable and recovers the same readers without legacy content', async (dependency, failure) => {
    const f = fixture();
    f.db.seed('autopilot_suggestions', [{
      id: 'insurance-card', family_id: 'family-1', kind: 'insurance', source_kind: 'family_insurance_policies',
      source_id: 'policy-1', member_id: 'member-1', action_type: 'create_reminder', title: 'Private policy',
    }]);
    f.db.seed('family_reminders', [
      { id: 'manual', family_id: 'family-1', title: 'Bins out', status: 'active', remind_at: iso('2026-09-12T03:00:00Z'), autopilot_origin: false, autopilot_card_id: null },
      { id: 'policy', family_id: 'family-1', title: 'Renew private policy', status: 'active', remind_at: iso('2026-09-12T04:00:00Z'), autopilot_origin: true, autopilot_card_id: 'insurance-card' },
      { id: 'foreign', family_id: 'family-other', title: 'Another family', status: 'active', remind_at: iso('2026-09-12T03:00:00Z'), autopilot_origin: false, autopilot_card_id: null },
    ]);
    f.db.seed('reminders', [{ id: 'legacy', family_id: 'family-1', title: 'Legacy content must not appear', remind_at: iso('2026-09-12T02:00:00Z'), is_done: false, autopilot_origin: false, autopilot_card_id: null }]);
    for (const [role, memberId, ids] of [
      ['parent', 'manager', ['manual', 'policy']],
      ['child', 'member-1', ['manual', 'policy']],
      ['child', 'other-child', ['manual']],
      ['guest', 'guest', ['manual']],
    ] as const) {
      state.viewer = { role, memberId };
      const healthy = await f.read();
      expect(healthy.loadStatus, role).toEqual(ALL_LOADED);
      expect(healthy.reminders.map(row => row.id), role).toEqual(ids);

      f[failure].add(dependency);
      const unavailable = await f.read();
      expect(unavailable.loadStatus, role).toEqual({ ...ALL_LOADED, reminders: 'error' });
      expect(unavailable.reminders, role).toEqual([]);
      f[failure].clear();

      const recovered = await f.read();
      expect(recovered.loadStatus, role).toEqual(ALL_LOADED);
      expect(recovered.reminders, role).toEqual(healthy.reminders);
    }
    expect(console.error).toHaveBeenCalledWith('[display] autopilot reminder cards read failed', expect.anything());
  });

  it('keeps successful empty and trusted manual tiles healthy without unused card lookups', async () => {
    const f = fixture();
    for (const dependency of ['family_reminders:origins', 'reminders:origins', 'autopilot_suggestions']) f.failed.add(dependency);
    const empty = await f.read();
    expect(empty.loadStatus).toEqual(ALL_LOADED);
    expect(empty.reminders).toEqual([]);
    expect(f.calls.some(call => call.table === 'reminders' || call.table === 'autopilot_suggestions')).toBe(false);

    f.failed.delete('family_reminders:origins'); f.failed.delete('reminders:origins');
    f.db.seed('family_reminders', [{ id: 'manual', family_id: 'family-1', title: 'Bins out', status: 'active', remind_at: iso('2026-09-12T03:00:00Z'), autopilot_origin: false, autopilot_card_id: null }]);
    const manual = await f.read();
    expect(manual.loadStatus).toEqual(ALL_LOADED);
    expect(manual.reminders.map(row => row.id)).toEqual(['manual']);
    expect(f.calls.some(call => call.table === 'autopilot_suggestions')).toBe(false);
  });

  it('reads actual canonical reminder creation, effective snooze and completion; legacy reads supply only trusted origins', async () => {
    const f = fixture();
    const scope: ServiceScope = { db: f.db, familyId: 'family-1', userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date(), requestId: 'fixture-request' };
    f.db.seed('reminders', [{ id: 'legacy', family_id: 'family-1', title: 'Legacy', remind_at: iso('2026-09-12T02:00:00Z'), is_done: false, autopilot_origin: false, autopilot_card_id: null }]);
    const created = await createReminder(scope, { title: 'Canonical reminder', remindAt: '2026-09-12T02:10:00Z' });
    expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error);
    expect((await f.read()).reminders).toEqual([{ id: created.data.id, title: 'Canonical reminder', remind_at: iso('2026-09-12T02:10:00Z') }]);
    expect((await snoozeReminder(scope, created.data.id, 30)).ok).toBe(true);
    expect((await f.read()).reminders[0].remind_at).toBe(iso('2026-09-12T02:30:00Z'));
    expect((await completeReminder(scope, created.data.id)).ok).toBe(true);
    expect((await f.read()).reminders).toEqual([]);
    // The origin schema adds authorization reads of both reminder tables.
    // No legacy title/due-date content may become a source for this tile.
    const legacyReads = f.calls.filter(call => call.table === 'reminders');
    expect(legacyReads.length).toBeGreaterThan(0);
    for (let start = 0; start < legacyReads.length; start += 4) {
      expect(legacyReads.slice(start, start + 4)).toEqual([
        { table: 'reminders', method: 'select', args: ['id, family_id, autopilot_origin, autopilot_card_id'] },
        { table: 'reminders', method: 'eq', args: ['family_id', 'family-1'] },
        { table: 'reminders', method: 'order', args: ['id'] },
        { table: 'reminders', method: 'range', args: [expect.any(Number), expect.any(Number)] },
      ]);
    }
  });

  it('excludes completed/dismissed/null-date and beyond-horizon snoozed reminders and sorts by effective due time', async () => {
    const f = fixture();
    f.db.seed('family_reminders', [
      { id: 'active', family_id: 'family-1', title: 'Active', status: 'active', remind_at: iso('2026-09-12T04:00:00Z') },
      { id: 'snoozed', family_id: 'family-1', title: 'Snoozed', status: 'snoozed', remind_at: iso('2026-09-12T01:00:00Z'), snoozed_until: iso('2026-09-12T05:00:00Z') },
      { id: 'future', family_id: 'family-1', title: 'Future', status: 'snoozed', remind_at: iso('2026-09-12T01:00:00Z'), snoozed_until: iso('2026-10-12T05:00:00Z') },
      ...['completed', 'dismissed'].map(status => ({ id: status, family_id: 'family-1', title: status, status, remind_at: iso('2026-09-12T01:00:00Z') })),
      { id: 'null', family_id: 'family-1', title: 'No date', status: 'active', remind_at: null },
      { id: 'other', family_id: 'family-other', title: 'Other', status: 'active', remind_at: iso('2026-09-12T01:00:00Z') },
    ].map(row => ({ ...row, autopilot_origin: false, autopilot_card_id: null })));
    expect((await f.read()).reminders.map(item => item.id)).toEqual(['active', 'snoozed']);
  });
});
