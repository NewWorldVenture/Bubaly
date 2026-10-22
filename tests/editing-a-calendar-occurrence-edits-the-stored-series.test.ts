// The calendar's Edit opens the STORED row, says what it edits, and refuses to
// write a stale copy — driven through the real Calendar module, its real detail
// modal and editor, the real server action and service, against an in-memory
// database.
//
//   N1  — A weekly series is stored once, at its first week. Edit on any later
//         week opened the expanded clone (that week's start), and Save wrote
//         that start onto the series row: every earlier week vanished, even
//         when only the title changed.
//   N5  — An all-day row is a DATE at its UTC midnight. The editor filled
//         datetime-local boxes on the family's clock, so in New York Oct 24
//         showed as "Oct 23, 20:00", and typing the 25th saved the 26th.
//   N9  — The editor sends every field on Save. A modal opened before another
//         member moved the event wrote its older time, place and notes back
//         over theirs, with no error.
//   N20 — An RSVP is one row per member per EVENT, and a series is one event:
//         an answer on one week is an answer for every week, and nothing said so.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, form, nodes, render, settle, submit, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const auth = vi.hoisted(() => ({ timezone: 'America/New_York' }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
// The harness's fetched query, with `refresh` as stable as the real hook's
// (a useCallback): the calendar keys an effect on it.
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const base = (await import('./helpers/module-harness')).fetchedQueryModule(h);
  const latest = new Map<string, () => Promise<void>>();
  const stable = new Map<string, () => Promise<void>>();
  return {
    useRealtimeQuery: (opts: Parameters<typeof base.useRealtimeQuery>[0] & { deps?: unknown[] }) => {
      const result = base.useRealtimeQuery(opts);
      const key = `${opts.table}:${JSON.stringify(opts.deps ?? [])}`;
      latest.set(key, result.refresh);
      if (!stable.has(key)) stable.set(key, () => latest.get(key)!());
      return { ...result, refresh: stable.get(key)! };
    },
  };
});
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
// Separate surfaces with their own tests; nothing here is about them.
vi.mock('@/components/calendar/busyness-heatmap', () => ({ BusynessHeatmap: () => null }));
vi.mock('@/components/calendar/event-detail', () => ({ EventScheduleInsights: () => null }));
vi.mock('@/components/modules/routines-panel', () => ({ RoutinesPanel: () => null }));
vi.mock('@/components/modules/find-time-modal', () => ({ FindTimeModal: () => null }));
// The real server action, on the session the harness's family holds.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.app.userId },
    active: { familyId: h.app.familyId, role: 'parent', member: { id: 'member-1' }, family: { name: 'Fixture family', timezone: auth.timezone } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { CalendarModule } = await import('@/components/modules/calendar-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
let db: InMemorySupabase;

function event(id: string, extra: Record<string, unknown>) {
  return {
    id, family_id: FAMILY, title: 'Event', description: null, location: null, category: 'general',
    starts_at: '2026-10-15T19:00:00.000Z', ends_at: '2026-10-15T20:00:00.000Z', all_day: false,
    recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
    created_by: null, onboarding_key: null, idempotency_key: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z', ...extra,
  };
}
const row = (id: string) => db.table('calendar_events').find((r) => r.id === id)!;

async function screen(): Promise<ReactNode> {
  let tree = render(h.hooks, createElement(CalendarModule));
  for (let i = 0; i < 6; i++) { await settle(); tree = render(h.hooks, createElement(CalendarModule)); }
  return tree;
}
const again = () => render(h.hooks, createElement(CalendarModule));
/** The grid chip of one occurrence, by the start its occurrence key names. */
function chip(tree: ReactNode, start: string): Node {
  const found = nodes(tree).find((n) => n.props.role === 'button' && typeof n.props['data-occurrence-key'] === 'string'
    && (n.props['data-occurrence-key'] as string).includes(start));
  expect(found, `a chip for the occurrence at ${start}`).toBeDefined();
  return found!;
}
const field = (tree: ReactNode, name: string) => nodes(form(tree)).find((n) => n.props.name === name)!;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: { calendar_events: { idempotency_key: null } } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  h.timeZone = 'America/New_York';
  auth.timezone = 'America/New_York';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T16:00:00.000Z'));
  const target = Object.assign(new EventTarget(), { location: { search: '', pathname: '/dashboard/calendar' }, history: { replaceState: () => {} } });
  vi.stubGlobal('window', target);
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ connected: false, configured: false }) })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Edit on a later week of a series edits the series as stored (N1)', () => {
  const SERIES = '30000000-0000-4000-8000-000000000001';
  beforeEach(() => {
    // Weekly, 18:00 New York, first week Tuesday 1 September.
    db.seed('calendar_events', [event(SERIES, {
      title: 'Practice', starts_at: '2026-09-01T22:00:00.000Z', ends_at: '2026-09-01T23:00:00.000Z', recurrence: 'weekly',
    })]);
  });

  it('says an RSVP on one week is the series\' RSVP (N20)', async () => {
    let tree: ReactNode = await screen();
    await click(chip(tree, '2026-10-13T22:00'));
    tree = again();
    expect(text(tree)).toContain(t('eventDetailModal.rsvpAppliesToEverySeriesOccurrence'));
  });

  it('opens the series row, not the clicked week, and a title-only Save leaves every week in place', async () => {
    let tree: ReactNode = await screen();
    await click(chip(tree, '2026-10-13T22:00'));
    tree = again();
    await click(byName(tree, t('eventDetailModal.edit')));
    tree = again();
    // The boxes show the SERIES' own first week, and the modal says it edits the series.
    expect(field(tree, 'starts_at').props.defaultValue).toBe('2026-09-01T18:00');
    expect(text(form(tree))).toContain(t('calendarModule.editingWholeSeries'));

    await submit(form(tree), { title: 'Practice (gym B)' });
    expect(h.toasts.error).toEqual([]);
    expect(row(SERIES)).toMatchObject({ title: 'Practice (gym B)', recurrence: 'weekly' });
    expect(Date.parse(String(row(SERIES).starts_at))).toBe(Date.parse('2026-09-01T22:00:00.000Z'));
    expect(Date.parse(String(row(SERIES).ends_at))).toBe(Date.parse('2026-09-01T23:00:00.000Z'));
  });

  it('a one-off event says nothing about a series', async () => {
    db.seed('calendar_events', [event('30000000-0000-4000-8000-000000000002', { title: 'Dentist' })]);
    let tree: ReactNode = await screen();
    await click(chip(tree, '2026-10-15T19:00'));
    tree = again();
    expect(text(tree)).toContain('Dentist');
    expect(text(tree)).not.toContain(t('eventDetailModal.rsvpAppliesToEverySeriesOccurrence'));
  });
});

