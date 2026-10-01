// Which birthdays the moments surfaces show is decided on the FAMILY's calendar
// day (#688 review 5375096174; LIBRARY-D6F6C664EB62, COMPONENT-B54544DE1597,
// COMPONENT-0071B394A652). Both consumers used to hand upcomingBirthdayEvents
// the device's `new Date()`, which it reads by LOCAL parts: a UTC phone at
// 2026-07-05T02:00Z is already on 5 July while its Los Angeles family is still
// on 4 July, so today's 4 July birthday was "next year" (364 days) and both the
// 2-day Home banner and the 30-day Moments list left it out.
//
// They now pass useFamilyCalendarToday() — the family's day key as the
// local-calendar Date the date-only helper reads, memoized on that key — so the
// selection follows the family and moves at the family's midnight even on a
// screen that stays open. The helper itself, and its no-zone callers
// (lib/moments/notify.ts), are unchanged.
//
// The consumers are run as functions under a hook-slot harness whose useMemo
// honours its dependency list, so a memo that does not depend on the family's
// day keeps its stale answer across a rerender here exactly as it would in React.
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { calendarDayOfKey } from '@/components/i18n/use-format';
import { at } from './helpers/source-order';
import { nextBirthdayDayKey, upcomingBirthdayEvents, type BirthdayMember } from '@/lib/moments/birthdays';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const say = (key: string, vars?: Record<string, unknown>) =>
  (MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  zone: undefined as string | undefined,
  members: [] as unknown[],
  rows: [] as unknown[],
}));

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (fn: () => unknown, deps?: unknown[]) => {
    const index = state.cursor++;
    const held = state.slots[index] as { deps?: unknown[]; value: unknown } | undefined;
    if (held && deps && same(held.deps, deps)) return held.value;
    const value = fn();
    state.slots[index] = { deps, value };
    return value;
  };
  return {
    ...react,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [state.slots[index], () => {}];
    },
    useMemo: memo,
    useCallback: (fn: unknown, deps?: unknown[]) => memo(() => fn, deps),
    useEffect: () => {},
  };
});

