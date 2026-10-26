import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { has, nodes, render, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The Vacation Planner's "Next trip" was a trip that had ended.
//
// Nothing in the app moves `vacations.status` past 'planning' (no editor, RPC
// or cron completes a trip), and the list retired a trip by status alone. A
// finished trip therefore stayed "upcoming": sorted by days until it starts,
// last July's trip came FIRST, and the hero card at the top of the page read
// "Next trip · Lake week · 113 days ago" while December's trip sat further
// down. A trip whose last day is before the family's today is over, whatever
// its status: it is never the hero, and it is listed after the live ones.
//
// The REAL VacationsList, driven through tests/helpers/module-harness.tsx
// against an in-memory database.

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
vi.mock('@/components/ui/states', async () => ({ ...(await import('./helpers/module-harness')).ui, LoadingBlock: () => null }));
vi.mock('@/components/ui/button-link', async () => ({ ButtonLink: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const { VacationsList } = await import('@/components/vacations/vacations-list');

const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Sunday 25 October 2026, 11:00 in New York.
  vi.setSystemTime(new Date('2026-10-25T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'America/New_York';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const trip = (id: string, title: string, start: string | null, end: string | null, status = 'planning') => ({
  id, family_id: FAMILY, title, kind: 'domestic', destination: null, status,
  start_date: start, end_date: end, is_international: false, timezone: 'America/New_York',
});

const screen = (): ReactNode => render(h.hooks, createElement(VacationsList));
const links = (tree: ReactNode) => nodes(tree).filter((n): n is Node => n.type === 'a' && typeof n.props.href === 'string' && /\/dashboard\/vacations\/[^/]+\/overview$/.test(n.props.href as string));
/** The hero card: the one link that says "Next trip" or "Current trip". */
const hero = (tree: ReactNode) => links(tree).find((n) => /Next trip|Current trip/.test(text(n)));

describe('the Vacation Planner\'s next trip', () => {
  it('is the coming trip, not one that ended in July', () => {
    db.seed('vacations', [trip('lake', 'Lake week', '2026-07-04', '2026-07-11'), trip('disney', 'Disney', '2026-12-19', '2026-12-26')]);
    const card = hero(screen());
    expect(card?.props.href).toBe('/dashboard/vacations/disney/overview');
    expect(has(card!, 'Next trip')).toBe(true);
    expect(has(card!, 'Lake week')).toBe(false);
  });

  it('is the trip under way while one is', () => {
    db.seed('vacations', [trip('lake', 'Lake week', '2026-07-04', '2026-07-11'), trip('fall', 'Fall break', '2026-10-23', '2026-10-27'), trip('disney', 'Disney', '2026-12-19', '2026-12-26')]);
    const card = hero(screen());
    expect(card?.props.href).toBe('/dashboard/vacations/fall/overview');
    expect(has(card!, 'Current trip')).toBe(true);
  });

  it('is still the trip on its last day', () => {
    db.seed('vacations', [trip('lake', 'Lake week', '2026-07-04', '2026-07-11'), trip('home', 'Coming home today', '2026-10-20', '2026-10-25'), trip('disney', 'Disney', '2026-12-19', '2026-12-26')]);
    const card = hero(screen());
    expect(card?.props.href).toBe('/dashboard/vacations/home/overview');
    expect(has(card!, 'Current trip')).toBe(true);
  });

  it('is not shown at all when every trip on file has ended', () => {
    db.seed('vacations', [trip('lake', 'Lake week', '2026-07-04', '2026-07-11'), trip('fair', 'County fair', '2026-09-01', null)]);
    expect(hero(screen())).toBeUndefined();
  });

  it('lists the live trips before the finished ones', () => {
    db.seed('vacations', [
      trip('spring', 'Spring break', '2026-03-28', '2026-04-04'),
      trip('lake', 'Lake week', '2026-07-04', '2026-07-11'),
      trip('disney', 'Disney', '2026-12-19', '2026-12-26'),
      trip('someday', 'Someday Japan', null, null),
    ]);
    const tree = screen();
    const top = hero(tree);
    const order = links(tree).filter((n) => n !== top).map((n) => String(n.props.href).split('/')[3]);
    expect(order.indexOf('disney')).toBeLessThan(order.indexOf('lake'));
    expect(order.indexOf('someday')).toBeLessThan(order.indexOf('spring'));
    expect(order).toHaveLength(4);
  });
});