describe('an all-day event is edited as dates (N5)', () => {
  const DAY = '30000000-0000-4000-8000-000000000003';
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-10-22T16:00:00.000Z'));
    db.seed('calendar_events', [event(DAY, {
      title: 'Book fair', starts_at: '2026-10-24T00:00:00.000Z', ends_at: '2026-10-25T00:00:00.000Z', all_day: true,
    })]);
  });

  it('shows its own date west of Greenwich, and moving it to the 25th stores the 25th', async () => {
    let tree: ReactNode = await screen();
    await click(chip(tree, '2026-10-24T00:00'));
    tree = again();
    await click(byName(tree, t('eventDetailModal.edit')));
    tree = again();
    expect(field(tree, 'starts_at').props.type).toBe('date');
    expect(field(tree, 'starts_at').props.defaultValue).toBe('2026-10-24');
    // The end box shows the LAST day; the stored end is exclusive.
    expect(field(tree, 'ends_at').props.defaultValue).toBe('2026-10-24');

    await submit(form(tree), { starts_at: '2026-10-25', ends_at: '2026-10-25' });
    expect(h.toasts.error).toEqual([]);
    expect(row(DAY)).toMatchObject({ all_day: true });
    expect(Date.parse(String(row(DAY).starts_at))).toBe(Date.parse('2026-10-25T00:00:00.000Z'));
    expect(Date.parse(String(row(DAY).ends_at))).toBe(Date.parse('2026-10-26T00:00:00.000Z'));
  });
});

describe('a Save from a modal another member has overtaken is refused (N9)', () => {
  const DENTIST = '30000000-0000-4000-8000-000000000004';
  beforeEach(() => {
    db.seed('calendar_events', [event(DENTIST, { title: 'Dentist', location: 'Room A' })]);
  });

  it('keeps the other member\'s move, place and version, and says why', async () => {
    let tree: ReactNode = await screen();
    await click(chip(tree, '2026-10-15T19:00'));
    tree = again();
    await click(byName(tree, t('eventDetailModal.edit')));
    tree = again();

    // Parent A moves the dentist an hour later and to Room B.
    const { data: moved } = await db.from('calendar_events')
      .update({ starts_at: '2026-10-15T20:00:00.000Z', ends_at: '2026-10-15T21:00:00.000Z', location: 'Room B', updated_at: '2026-10-14T15:59:00.000Z' })
      .eq('id', DENTIST).eq('family_id', FAMILY).select('id');
    expect(moved).toHaveLength(1);

    // Parent B, whose modal opened earlier, fixes a typo in the title.
    await submit(form(tree), { title: 'Dentist (Dr. Lee)' });
    expect(h.toasts.error).toEqual([t('actions.thatEventChangedSinceThisPage')]);
    expect(row(DENTIST)).toMatchObject({ title: 'Dentist', location: 'Room B', updated_at: '2026-10-14T15:59:00.000Z' });
    expect(Date.parse(String(row(DENTIST).starts_at))).toBe(Date.parse('2026-10-15T20:00:00.000Z'));
  });

  it('an untouched row still saves', async () => {
    let tree: ReactNode = await screen();
    await click(chip(tree, '2026-10-15T19:00'));
    tree = again();
    await click(byName(tree, t('eventDetailModal.edit')));
    tree = again();
    await submit(form(tree), { title: 'Dentist (Dr. Lee)' });
    expect(h.toasts.error).toEqual([]);
    expect(row(DENTIST)).toMatchObject({ title: 'Dentist (Dr. Lee)', location: 'Room A' });
  });
});