vi.mock('@/app/(app)/dashboard/moment-actions', () => ({
  setMomentPrepDoneAction: vi.fn(), addMomentGroceryAction: vi.fn(),
  removeMomentGroceryAction: vi.fn(), createMomentReminderAction: vi.fn(),
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'fam-1', members: state.members }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({ data: state.rows, loading: false, error: null, refresh: async () => {} }),
}));
vi.mock('@/components/moments/use-default-forecast', () => ({ useDefaultForecast: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => say,
  useLocale: () => ({ code: 'en-US' }),
  useFamilyTimeZone: () => state.zone,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/ui/states', () => ({ SkeletonList: () => null, EmptyState: () => null, ErrorState: () => null }));

const { HomeMomentCard } = await import('@/components/moments/home-moment-card');
const { MomentsView } = await import('@/components/moments/moments-view');

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
/** Every title a surface renders as an h2/p heading line. */
function shown(tree: ReactNode): string {
  return nodes(tree).map((n) => text(n)).join(' | ');
}

const HOST_ZONE = process.env.TZ;
const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

/** One render of a consumer, on a `device`-zone phone, for a `family`-zone family, at `now`. Slots persist between calls. */
function renderAt(surface: 'home' | 'moments', device: string, family: string, now: string): string {
  process.env.TZ = device;
  state.zone = family;
  vi.setSystemTime(new Date(now));
  state.cursor = 0;
  return shown(surface === 'home' ? HomeMomentCard() : MomentsView({}));
}

const member = (id: string, name: string, birthday: string | null, isActive = true) =>
  ({ id, display_name: name, birthday, is_active: isActive, role: 'child' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  state.slots = []; state.cursor = 0; state.rows = []; state.members = [];
});
afterEach(() => { process.env.TZ = HOST_ZONE; vi.useRealTimers(); });

describe("today's family birthday is on both surfaces, whatever the phone's zone", () => {
  // The review's reproduction: 02:00Z on 5 July is 4 July 19:00 in Los Angeles.
  const NOW = '2026-07-05T02:00:00Z';
  beforeEach(() => { state.members = [member('m-mia', 'Mia Rivera', '2018-07-04')]; });

  it('the helper the consumers now share answers 4 July, and the old device read answered next year', () => {
    process.env.TZ = 'UTC';
    expect(nextBirthdayDayKey('2018-07-04', '2026-07-04')).toBe('2026-07-04');
    const family = upcomingBirthdayEvents(state.members as BirthdayMember[], calendarDayOfKey('2026-07-04'), 2);
    expect(family.map((e) => e.starts_at)).toEqual(['2026-07-04T00:00:00']);
    vi.setSystemTime(new Date(NOW));
    expect(upcomingBirthdayEvents(state.members as BirthdayMember[], new Date(), 30)).toEqual([]); // the defect: 364 days away
  });

  it.each(['home', 'moments'] as const)('%s: a UTC phone in a Los Angeles family shows "Mia turns 8"', (surface) => {
    expect(renderAt(surface, 'UTC', LA, NOW)).toContain('Mia turns 8');
  });

  it.each([
    // [device, family, now, birthday, shown on Home?] — inclusive 0/1-day horizon on Home
    ['UTC', LA, NOW, '2018-07-04', true],
    [TOKYO, LA, NOW, '2018-07-04', true],
    ['UTC', TOKYO, '2026-07-04T16:00:00Z', '2018-07-05', true], // 5 July 01:00 in Tokyo, still 4 July on the phone
    [LA, TOKYO, '2026-07-04T16:00:00Z', '2018-07-05', true],
    [TOKYO, LA, NOW, '2018-07-03', false], // yesterday in the family, whatever the phone says
    [LA, LA, NOW, '2018-07-04', true], // same-zone control
    ['UTC', 'UTC', '2026-07-04T12:00:00Z', '2018-07-04', true], // same-zone control
  ])('home: a %s phone, a %s family, at %s: the %s birthday shown = %s', (device, family, now, birthday, expected) => {
    state.members = [member('m-mia', 'Mia Rivera', birthday)];
    expect(renderAt('home', device, family, now).includes('Mia turns 8')).toBe(expected);
  });
});

describe('the 30-day Moments list is counted in the family\'s days, inclusively', () => {
  it.each([
    // family day 4 July (LA) on a UTC phone already on 5 July
    ['2018-08-03', true], // day 30: inside, inclusive
    ['2018-08-04', false], // day 31: outside
    ['2018-07-04', true], // day 0
  ])('the %s birthday is listed = %s', (birthday, expected) => {
    state.members = [member('m-mia', 'Mia Rivera', birthday)];
    expect(renderAt('moments', 'UTC', LA, '2026-07-05T02:00:00Z').includes('Mia turns 8')).toBe(expected);
  });

  it('a screen left open across the FAMILY\'s midnight moves to the new day on its next render', () => {
    state.members = [member('m-mia', 'Mia Rivera', '2018-08-03')];
    // 3 July 23:50 in Los Angeles (already 4 July on the UTC phone): 3 August is day 31.
    expect(renderAt('moments', 'UTC', LA, '2026-07-04T06:50:00Z')).not.toContain('Mia turns 8');
    // 4 July 00:10 in Los Angeles: day 30. Same component, same slots, rerendered.
    expect(renderAt('moments', 'UTC', LA, '2026-07-04T07:10:00Z')).toContain('Mia turns 8');
  });

  it('home, the same: its 2-day window moves at the family\'s midnight', () => {
    state.members = [member('m-mia', 'Mia Rivera', '2018-07-07')];
    // 4 July 23:50 in Los Angeles (5 July on the Tokyo phone): 7 July is day 3 for the family.
    expect(renderAt('home', TOKYO, LA, '2026-07-05T06:50:00Z')).not.toContain('Mia turns 8');
    // 5 July 00:10 in Los Angeles: day 2, inside Home's window. Same component, rerendered.
    expect(renderAt('home', TOKYO, LA, '2026-07-05T07:10:00Z')).toContain('Mia turns 8');
  });
});

describe('the birthday rules themselves are unchanged, on the family\'s day', () => {
  const pick = (members: unknown[], todayKey: string, within: number) =>
    upcomingBirthdayEvents(members as BirthdayMember[], calendarDayOfKey(todayKey), within);

  it.each(['UTC', LA, TOKYO, 'America/Santiago'])('on a %s phone', (device) => {
    process.env.TZ = device;
    // year boundary: 31 Dec family day, a 1 Jan birthday is tomorrow, next year's age
    expect(pick([member('a', 'Ava Lee', '2019-01-01')], '2026-12-31', 1).map((e) => [e.title, e.starts_at]))
      .toEqual([['Ava turns 8', '2027-01-01T00:00:00']]);
    // leap day: 29 Feb in a common year falls on 1 Mar (unchanged normalisation); in a leap year, on 29 Feb
    expect(pick([member('l', 'Leo Park', '2016-02-29')], '2027-02-28', 1).map((e) => e.starts_at)).toEqual(['2027-03-01T00:00:00']);
    expect(pick([member('l', 'Leo Park', '2016-02-29')], '2028-02-29', 0).map((e) => [e.title, e.starts_at]))
      .toEqual([['Leo turns 12', '2028-02-29T00:00:00']]);
    // horizons inclusive at 0, 1 and 2
    const kids = [member('t0', 'Zed', '2015-07-04'), member('t1', 'Yan', '2015-07-05'), member('t2', 'Xia', '2015-07-06')];
    expect(pick(kids, '2026-07-04', 0).map((e) => e.id)).toEqual(['birthday:t0']);
    expect(pick(kids, '2026-07-04', 1).map((e) => e.id)).toEqual(['birthday:t0', 'birthday:t1']);
    expect(pick(kids, '2026-07-04', 2).map((e) => e.id)).toEqual(['birthday:t0', 'birthday:t1', 'birthday:t2']);
    // sorted soonest first regardless of input order; age from the birth year; no year -> no age
    expect(pick([member('b', 'Bo Kim', '2020-07-20'), member('c', 'Cy', '1900-07-10'), member('d', 'Di', '2010-07-04')], '2026-07-04', 30)
      .map((e) => e.title)).toEqual(['Di turns 16', "Cy's birthday", 'Bo turns 6']);
    // inactive, missing and unreadable birthdays are left out
    expect(pick([member('i', 'Ina', '2015-07-04', false), member('n', 'Nia', null), member('u', 'Uma', 'not-a-date')], '2026-07-04', 30)).toEqual([]);
  });
});

describe('timed events are untouched', () => {
  it('a timed event still lists, ordered by its instant, beside today\'s family birthday', () => {
    state.members = [member('m-mia', 'Mia Rivera', '2018-07-04')];
    state.rows = [{
      id: 'evt-1', family_id: 'fam-1', title: 'Soccer game', category: 'sports', location: 'Riverside Park',
      starts_at: '2026-07-05T17:00:00Z', ends_at: null, all_day: false, description: null,
    }];
    const out = renderAt('moments', 'UTC', LA, '2026-07-05T02:00:00Z');
    expect(out).toContain('Soccer game');
    expect(at(out, 'Mia turns 8')).toBeLessThan(at(out, 'Soccer game'));
  });
});
