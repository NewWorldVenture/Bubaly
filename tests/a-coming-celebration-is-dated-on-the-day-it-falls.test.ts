// A coming birthday or anniversary is dated on the day it next falls on, the
// day its countdown counts to.
//
// 1. The grandparent portal's "Coming up" list printed the STORED date
//    (`fmtDate(c.date)`, 'EEE, MMM d'), which is the year it began: a
//    grandchild born on Sunday 20 November 2016 read "Sun, Nov 20" in 2026,
//    when the 20th is a Friday, and a 1975 anniversary read Saturday for a
//    Sunday. A 29 February birthday read "Feb 29" in a common year, while its
//    countdown (`daysUntilNextOn`) counts to 1 March.
//
// 2. The Celebrations page (`upcomingCelebrations`) dated a 29 February
//    birthday in a common year "2027-02-29", which is not a date. Its label
//    fell back to a parse at Greenwich, so west of Greenwich it read "Sunday,
//    February 28", a day before the 1 March its countdown counts to (and
//    "Tomorrow" on the 28th itself).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daysUntilNextOn, nextOccurrenceOn, upcomingCelebrations } from '@/lib/celebrations/dates';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', async () => {
  // The page is called directly, outside a request, so cookies() is not
  // there; the real catalogue keeps the words checked.
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

import GrandparentPortalPage from '@/app/(app)/dashboard/grandparent-portal/page';

type Rows = Record<string, unknown>[];
const FAMILY = 'fam-rivera';
let members: Rows;
let dates: Rows;

function fakeClient() {
  return {
    from(table: string) {
      const query: Record<string, unknown> = {};
      Object.assign(query, {
        select: () => query, eq: () => query, order: () => query, limit: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({
          data: table === 'family_members' ? members : table === 'family_dates' ? dates : [],
          error: null,
        }).then(resolve),
      });
      return query;
    },
  };
}

function context() {
  const family = { id: FAMILY, name: 'Rivera', timezone: 'America/Los_Angeles' };
  return {
    user: { id: 'user-gran', email: 'gran@example.test' },
    memberships: [{ familyId: FAMILY, family, role: 'guest', member: { id: 'self' } }],
    active: { familyId: FAMILY, family, role: 'guest', member: { id: 'self' } },
  };
}

const render = async () => renderToStaticMarkup(await GrandparentPortalPage());
const member = (id: string, name: string, birthday: string) => ({ id, display_name: name, birthday, color: null, role: 'child', is_active: true });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  members = [];
  dates = [];
  mocks.createServer.mockResolvedValue(fakeClient());
  mocks.requireUserContext.mockResolvedValue(context());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the grandparent portal dates a coming celebration on the day it falls', () => {
  it('prints this year\'s weekday, not the weekday of the year it began', async () => {
    // Tuesday 3 November 2026, 7am in Los Angeles.
    vi.setSystemTime(new Date('2026-11-03T15:00:00Z'));
    members = [member('m1', 'Ada Rivera', '2016-11-20')];
    dates = [{ title: 'Gran and Pop\'s anniversary', event_date: '1975-12-06', kind: 'anniversary' }];
    const html = await render();

    expect(html).toContain('Ada Rivera&#x27;s birthday');
    expect(html).toContain('Fri, Nov 20'); // 20 November 2026
    expect(html).not.toContain('Sun, Nov 20'); // 20 November 2016
    expect(html).toContain('Gran and Pop&#x27;s anniversary');
    expect(html).toContain('Sun, Dec 6'); // 6 December 2026
    expect(html).not.toContain('Sat, Dec 6'); // 6 December 1975
  });

  it('dates a 29 February birthday in a common year on 1 March, the day it counts to', async () => {
    // Saturday 20 February 2027: nine days to 1 March.
    vi.setSystemTime(new Date('2027-02-20T20:00:00Z'));
    members = [member('m2', 'Leo Rivera', '2016-02-29')];
    const html = await render();

    expect(html).toContain('Leo Rivera&#x27;s birthday');
    expect(html).toContain('in 9 days');
    expect(html).toContain('Mon, Mar 1');
    expect(html).not.toContain('Feb 29');
  });

  it('a celebration in January is dated in the coming year', async () => {
    // Monday 28 December 2026.
    vi.setSystemTime(new Date('2026-12-28T20:00:00Z'));
    members = [member('m3', 'Mia Rivera', '2019-01-02')];
    const html = await render();

    expect(html).toContain('Mia Rivera&#x27;s birthday');
    expect(html).toContain('in 5 days');
    expect(html).toContain('Sat, Jan 2'); // 2 January 2027; 2 January 2019 was a Wednesday
    expect(html).not.toContain('Wed, Jan 2');
  });
});

