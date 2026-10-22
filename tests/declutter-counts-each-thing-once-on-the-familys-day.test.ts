import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { declutterSummary, sessionStreak, zoneHealth, type MissionLike, type SessionLike, type ZoneLike } from '@/lib/declutter/missions';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, change, click, deliver, form, has, nodes, render, submit } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// H5 — "Gone this month" counted every completed mission's items twice.
// CompleteForm writes the mission's `items_removed` AND a session carrying the
// same number (`missions_done: 1`); declutterSummary added both.
//
// H6 — the week, month and streak read the UTC date of each timestamp, not the
// family's day. PostgREST returns timestamptz in UTC ('…+00:00'), so a Los
// Angeles family's 18:30 session was filed under tomorrow: it dropped out of
// "This week" and the month until the family's midnight, and a first evening
// session showed "Streak 0 · Log a session to start one".

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

const { DeclutterModule } = await import('@/components/modules/declutter-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetHookSlots(h.hooks);
  // `started_at` defaults to now() in the database (0244); the in-memory one
  // needs the instant spelled out, so it is the fixed "now" of the H5 case.
  db = createInMemorySupabase({ defaults: { ...HOUSEHOLD_DEFAULTS,
    declutter_sessions: { ...HOUSEHOLD_DEFAULTS.declutter_sessions, started_at: '2026-10-10T15:00:00+00:00' } } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = (): ReactNode => render(h.hooks, createElement(DeclutterModule));
/** The text of the summary card under `heading`. */
function card(tree: ReactNode, heading: string): string {
  const box = nodes(tree).find((node) => node.type === 'div' && typeof node.props.className === 'string'
    && node.props.className.includes('rounded-2xl') && nodes(node.props.children as ReactNode).some((child) => child.type === 'div' && (child.props.className === 'flex items-center gap-2 text-sm font-semibold') && JSON.stringify(child.props.children ?? '').includes(heading)));
  if (!box) throw new Error(`no summary card "${heading}"`);
  const flatten = (node: ReactNode): string => Array.isArray(node) ? node.map(flatten).join('')
    : node && typeof node === 'object' && 'props' in node ? flatten((node as { props: { children?: ReactNode } }).props.children)
      : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  return flatten(box);
}

describe('the module, driven: finishing a mission and logging in the evening', () => {
  it('finishing a mission with 7 things out of the house shows 7 gone, not 14 (H5)', async () => {
    h.timeZone = 'UTC';
    vi.setSystemTime(new Date('2026-10-10T15:00:00Z'));
    db.seed('declutter_missions', [{ id: 'mission-1', title: 'Clear the counter', scheduled_for: '2026-10-10' }]);

    await click(byName(screen(), t('declutter.done')));
    change(nodes(form(screen())).find((node) => node.props.name === 'items_removed')!, '7');
    await submit(form(screen()));
    // Both rows are in the publication: the mission UPDATE and the session
    // INSERT arrive as events and the lists re-read.
    deliver(h, 'declutter_missions', 'declutter_sessions');

    expect(db.table('declutter_missions')[0]).toMatchObject({ status: 'done', items_removed: 7 });
    expect(db.table('declutter_sessions')).toEqual([expect.objectContaining({ missions_done: 1, items_removed: 7 })]);
    expect(card(screen(), t('declutter.goneThisMonth'))).toContain('7 items');
  });

  it('a Los Angeles session at 18:15 counts today and starts a streak (H6)', async () => {
    h.timeZone = 'America/Los_Angeles';
    // Saturday 10 October, 18:30 in Los Angeles; already the 11th in UTC.
    vi.setSystemTime(new Date('2026-10-11T01:30:00Z'));
    db.seed('declutter_sessions', [{ id: 'session-1', started_at: '2026-10-11T01:15:00+00:00', minutes: 20, items_removed: 3, missions_done: 0 }]);

    const tree = screen();

    expect(card(tree, t('declutter.streak'))).toContain('A session today keeps it alive');
    expect(card(tree, t('declutter.goneThisMonth'))).toContain('3 items');
    expect(card(tree, t('declutter.goneThisMonth'))).toContain('20');
  });
});

const zone = (p: Partial<ZoneLike>): ZoneLike => ({ id: 'z', name: 'Counter', room: null, kind: 'surface', clutter_score: 3, last_reset_at: null, is_active: true, ...p });
const mission = (p: Partial<MissionLike>): MissionLike => ({ id: 'm', zone_id: null, title: 't', minutes: 15, assignee_id: null, status: 'done', scheduled_for: null, completed_at: null, items_removed: 0, points: 5, ...p });
const session = (p: Partial<SessionLike>): SessionLike => ({ started_at: '2026-10-10T08:00:00+00:00', minutes: 15, items_removed: 0, member_id: null, missions_done: 0, ...p });
const TODAY = new Date(2026, 9, 10); // the family's calendar day, as useFamilyCalendarToday hands it over

describe('declutterSummary counts each thing that left the house once (H5)', () => {
  it('a completed mission and the session CompleteForm writes beside it are one set of items', () => {
    const s = declutterSummary([], [mission({ completed_at: '2026-10-10T08:00:00+00:00', items_removed: 7 })],
      [session({ missions_done: 1, items_removed: 7 })], TODAY, 'UTC');
    expect(s.itemsRemovedMonth).toBe(7);
  });

  it('a session logged by hand still counts its own items', () => {
    const s = declutterSummary([], [mission({ completed_at: '2026-10-10T08:00:00+00:00', items_removed: 7 })],
      [session({ missions_done: 1, items_removed: 7 }), session({ missions_done: 0, items_removed: 4 })], TODAY, 'UTC');
    expect(s.itemsRemovedMonth).toBe(11);
    expect(s.minutesMonth).toBe(30);
  });

  it('a completion whose session insert failed is still counted, through its mission', () => {
    const s = declutterSummary([], [mission({ completed_at: '2026-10-10T08:00:00+00:00', items_removed: 7 })], [], TODAY, 'UTC');
    expect(s.itemsRemovedMonth).toBe(7);
  });
});

describe('the summary counts the family\'s days, not Greenwich\'s (H6)', () => {
  const evening = '2026-10-11T01:30:00+00:00'; // 18:30 on the 10th in Los Angeles

  it('an evening mission is done "this week" on the day it was done', () => {
    expect(declutterSummary([], [mission({ completed_at: evening })], [], TODAY, 'America/Los_Angeles').doneThisWeek).toBe(1);
  });

  it('an evening session is in the month and keeps today\'s streak', () => {
    const s = declutterSummary([], [], [session({ started_at: evening, minutes: 25, items_removed: 2 })], TODAY, 'America/Los_Angeles');
    expect(s.minutesMonth).toBe(25);
    expect(s.itemsRemovedMonth).toBe(2);
    expect(s.streak).toBe(1);
  });

  it('a Tokyo session just after midnight belongs to the new day, not the one before', () => {
    // 01:30 on the 11th in Tokyo is still the 10th in UTC.
    const tokyoToday = new Date(2026, 9, 11);
    expect(sessionStreak([session({ started_at: '2026-10-10T16:30:00+00:00' })], tokyoToday, 'Asia/Tokyo')).toBe(1);
    // …and 21:00 on the 10th in Tokyo is the day before it, so the two are a
    // two-day streak — in UTC they were the same day.
    expect(sessionStreak([
      session({ started_at: '2026-10-10T16:30:00+00:00' }), session({ started_at: '2026-10-10T12:00:00+00:00' }),
    ], tokyoToday, 'Asia/Tokyo')).toBe(2);
  });

  it('a zone reset this evening is fresh today, not "-1 days ago"', () => {
    expect(zoneHealth(zone({ last_reset_at: evening }), TODAY, 'America/Los_Angeles')).toMatchObject({ health: 'fresh', daysSinceReset: 0 });
  });

  it('a DATE column and a zone-less wall-clock string are taken as written', () => {
    expect(sessionStreak([session({ started_at: '2026-10-10T23:30:00' })], TODAY, 'Asia/Tokyo')).toBe(1);
  });
});
