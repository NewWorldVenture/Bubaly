import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault } from '@/lib/i18n/locales';
import type { ConflictView } from '@/components/family/conflict-resolver';

// /dashboard/conflicts, the REAL server page and its REAL quick-fix action,
// against an in-memory database.
//
//   N3   it read raw calendar rows by `starts_at`. A recurring event is ONE row
//        whose `starts_at` is its first occurrence, so a weekly practice made
//        last month had no row in the fortnight and a dentist appointment booked
//        over it was never a clash; and the read stopped at 500 events without
//        saying so, under "No schedule conflicts … Nicely run."
//   N11  the one-tap fix rewrote the stored row: for a series that moved every
//        future week, and a fix computed at render silently undid a reschedule
//        another member made after it.

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa01';
const LA = 'America/Los_Angeles';
/** Tuesday 13 October 2026, 08:00 in Los Angeles. */
const NOW = new Date('2026-10-13T15:00:00.000Z');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  const { localeOrDefault: locale } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages('en-US'), key, params),
    getLocaleContext: async () => ({ locale: locale('en-US'), source: 'cookie', messages: messages('en-US') }),
  };
});
vi.mock('@/lib/supabase/auth', () => {
  const ctx = {
    user: { id: '00000000-0000-4000-8000-00000000aa01' },
    active: {
      familyId: '00000000-0000-4000-8000-00000000fa01', role: 'parent',
      member: { id: '00000000-0000-4000-8000-00000000ad01' },
      family: { name: 'Fixture', timezone: 'America/Los_Angeles' },
    },
  };
  return { requireFeature: async () => ctx, requireUserContext: async () => ctx };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));

const { default: ConflictsPage } = await import('@/app/(app)/dashboard/conflicts/page');
const { ConflictResolver } = await import('@/components/family/conflict-resolver');
const { rescheduleEventAction } = await import('@/app/(app)/dashboard/conflicts/actions');

const t = (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params);
let db: InMemorySupabase;

const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'general', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
  created_by: PARENT_USER, idempotency_key: null, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  ends_at: null, ...row,
});
const rowOf = (id: string) => db.table('calendar_events').find((r) => r.id === id)!;