describe('the Celebrations page dates a coming celebration on the day it counts to', () => {
  const dayAfter = (from: Date, days: number) => {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('a 29 February birthday in a common year is dated 1 March, a real date', () => {
    const from = new Date(2027, 1, 20); // 20 February 2027, the family's day
    const [leo] = upcomingCelebrations([{ id: 'leo', kind: 'birthday', title: 'Leo', date: '2016-02-29' }], 120, from);

    expect(leo.daysUntil).toBe(9);
    expect(leo.nextDate).toBe('2027-03-01');
    expect(leo.nextDate).toBe(dayAfter(from, leo.daysUntil));
    expect(leo.turning).toBe(11);
  });

  it('every date is the day its countdown names, across the turn of the year', () => {
    const from = new Date(2026, 11, 28); // 28 December 2026
    const out = upcomingCelebrations([
      { id: 'a', kind: 'birthday', title: 'A', date: '2019-01-02' },
      { id: 'b', kind: 'anniversary', title: 'B', date: '1975-12-28' },
      { id: 'c', kind: 'birthday', title: 'C', date: '2012-02-29' },
      { id: 'd', kind: 'other', title: 'D', date: '03-15' },
    ], 120, from);

    expect(out.map((c) => [c.id, c.nextDate])).toEqual([
      ['b', '2026-12-28'], ['a', '2027-01-02'], ['c', '2027-03-01'], ['d', '2027-03-15'],
    ]);
    for (const c of out) expect(c.nextDate, c.id).toBe(dayAfter(from, c.daysUntil));
  });

  it('in a leap year a 29 February birthday is on the 29th', () => {
    const from = new Date(2028, 1, 20);
    const [leo] = upcomingCelebrations([{ id: 'leo', kind: 'birthday', title: 'Leo', date: '2016-02-29' }], 120, from);
    expect(leo.nextDate).toBe('2028-02-29');
    expect(leo.daysUntil).toBe(9);
  });
});

describe('nextOccurrenceOn is the day daysUntilNextOn counts to', () => {
  const keyOf = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const msOf = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));

  it('agrees with the countdown on every day from 2026 to the end of 2028', () => {
    const dates = ['2016-02-29', '1975-12-06', '2019-01-02', '2010-11-14', '03-15', '12-31', '01-01'];
    for (let ms = Date.UTC(2026, 0, 1); ms <= Date.UTC(2028, 11, 31); ms += 86_400_000) {
      const today = keyOf(ms);
      for (const date of dates) {
        const days = daysUntilNextOn(date, today);
        expect(days, `${date} from ${today}`).not.toBeNull();
        expect(nextOccurrenceOn(date, today), `${date} from ${today}`).toBe(keyOf(msOf(today) + days! * 86_400_000));
      }
    }
  });

  it('is today on the day, rolls into the next year, normalises 29 February, and rejects junk', () => {
    expect(nextOccurrenceOn('2016-11-20', '2026-11-20')).toBe('2026-11-20');
    expect(nextOccurrenceOn('2016-11-20', '2026-11-21')).toBe('2027-11-20');
    expect(nextOccurrenceOn('2016-02-29', '2027-02-20')).toBe('2027-03-01');
    expect(nextOccurrenceOn('2016-02-29', '2028-02-20')).toBe('2028-02-29');
    expect(nextOccurrenceOn('2016-02-29', '2028-03-01')).toBe('2029-03-01');
    expect(nextOccurrenceOn('junk', '2026-11-03')).toBeNull();
    expect(nextOccurrenceOn('2016-11-20', '2026/11/03')).toBeNull();
  });
});
