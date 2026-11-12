// components/calendar/busyness-heatmap.tsx, rendered: its one control is the
// heading button that folds the eight-week strip away and brings it back.
//
// The real component is driven with tests/helpers/module-harness.tsx against an
// in-memory database: its own fetcher (readDisplayCalendarOccurrences) reads the
// seeded event, and the real buildHeatmap draws it. Nothing of the component is
// mocked; only the query hook, the Supabase client and the locale provider are
// the harness's.
//
// The strip is drawn unconditionally by components/modules/calendar-module.tsx
// (line 920) for whoever reaches /dashboard/calendar; it takes only a family id,
// reads no role or plan, and writes nothing, so there is no role to refuse.
import { existsSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, click, has, nodes, render, settle, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
// The real hook's `refresh` keeps its identity between renders; the strip keys
// an effect on it. Same wrapper as
// tests/the-schedule-check-is-asked-for-the-occurrence-that-was-opened.test.ts.
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const base = (await import('./helpers/module-harness')).fetchedQueryModule(h);
  const latest = new Map<string, () => Promise<void>>();
  const stable = new Map<string, () => Promise<void>>();
  return {
    useRealtimeQuery: (opts: Parameters<typeof base.useRealtimeQuery>[0]) => {
      const result = base.useRealtimeQuery(opts);
      const key = `${opts.table}:${JSON.stringify(opts.deps ?? [])}`;
      latest.set(key, result.refresh);
      if (!stable.has(key)) stable.set(key, () => latest.get(key)!());
      return { ...result, refresh: stable.get(key)! };
    },
  };
});
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);

const { BusynessHeatmap } = await import('@/components/calendar/busyness-heatmap');

const FAMILY = h.app.familyId;
const EVENT = '31000000-0000-4000-8000-000000000001';
const NAME = 'Busyness — last 8 weeks';
let db: InMemorySupabase;

const draw = (): ReactNode => render(h.hooks, createElement(BusynessHeatmap, { familyId: FAMILY }));
/** Mount, let the component's own read answer, and draw what it answered. */
async function screen(): Promise<ReactNode> {
  draw();
  await settle();
  return draw();
}
function heading(tree: ReactNode): Node {
  const buttons = nodes(tree).filter((n) => n.type === 'button');
  expect(buttons).toHaveLength(1);
  return buttons[0];
}
const dayTitles = (tree: ReactNode) => nodes(tree).map((n) => n.props.title).filter((v): v is string => typeof v === 'string');
const alerts = (tree: ReactNode) => nodes(tree).filter((n) => n.props.role === 'alert').map((n) => text(n));

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: { calendar_events: { idempotency_key: null } } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null; h.realtime = {};
  h.timeZone = 'America/New_York';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T16:00:00.000Z'));
  db.seed('calendar_events', [{
    id: EVENT, family_id: FAMILY, title: 'Dentist', description: null, location: null, category: 'general',
    // 11:00 to 12:00 in New York on Thursday 8 October.
    starts_at: '2026-10-08T15:00:00.000Z', ends_at: '2026-10-08T16:00:00.000Z', all_day: false,
    recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
    created_by: null, onboarding_key: null, idempotency_key: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  }]);
});
afterEach(() => { vi.useRealTimers(); });

describe('the busyness strip on the calendar', () => {
  it('CONTROL-F6883D7BB1BB is a button named for the strip, on the calendar page a member opens', async () => {
    const tree = await screen();
    const button = heading(tree);
    // named: real English from the catalogue, and no message key left on screen.
    expect(text(button).trim()).toBe(NAME);
    expect(allByName(tree, NAME, 'button')).toEqual([button]);
    expect(text(tree)).not.toContain('busynessHeatmap.');
    expect(existsSync('app/(app)/dashboard/calendar/page.tsx')).toBe(true);
    // reachable with the family's real data under it: the strip starts open.
    const titles = dayTitles(tree);
    expect(titles).toHaveLength(56);
    expect(titles).toContain('2026-10-08: 1 event · 1h');
  });

  it('CONTROL-F6883D7BB1BB folds the eight weeks away and brings them back', async () => {
    const open = await screen();
    expect(dayTitles(open)).toHaveLength(56);
    expect(has(open, 'calm')).toBe(true);

    await click(heading(open));
    const folded = draw();
    // The heading stays, under the same name; everything beneath it is gone.
    expect(dayTitles(folded)).toEqual([]);
    expect(text(folded).trim()).toBe(NAME);

    await click(heading(folded));
    const reopened = draw();
    expect(dayTitles(reopened)).toHaveLength(56);
    expect(dayTitles(reopened)).toContain('2026-10-08: 1 event · 1h');
    // Folding is not a read: the family's events were fetched once.
    expect(h.refreshes).toEqual(['calendar_events']);
  });

  it('CONTROL-F6883D7BB1BB also folds away a failed read, and shows it again', async () => {
    h.fault = (table) => (table === 'calendar_events' ? { message: 'calendar is unavailable' } : null);
    const failed = await screen();
    expect(alerts(failed)).toEqual(['calendar is unavailable']);
    expect(dayTitles(failed)).toEqual([]);

    await click(heading(failed));
    expect(alerts(draw())).toEqual([]);

    await click(heading(draw()));
    expect(alerts(draw())).toEqual(['calendar is unavailable']);
  });
});
