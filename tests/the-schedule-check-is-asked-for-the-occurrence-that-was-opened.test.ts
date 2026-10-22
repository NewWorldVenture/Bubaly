// The event detail's "Schedule check" asks for the OCCURRENCE the family opened.
//
// N6-T1: the action and the loader take an occurrence start and are proven to
// (tests/the-schedule-check-reads-the-occurrence-it-was-opened-on.test.ts), but
// the modal's half — passing the opened week's start down to EventScheduleInsights
// — was pinned by nothing: every test that rendered the modal mocked the check
// away, so dropping the prop put the check back on the series' first week with
// every test still green.
//
// Driven through the real Calendar module, its real detail modal and the REAL
// EventScheduleInsights (tests/helpers/module-harness.tsx), against an
// in-memory database; only the server action is replaced, by a recorder.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { click, nodes, render, settle, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const check = vi.hoisted(() => ({ calls: [] as [string, string | null][] }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
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
// Separate surfaces with their own tests; nothing here is about them. The
// schedule check itself is NOT mocked: that is the point.
vi.mock('@/components/calendar/busyness-heatmap', () => ({ BusynessHeatmap: () => null }));
vi.mock('@/components/modules/routines-panel', () => ({ RoutinesPanel: () => null }));
vi.mock('@/components/modules/find-time-modal', () => ({ FindTimeModal: () => null }));
// The real actions module, with the check's server action replaced by a
// recorder: what the modal asks for is the question, not what the loader answers.
vi.mock('@/app/(app)/dashboard/calendar/actions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  eventScheduleInsightsAction: async (eventId: string, occurrenceStartsAt?: string | null) => {
    check.calls.push([eventId, occurrenceStartsAt ?? null]);
    return { ok: true, insights: [], leaveBy: null };
  },
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.app.userId },
    active: { familyId: h.app.familyId, role: 'parent', member: { id: 'member-1' }, family: { name: 'Fixture family', timezone: 'America/New_York' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { CalendarModule } = await import('@/components/modules/calendar-module');

const FAMILY = h.app.familyId;
const SERIES = '30000000-0000-4000-8000-000000000001';
const ONE_OFF = '30000000-0000-4000-8000-000000000002';
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

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: { calendar_events: { idempotency_key: null } } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  h.timeZone = 'America/New_York';
  check.calls = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T16:00:00.000Z'));
  const target = Object.assign(new EventTarget(), { location: { search: '', pathname: '/dashboard/calendar' }, history: { replaceState: () => {} } });
  vi.stubGlobal('window', target);
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ connected: false, configured: false }) })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('calendar_events', [
    // Weekly, 18:00 New York, first week Tuesday 1 September.
    event(SERIES, { title: 'Practice', starts_at: '2026-09-01T22:00:00.000Z', ends_at: '2026-09-01T23:00:00.000Z', recurrence: 'weekly' }),
    event(ONE_OFF, { title: 'Dentist' }),
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('opening an occurrence asks the Schedule check about THAT occurrence (N6-T1)', () => {
  it('week seven of a series is checked on 13 October, not on the stored first week', async () => {
    const tree = await screen();
    await click(chip(tree, '2026-10-13T22:00'));
    again();
    await settle();
    expect(check.calls).toContainEqual([SERIES, '2026-10-13T22:00:00.000Z']);
    expect(check.calls.map(([, at]) => at)).not.toContain(null);
    expect(check.calls.map(([, at]) => at)).not.toContain('2026-09-01T22:00:00.000Z');
  });

  it('a one-off is checked on its own start', async () => {
    const tree = await screen();
    await click(chip(tree, '2026-10-15T19:00'));
    again();
    await settle();
    expect(check.calls).toContainEqual([ONE_OFF, '2026-10-15T19:00:00.000Z']);
  });
});