/** Every element in a server page's tree, without rendering its client components. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
async function page() {
  const tree = await ConflictsPage();
  const resolver = elements(tree).find((el) => el.type === ConflictResolver);
  expect(resolver, 'the page rendered its resolver').toBeDefined();
  const html = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US'), children: tree,
  } as never));
  return { conflicts: resolver!.props.conflicts as ConflictView[], partial: resolver!.props.partial as boolean | undefined, html };
}
const titles = (c: ConflictView) => [c.a.title, c.b.title].sort().join(' + ');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase();
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('N3: every occurrence in the fortnight is checked', () => {
  it('finds a one-off booked over a weekly practice created last month', async () => {
    db.seed('calendar_events', [
      // Wednesdays 17:00–18:30 PDT since 16 September.
      event({ id: 'practice', title: 'Soccer practice', starts_at: '2026-09-17T00:00:00.000Z', ends_at: '2026-09-17T01:30:00.000Z', recurrence: 'weekly' }),
      // Wednesday 14 October 16:30–17:30 PDT.
      event({ id: 'dentist', title: 'Dentist', starts_at: '2026-10-14T23:30:00.000Z', ends_at: '2026-10-15T00:30:00.000Z' }),
    ]);
    const { conflicts, html } = await page();
    expect(conflicts.map(titles)).toEqual(['Dentist + Soccer practice']);
    expect(html).not.toContain(t('conflictResolver.noScheduleConflicts'));
  });

  it('finds a clash with an event already under way', async () => {
    db.seed('calendar_events', [
      // Started an hour ago and runs all morning.
      event({ id: 'shift', title: 'Hospital shift', starts_at: '2026-10-13T14:00:00.000Z', ends_at: '2026-10-13T20:00:00.000Z' }),
      event({ id: 'call', title: 'School call', starts_at: '2026-10-13T16:00:00.000Z', ends_at: '2026-10-13T16:30:00.000Z' }),
    ]);
    expect((await page()).conflicts.map(titles)).toEqual(['Hospital shift + School call']);
  });

  it('says so when the fortnight is too full to check whole, instead of the all-clear', async () => {
    // 501 back-to-back ten-minute events that do not overlap, then a clash on
    // day 13 that a read stopped at 500 never reached.
    const start = Date.parse('2026-10-13T16:00:00.000Z');
    db.seed('calendar_events', Array.from({ length: 501 }, (_, i) => event({
      id: `e-${String(i).padStart(4, '0')}`, title: `Slot ${i}`,
      starts_at: new Date(start + i * 30 * 60_000).toISOString(), ends_at: new Date(start + i * 30 * 60_000 + 10 * 60_000).toISOString(),
    })));
    db.seed('calendar_events', [
      event({ id: 'late-a', title: 'Late A', starts_at: '2026-10-26T18:00:00.000Z', ends_at: '2026-10-26T19:00:00.000Z' }),
      event({ id: 'late-b', title: 'Late B', starts_at: '2026-10-26T18:30:00.000Z', ends_at: '2026-10-26T19:30:00.000Z' }),
    ]);
    const { conflicts, partial, html } = await page();
    expect(conflicts).toEqual([]);
    expect(partial).toBe(true);
    expect(html).toContain(t('dashboardConflicts.onlyTheFirstEventsWereChecked', { count: 500 }));
    expect(html).toContain(t('conflictResolver.noConflictsAmongTheEventsChecked'));
    expect(html).not.toContain(t('conflictResolver.noScheduleConflicts'));
    expect(html).not.toContain(t('conflictResolver.nothingOnTheCalendarOverlaps'));
  });

  it('still gives the all-clear when the whole fortnight was checked', async () => {
    db.seed('calendar_events', [event({ id: 'one', title: 'Only thing', starts_at: '2026-10-14T18:00:00.000Z', ends_at: '2026-10-14T19:00:00.000Z' })]);
    const { conflicts, partial, html } = await page();
    expect(conflicts).toEqual([]);
    expect(partial).toBe(false);
    expect(html).toContain(t('conflictResolver.noScheduleConflicts'));
  });
});

describe('N11: the one-tap fix moves only what it says, as it was when shown', () => {
  it('offers no one-tap move for an occurrence of a series, and the action refuses to move the series', async () => {
    db.seed('calendar_events', [
      // A weekly swim session whose FIRST start is this Thursday, 17:00 PDT.
      event({ id: 'swim', title: 'Swim', starts_at: '2026-10-16T00:00:00.000Z', ends_at: '2026-10-16T01:00:00.000Z', recurrence: 'weekly' }),
      // Thursday 16:30–17:30 PDT.
      event({ id: 'tutor', title: 'Tutor', starts_at: '2026-10-15T23:30:00.000Z', ends_at: '2026-10-16T00:30:00.000Z' }),
    ]);
    const { conflicts } = await page();
    const clash = conflicts.find((c) => titles(c) === 'Swim + Tutor');
    expect(clash, 'the clash is shown').toBeDefined();
    expect(clash!.b.title).toBe('Swim');
    expect(clash!.quickFix, 'a one-tap move of "this" swim would move every week').toBeNull();

    // A direct call with the series' id is refused too, and every week stays put.
    const result = await rescheduleEventAction('swim', '2026-10-16T00:30:00.000Z', '2026-10-16T01:30:00.000Z');
    expect(result).toEqual({ ok: false, error: t('actions.thatEventRepeatsMoveItOnThe') });
    expect(rowOf('swim').starts_at).toBe('2026-10-16T00:00:00.000Z');
  });

  it('two weeks of the same pair of series are two cards, not one', async () => {
    db.seed('calendar_events', [
      event({ id: 'piano', title: 'Piano', starts_at: '2026-10-14T01:00:00.000Z', ends_at: '2026-10-14T02:00:00.000Z', recurrence: 'weekly' }),
      event({ id: 'chess', title: 'Chess', starts_at: '2026-10-14T01:30:00.000Z', ends_at: '2026-10-14T02:30:00.000Z', recurrence: 'weekly' }),
    ]);
    const { conflicts } = await page();
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(conflicts.map((c) => c.key)).size).toBe(conflicts.length);
  });

  it('refuses a fix computed before another member moved the event, and keeps their change', async () => {
    db.seed('calendar_events', [
      event({ id: 'lesson', title: 'Piano lesson', starts_at: '2026-10-20T01:00:00.000Z', ends_at: '2026-10-20T02:00:00.000Z' }),
      event({ id: 'game', title: 'Soccer game', starts_at: '2026-10-20T01:30:00.000Z', ends_at: '2026-10-20T02:30:00.000Z' }),
    ]);
    const { conflicts } = await page();
    const fix = conflicts.find((c) => titles(c) === 'Piano lesson + Soccer game')!.quickFix!;
    expect(fix.eventId).toBe('game');

    // Another parent moves the game to Wednesday from the calendar.
    Object.assign(rowOf('game'), { starts_at: '2026-10-21T03:00:00.000Z', ends_at: '2026-10-21T04:00:00.000Z' });

    const result = await rescheduleEventAction(fix.eventId, fix.startsAtIso, fix.endsAtIso, fix.rendered);
    expect(result).toEqual({ ok: false, error: t('actions.thatEventChangedSinceThisPage') });
    expect(rowOf('game').starts_at).toBe('2026-10-21T03:00:00.000Z');
  });

  it('still applies a fix to an event that has not changed', async () => {
    db.seed('calendar_events', [
      event({ id: 'lesson', title: 'Piano lesson', starts_at: '2026-10-20T01:00:00.000Z', ends_at: '2026-10-20T02:00:00.000Z' }),
      event({ id: 'game', title: 'Soccer game', starts_at: '2026-10-20T01:30:00.000Z', ends_at: '2026-10-20T02:30:00.000Z' }),
    ]);
    const fix = (await page()).conflicts[0].quickFix!;
    expect(await rescheduleEventAction(fix.eventId, fix.startsAtIso, fix.endsAtIso, fix.rendered)).toEqual({ ok: true });
    expect(rowOf('game').starts_at).toBe('2026-10-20T02:00:00.000Z');
    expect((await page()).conflicts).toEqual([]);
  });
});
